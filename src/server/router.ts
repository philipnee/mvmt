import { CallToolResult, Connector, ToolDefinition } from '../connectors/types.js';
import { isLikelyWriteTool, isMemPalaceWriteTool } from '../connectors/write-policy.js';
import { PermissionConfig } from '../config/schema.js';
import { PatternRedactorAuditEvent, ToolResultPlugin } from '../plugins/types.js';
import { AuditLogger, summarizeArgs } from '../utils/audit.js';
import { ClientIdentity } from './client-identity.js';

type PermissionAction = PermissionConfig['actions'][number];

export interface RouterConnector {
  connector: Connector;
  sourceId?: string;
}

export interface NamespacedTool {
  namespacedName: string;
  originalName: string;
  connectorId: string;
  sourceId: string;
  requiredAction: PermissionAction;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class ToolRouter {
  private readonly toolMap = new Map<string, {
    connector: Connector;
    originalName: string;
    sourceId: string;
    requiredAction: PermissionAction;
  }>();
  private readonly allTools: NamespacedTool[] = [];
  private readonly connectors: RouterConnector[];

  constructor(
    connectors: Array<Connector | RouterConnector>,
    private readonly audit?: AuditLogger,
    private readonly plugins: ToolResultPlugin[] = [],
  ) {
    this.connectors = connectors.map((entry) => (
      'connector' in entry
        ? entry
        : { connector: entry, sourceId: entry.id }
    ));
  }

  async initialize(): Promise<void> {
    for (const entry of this.connectors) {
      const { connector } = entry;
      const sourceId = entry.sourceId ?? connector.id;
      const tools = await connector.listTools();

      for (const tool of tools) {
        const namespacedName = `${connector.id}__${tool.name}`;
        const requiredAction = inferRequiredAction(tool.name);
        if (this.toolMap.has(namespacedName)) {
          throw new Error(`Duplicate tool name after namespacing: ${namespacedName}`);
        }

        this.toolMap.set(namespacedName, {
          connector,
          originalName: tool.name,
          sourceId,
          requiredAction,
        });

        this.allTools.push({
          namespacedName,
          originalName: tool.name,
          connectorId: connector.id,
          sourceId,
          requiredAction,
          description: `[${connector.displayName}] ${tool.description}`,
          inputSchema: normalizeInputSchema(tool),
        });
      }
    }
  }

  getAllTools(identity?: ClientIdentity): NamespacedTool[] {
    return this.allTools.filter((tool) => isToolAllowed(tool, identity)).map((tool) => ({ ...tool }));
  }

  async callTool(
    namespacedName: string,
    args: Record<string, unknown>,
    identity?: ClientIdentity,
  ): Promise<CallToolResult> {
    const entry = this.toolMap.get(namespacedName);
    if (!entry) {
      throw new Error(`Unknown tool: ${namespacedName}`);
    }

    const start = Date.now();
    let result: CallToolResult;
    const redactions: NonNullable<import('../utils/audit.js').AuditEntry['redactions']> = [];
    let threw = false;
    const deniedReason = toolDeniedReason(entry, identity);
    if (deniedReason) {
      result = {
        content: [{ type: 'text', text: `Error: access denied for tool "${namespacedName}" (${deniedReason}).` }],
        isError: true,
      };
      this.recordAudit(entry, namespacedName, args, start, result, false, redactions, identity, deniedReason);
      return result;
    }

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
      this.recordAudit(entry, namespacedName, args, start, result!, threw, redactions, identity);
    }
  }

  private recordAudit(
    entry: { connector: Connector },
    namespacedName: string,
    args: Record<string, unknown>,
    start: number,
    result: CallToolResult | undefined,
    threw: boolean,
    redactions: NonNullable<import('../utils/audit.js').AuditEntry['redactions']>,
    identity?: ClientIdentity,
    deniedReason?: string,
  ): void {
    if (!this.audit) return;
    const { argKeys, argPreview } = summarizeArgs(args);
    this.audit.record({
      ts: new Date().toISOString(),
      connectorId: entry.connector.id,
      tool: namespacedName,
      ...(identity ? { clientId: identity.id } : {}),
      argKeys,
      argPreview,
      ...(redactions.length > 0 ? { redactions } : {}),
      isError: threw || Boolean(result?.isError),
      ...(deniedReason ? { deniedReason } : {}),
      durationMs: Date.now() - start,
    });
  }
}

function isToolAllowed(tool: NamespacedTool, identity?: ClientIdentity): boolean {
  return !toolDeniedReason(tool, identity);
}

function toolDeniedReason(
  tool: { sourceId: string; requiredAction: PermissionAction },
  identity?: ClientIdentity,
): string | undefined {
  if (!identity || identity.isLegacyDefault) return undefined;
  if (!identity.rawToolsEnabled) return 'raw_tools_disabled';
  const allowedActions = identity.permissions
    .filter((permission) => permission.sourceId === tool.sourceId)
    .flatMap((permission) => permission.actions);
  if (allowedActions.includes(tool.requiredAction)) return undefined;
  return `missing_permission source=${tool.sourceId} action=${tool.requiredAction}`;
}

function inferRequiredAction(toolName: string): PermissionAction {
  const lower = toolName.toLowerCase();
  if (isMemPalaceWriteTool(lower)) return 'memory_write';
  if (isLikelyWriteTool(lower)) return 'write';
  if (lower.includes('search') || lower.startsWith('find_') || lower.startsWith('query_')) return 'search';
  return 'read';
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
