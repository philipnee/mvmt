import { CallToolResult } from '../connectors/types.js';
import { PermissionConfig } from '../config/schema.js';
import { normalizePathSeparators, stripTrailingSlashes } from '../context/mount-registry.js';
import { TextContextIndex } from '../context/text-index.js';
import { PatternRedactorAuditEvent, ToolResultPlugin } from '../plugins/types.js';
import { AuditLogger, summarizeArgs } from '../utils/audit.js';
import { ClientIdentity } from './client-identity.js';

type PermissionAction = PermissionConfig['actions'][number];
type ContextToolName = 'search' | 'list' | 'read' | 'write' | 'remove';

export interface ToolRouterOptions {
  contextIndex?: TextContextIndex;
}

export interface NamespacedTool {
  namespacedName: string;
  originalName: string;
  connectorId: string;
  sourceId: string;
  requiredAction: PermissionAction;
  toolKind: 'semantic';
  description: string;
  inputSchema: Record<string, unknown>;
}

export class ToolRouter {
  private readonly contextToolDefinitions: NamespacedTool[] = [];
  private readonly contextIndex?: TextContextIndex;
  private initialized = false;

  constructor(
    private readonly audit?: AuditLogger,
    private readonly plugins: ToolResultPlugin[] = [],
    options: ToolRouterOptions = {},
  ) {
    this.contextIndex = options.contextIndex;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (this.contextIndex) {
      this.contextToolDefinitions.push(...buildContextToolDefinitions());
    }
  }

  getAllTools(identity?: ClientIdentity): NamespacedTool[] {
    return this.contextToolDefinitions
      .filter((tool) => this.isContextToolVisible(tool.namespacedName, identity))
      .map((tool) => ({ ...tool }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    identity?: ClientIdentity,
  ): Promise<CallToolResult> {
    if (!isContextToolName(name)) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return this.callContextTool(name, args, identity);
  }

  private async callContextTool(
    name: ContextToolName,
    args: Record<string, unknown>,
    identity?: ClientIdentity,
  ): Promise<CallToolResult> {
    const start = Date.now();
    const redactions: NonNullable<import('../utils/audit.js').AuditEntry['redactions']> = [];
    let result: CallToolResult | undefined;
    let threw = false;
    let deniedReason: string | undefined;

    try {
      if (!this.contextIndex) {
        deniedReason = 'text_index_disabled';
        result = accessDeniedResult(deniedReason);
        return result;
      }

      result = await this.dispatchContextTool(name, args, identity);
      for (const plugin of this.plugins) {
        const output = await plugin.process({
          connectorId: 'mvmt',
          toolName: name,
          originalName: name,
          args,
          result,
        });
        result = output.result;
        redactions.push(...flattenRedactionEvents(output.auditEvents ?? []));
      }
      return result;
    } catch (err) {
      threw = true;
      result = {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}` }],
        isError: true,
      };
      return result;
    } finally {
      this.recordAudit(
        name,
        args,
        start,
        result,
        threw,
        redactions,
        identity,
        deniedReason ?? (result?.isError ? deniedReasonFromResult(result) : undefined),
      );
    }
  }

  private async dispatchContextTool(
    name: ContextToolName,
    args: Record<string, unknown>,
    identity?: ClientIdentity,
  ): Promise<CallToolResult> {
    if (!this.contextIndex) return accessDeniedResult('text_index_disabled');
    if (name === 'search') {
      const query = requireString(args.query, 'query');
      const requested = optionalStringArray(args.mounts);
      const mountNames = this.allowedContextMounts('search', identity, requested);
      const limit = normalizeLimit(args.limit);
      return jsonResult({
        query,
        ranking: 'prototype_keyword_count',
        results: (await this.contextIndex.search(query, mountNames, limit))
          .filter((entry) => pathAllowed(entry.path, 'search', identity)),
      });
    }

    if (name === 'list') {
      const inputPath = optionalString(args.path) ?? '/';
      const mountName = inputPath === '/' ? undefined : this.contextIndex.mountNameForPath(inputPath);
      if (mountName && !pathMayExposeEntry(inputPath, 'read', identity)) {
        return accessDeniedResult(`missing_permission path=${inputPath} action=read`);
      }
      const entries = await this.contextIndex.list(inputPath);
      return jsonResult({
        path: inputPath,
        entries: entries.filter((entry) => pathMayExposeEntry(entry.path, 'read', identity)),
      });
    }

    if (name === 'read') {
      const inputPath = requireString(args.path, 'path');
      const mountName = this.contextIndex.mountNameForPath(inputPath);
      if (!mountName || !pathAllowed(inputPath, 'read', identity)) {
        return accessDeniedResult(`missing_permission path=${inputPath} action=read`);
      }
      return jsonResult(await this.contextIndex.read(inputPath));
    }

    if (name === 'write') {
      const inputPath = requireString(args.path, 'path');
      const content = requireText(args.content, 'content');
      const expectedHash = optionalString(args.expected_hash);
      const mountName = this.contextIndex.mountNameForPath(inputPath);
      if (!mountName || !pathAllowed(inputPath, 'write', identity)) {
        return accessDeniedResult(`missing_permission path=${inputPath} action=write`);
      }
      return jsonResult(await this.contextIndex.write(inputPath, content, expectedHash));
    }

    const inputPath = requireString(args.path, 'path');
    const mountName = this.contextIndex.mountNameForPath(inputPath);
    if (!mountName || !pathAllowed(inputPath, 'write', identity)) {
      return accessDeniedResult(`missing_permission path=${inputPath} action=write`);
    }
    return jsonResult(await this.contextIndex.remove(inputPath));
  }

  private isContextToolVisible(name: string, identity?: ClientIdentity): boolean {
    if (!isContextToolName(name) || !this.contextIndex) return false;
    return actionAvailable(contextToolRequiredAction(name), identity);
  }

  private allowedContextMounts(
    action: PermissionAction,
    identity?: ClientIdentity,
    requestedMountNames?: string[],
  ): string[] {
    if (!this.contextIndex) return [];
    const requested = requestedMountNames ? new Set(requestedMountNames) : undefined;
    return this.contextIndex.mountNames().filter((mountName) => {
      const mountPath = this.contextIndex?.mountPathForName(mountName);
      return Boolean(mountPath)
        && (!requested || requested.has(mountName))
        && pathMayExposeEntry(mountPath!, action, identity);
    });
  }

  private recordAudit(
    name: string,
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
      connectorId: 'mvmt',
      tool: name,
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

function buildContextToolDefinitions(): NamespacedTool[] {
  return [
    {
      namespacedName: 'search',
      originalName: 'search',
      connectorId: 'mvmt',
      sourceId: 'mvmt',
      requiredAction: 'search',
      toolKind: 'semantic',
      description: 'Search permitted text-file mounts and return ranked chunks from the local index.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword or phrase to search for' },
          mounts: { type: 'array', items: { type: 'string' }, description: 'Optional mount names to search' },
          limit: { type: 'number', description: 'Maximum total results. Default 8, max 20' },
        },
        required: ['query'],
      },
    },
    {
      namespacedName: 'list',
      originalName: 'list',
      connectorId: 'mvmt',
      sourceId: 'mvmt',
      requiredAction: 'read',
      toolKind: 'semantic',
      description: 'List permitted mounts or a directory within one mount.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional path such as /workspace or /workspace/docs' },
        },
      },
    },
    {
      namespacedName: 'read',
      originalName: 'read',
      connectorId: 'mvmt',
      sourceId: 'mvmt',
      requiredAction: 'read',
      toolKind: 'semantic',
      description: 'Read one permitted text file by path.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path such as /workspace/README.md' },
        },
        required: ['path'],
      },
    },
    {
      namespacedName: 'write',
      originalName: 'write',
      connectorId: 'mvmt',
      sourceId: 'mvmt',
      requiredAction: 'write',
      toolKind: 'semantic',
      description: 'Create or overwrite one permitted text file. Optionally pass expected_hash to avoid stale writes.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path such as /workspace/notes.md' },
          content: { type: 'string', description: 'Full file content to write' },
          expected_hash: { type: 'string', description: 'Optional SHA-256 hash from a previous read' },
        },
        required: ['path', 'content'],
      },
    },
    {
      namespacedName: 'remove',
      originalName: 'remove',
      connectorId: 'mvmt',
      sourceId: 'mvmt',
      requiredAction: 'write',
      toolKind: 'semantic',
      description: 'Remove one permitted text file. Protected paths are always blocked.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path such as /workspace/old-note.md' },
        },
        required: ['path'],
      },
    },
  ];
}

function isContextToolName(value: string): value is ContextToolName {
  return value === 'search' || value === 'list' || value === 'read' || value === 'write' || value === 'remove';
}

function contextToolRequiredAction(name: ContextToolName): PermissionAction {
  return name === 'search' ? 'search' : name === 'write' || name === 'remove' ? 'write' : 'read';
}

function pathAllowed(inputPath: string, action: PermissionAction, identity?: ClientIdentity): boolean {
  if (!identity || identity.isLegacyDefault) return true;
  const normalized = normalizePermissionPath(inputPath);
  return identity.permissions.some((permission) => (
    permission.actions.includes(action) && pathMatchesPermission(normalized, permission.path)
  ));
}

function pathMayExposeEntry(inputPath: string, action: PermissionAction, identity?: ClientIdentity): boolean {
  if (!identity || identity.isLegacyDefault) return true;
  const normalized = normalizePermissionPath(inputPath);
  return identity.permissions.some((permission) => {
    if (!permission.actions.includes(action)) return false;
    if (pathMatchesPermission(normalized, permission.path)) return true;
    const base = permission.path.endsWith('/**')
      ? normalizePermissionPath(permission.path.slice(0, -3))
      : normalizePermissionPath(permission.path);
    return base === normalized || base.startsWith(`${normalized}/`);
  });
}

function actionAvailable(action: PermissionAction, identity?: ClientIdentity): boolean {
  return !identity || identity.isLegacyDefault || identity.permissions.some((permission) => permission.actions.includes(action));
}

function pathMatchesPermission(inputPath: string, pattern: string): boolean {
  const normalizedPattern = normalizePermissionPath(pattern);
  if (normalizedPattern === '/**') return true;
  if (normalizedPattern.endsWith('/**')) {
    const base = normalizedPattern.slice(0, -3);
    return inputPath === base || inputPath.startsWith(`${base}/`);
  }
  return inputPath === normalizedPattern;
}

function normalizePermissionPath(inputPath: string): string {
  const trimmed = stripTrailingSlashes(normalizePathSeparators(inputPath.trim()));
  if (!trimmed || trimmed === '/') return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(20, Math.floor(value)));
}

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function accessDeniedResult(reason: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `Error: access denied (${reason}).` }],
    isError: true,
  };
}

function extractToolText(raw: CallToolResult): string {
  return raw.content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function errorTextFromResult(result: CallToolResult): string | undefined {
  const text = extractToolText(result);
  return text.startsWith('Error: ') ? text.slice('Error: '.length, 180) : undefined;
}

function deniedReasonFromResult(result: CallToolResult): string | undefined {
  const text = extractToolText(result);
  const match = text.match(/^Error: access denied \((.+)\)\.?$/);
  return match?.[1] ?? errorTextFromResult(result);
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
