import { CallToolResult, Connector, ToolDefinition } from '../connectors/types.js';
import { PatternRedactorAuditEvent, ToolResultPlugin } from '../plugins/types.js';
import { AuditLogger, summarizeArgs } from '../utils/audit.js';

export interface NamespacedTool {
  namespacedName: string;
  originalName: string;
  connectorId: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class ToolRouter {
  private readonly toolMap = new Map<string, { connector: Connector; originalName: string }>();
  private readonly allTools: NamespacedTool[] = [];

  constructor(
    private readonly connectors: Connector[],
    private readonly audit?: AuditLogger,
    private readonly plugins: ToolResultPlugin[] = [],
  ) {}

  async initialize(): Promise<void> {
    for (const connector of this.connectors) {
      const tools = await connector.listTools();

      for (const tool of tools) {
        const namespacedName = `${connector.id}__${tool.name}`;
        if (this.toolMap.has(namespacedName)) {
          throw new Error(`Duplicate tool name after namespacing: ${namespacedName}`);
        }

        this.toolMap.set(namespacedName, {
          connector,
          originalName: tool.name,
        });

        this.allTools.push({
          namespacedName,
          originalName: tool.name,
          connectorId: connector.id,
          description: `[${connector.displayName}] ${tool.description}`,
          inputSchema: normalizeInputSchema(tool),
        });
      }
    }
  }

  getAllTools(): NamespacedTool[] {
    return [...this.allTools];
  }

  async callTool(namespacedName: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const entry = this.toolMap.get(namespacedName);
    if (!entry) {
      throw new Error(`Unknown tool: ${namespacedName}`);
    }

    const start = Date.now();
    let result: CallToolResult;
    const redactions: NonNullable<import('../utils/audit.js').AuditEntry['redactions']> = [];
    let threw = false;
    try {
      result = await entry.connector.callTool(entry.originalName, args);
      for (const plugin of this.plugins) {
        const output = await plugin.process({
          connectorId: entry.connector.id,
          toolName: namespacedName,
          originalName: entry.originalName,
          args,
          result,
        });
        result = output.result;
        redactions.push(...flattenRedactionEvents(output.auditEvents ?? []));
      }
      return result;
    } catch (err) {
      threw = true;
      throw err;
    } finally {
      if (this.audit) {
        const { argKeys, argPreview } = summarizeArgs(args);
        this.audit.record({
          ts: new Date().toISOString(),
          connectorId: entry.connector.id,
          tool: namespacedName,
          argKeys,
          argPreview,
          ...(redactions.length > 0 ? { redactions } : {}),
          isError: threw || Boolean(result! && (result as CallToolResult).isError),
          durationMs: Date.now() - start,
        });
      }
    }
  }
}

function flattenRedactionEvents(
  events: PatternRedactorAuditEvent[],
): NonNullable<import('../utils/audit.js').AuditEntry['redactions']> {
  return events.flatMap((event) =>
    event.matches.map((match) => ({
      pluginId: event.pluginId,
      mode: event.mode,
      pattern: match.pattern,
      count: match.count,
      ...(event.truncated ? { truncated: true } : {}),
    })),
  );
}

function normalizeInputSchema(tool: ToolDefinition): Record<string, unknown> {
  if (isObjectSchema(tool.inputSchema)) return tool.inputSchema;
  return { type: 'object', properties: {} };
}

function isObjectSchema(schema: unknown): schema is Record<string, unknown> {
  return Boolean(
    schema &&
      typeof schema === 'object' &&
      !Array.isArray(schema) &&
      (schema as Record<string, unknown>).type === 'object',
  );
}
