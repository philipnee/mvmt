import { CallToolResult, Connector, ToolDefinition } from '../connectors/types.js';
import { isLikelyWriteTool, isMemPalaceWriteTool } from '../connectors/write-policy.js';
import { TextContextIndex } from '../context/text-index.js';
import { PermissionConfig, SemanticToolsConfig } from '../config/schema.js';
import { PatternRedactorAuditEvent, ToolResultPlugin } from '../plugins/types.js';
import { AuditLogger, summarizeArgs } from '../utils/audit.js';
import { ClientIdentity } from './client-identity.js';

type PermissionAction = PermissionConfig['actions'][number];
type ToolKind = 'raw' | 'semantic';
type SemanticToolName = 'search_personal_context' | 'read_context_item';
type ContextToolName = 'search' | 'list' | 'read' | 'write' | 'remove';

interface ToolEntry {
  connector: Connector;
  originalName: string;
  sourceId: string;
  requiredAction: PermissionAction;
  namespacedName: string;
  toolKind: ToolKind;
}

export interface ToolRouterOptions {
  semanticTools?: SemanticToolsConfig;
  contextIndex?: TextContextIndex;
}

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
  toolKind: ToolKind;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class ToolRouter {
  private readonly toolMap = new Map<string, ToolEntry>();
  private readonly toolsBySource = new Map<string, ToolEntry[]>();
  private readonly allTools: NamespacedTool[] = [];
  private readonly semanticToolDefinitions: NamespacedTool[] = [];
  private readonly connectors: RouterConnector[];
  private readonly semanticTools: SemanticToolsConfig;
  private readonly contextIndex?: TextContextIndex;

  constructor(
    connectors: Array<Connector | RouterConnector>,
    private readonly audit?: AuditLogger,
    private readonly plugins: ToolResultPlugin[] = [],
    options: ToolRouterOptions = {},
  ) {
    this.connectors = connectors.map((entry) => (
      'connector' in entry
        ? entry
        : { connector: entry, sourceId: entry.id }
    ));
    this.semanticTools = options.semanticTools ?? {};
    this.contextIndex = options.contextIndex;
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

        const entry: ToolEntry = {
          connector,
          originalName: tool.name,
          sourceId,
          requiredAction,
          namespacedName,
          toolKind: 'raw',
        };

        this.toolMap.set(namespacedName, entry);
        const sourceTools = this.toolsBySource.get(sourceId) ?? [];
        sourceTools.push(entry);
        this.toolsBySource.set(sourceId, sourceTools);

        this.allTools.push({
          namespacedName,
          originalName: tool.name,
          connectorId: connector.id,
          sourceId,
          requiredAction,
          toolKind: 'raw',
          description: `[${connector.displayName}] ${tool.description}`,
          inputSchema: normalizeInputSchema(tool),
        });
      }
    }

    this.semanticToolDefinitions.push(...buildSemanticToolDefinitions());
    if (this.contextIndex) {
      this.semanticToolDefinitions.push(...buildContextToolDefinitions());
    }
  }

  getAllTools(identity?: ClientIdentity): NamespacedTool[] {
    return [
      ...this.allTools.filter((tool) => isToolAllowed(tool, identity)).map((tool) => ({ ...tool })),
      ...this.semanticToolDefinitions
        .filter((tool) => this.isVirtualToolVisible(tool.namespacedName, identity))
        .map((tool) => ({ ...tool })),
    ];
  }

  async callTool(
    namespacedName: string,
    args: Record<string, unknown>,
    identity?: ClientIdentity,
  ): Promise<CallToolResult> {
    if (isSemanticToolName(namespacedName)) {
      return this.callSemanticTool(namespacedName, args, identity);
    }
    if (isContextToolName(namespacedName)) {
      return this.callContextTool(namespacedName, args, identity);
    }

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

  private async callSemanticTool(
    name: SemanticToolName,
    args: Record<string, unknown>,
    identity?: ClientIdentity,
  ): Promise<CallToolResult> {
    const start = Date.now();
    const redactions: NonNullable<import('../utils/audit.js').AuditEntry['redactions']> = [];
    let result: CallToolResult | undefined;
    let threw = false;

    try {
      result = name === 'search_personal_context'
        ? await this.searchPersonalContext(args, identity)
        : await this.readContextItem(args, identity);

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
        content: [
          {
            type: 'text',
            text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
      return result;
    } finally {
      this.recordAudit(
        { connector: { id: 'mvmt', displayName: 'mvmt' } as Connector },
        name,
        args,
        start,
        result,
        threw,
        redactions,
        identity,
        result?.isError ? semanticErrorText(result) : undefined,
      );
    }
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
        { connector: { id: 'mvmt', displayName: 'mvmt' } as Connector },
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

  private async searchPersonalContext(
    args: Record<string, unknown>,
    identity?: ClientIdentity,
  ): Promise<CallToolResult> {
    const query = requireString(args.query, 'query');
    const requestedSourceIds = optionalStringArray(args.source_ids);
    const limit = normalizeLimit(args.limit);
    const sourceIds = this.allowedSemanticSources('search_personal_context', identity, requestedSourceIds);
    const results: PersonalContextSearchResult[] = [];
    const warnings: string[] = [];

    for (const sourceId of sourceIds) {
      if (results.length >= limit) break;
      const adapter = this.findSemanticAdapter(sourceId, 'search');
      if (!adapter) {
        warnings.push(`source ${sourceId} has no supported search adapter`);
        continue;
      }

      const raw = await adapter.connector.callTool(adapter.originalName, buildSearchArgs(adapter.originalName, query, limit));
      if (raw.isError) {
        warnings.push(`source ${sourceId} search failed: ${extractToolText(raw).slice(0, 160)}`);
        continue;
      }

      for (const item of normalizeSearchResults(sourceId, sourceTypeFor(adapter), query, raw)) {
        results.push(item);
        if (results.length >= limit) break;
      }
    }

    return jsonResult({
      query,
      ranking: 'per_source_keyword_union',
      results,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  }

  private async readContextItem(args: Record<string, unknown>, identity?: ClientIdentity): Promise<CallToolResult> {
    const sourceId = requireString(args.source_id, 'source_id');
    const itemId = requireString(args.item_id, 'item_id');
    const allowedSources = this.allowedSemanticSources('read_context_item', identity, [sourceId]);
    if (!allowedSources.includes(sourceId)) {
      return accessDeniedResult(`missing_permission path=/${sourceId} action=read`);
    }

    const adapter = this.findSemanticAdapter(sourceId, 'read');
    if (!adapter) return accessDeniedResult(`source ${sourceId} has no supported read adapter`);

    const raw = await adapter.connector.callTool(adapter.originalName, buildReadArgs(adapter.originalName, itemId));
    if (raw.isError) return raw;
    const parsed = parseToolJson(raw);
    const content = typeof parsed?.content === 'string' ? parsed.content : extractToolText(raw);
    const title = typeof parsed?.path === 'string' ? titleFromLocator(parsed.path) : titleFromLocator(itemId);

    return jsonResult({
      source_id: sourceId,
      item_id: itemId,
      mime_type: 'text/plain',
      title,
      content,
      metadata: objectMetadata(parsed, ['path', 'tags']),
    });
  }

  private isSemanticToolVisible(name: SemanticToolName, identity?: ClientIdentity): boolean {
    return this.allowedSemanticSources(name, identity).length > 0;
  }

  private isVirtualToolVisible(name: string, identity?: ClientIdentity): boolean {
    if (isSemanticToolName(name)) return this.isSemanticToolVisible(name, identity);
    if (isContextToolName(name)) {
      const action: PermissionAction = name === 'search' ? 'search' : name === 'write' || name === 'remove' ? 'write' : 'read';
      return this.contextIndex !== undefined && actionAvailable(action, identity);
    }
    return false;
  }

  private allowedSemanticSources(
    name: SemanticToolName,
    identity?: ClientIdentity,
    requestedSourceIds?: string[],
  ): string[] {
    const config = name === 'search_personal_context'
      ? this.semanticTools.searchPersonalContext
      : this.semanticTools.readContextItem;
    if (!config || config.enabled === false) return [];
    const action: PermissionAction = name === 'search_personal_context' ? 'search' : 'read';
    const requested = requestedSourceIds ? new Set(requestedSourceIds) : undefined;
    return config.sourceIds.filter((sourceId) => (
      (!requested || requested.has(sourceId)) &&
      semanticSourceAllowed(sourceId, action, identity) &&
      Boolean(this.findSemanticAdapter(sourceId, action))
    ));
  }

  private findSemanticAdapter(sourceId: string, action: PermissionAction): ToolEntry | undefined {
    const tools = this.toolsBySource.get(sourceId) ?? [];
    const preferred = action === 'search'
      ? ['search_personal_context', 'search_notes', 'search_files', 'mempalace_search', 'mempalace_kg_search']
      : ['read_context_item', 'read_note', 'read_file', 'read_text_file'];
    return preferred
      .map((name) => tools.find((tool) => tool.originalName === name))
      .find((tool): tool is ToolEntry => Boolean(tool));
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
  tool: { sourceId: string; requiredAction: PermissionAction; toolKind?: ToolKind },
  identity?: ClientIdentity,
): string | undefined {
  if (!identity || identity.isLegacyDefault) return undefined;
  if (tool.toolKind === 'semantic') return undefined;
  if (!identity.rawToolsEnabled) return 'raw_tools_disabled';
  const sourcePath = `/${tool.sourceId}`;
  if (pathAllowed(sourcePath, tool.requiredAction, identity)) return undefined;
  return `missing_permission path=${sourcePath} action=${tool.requiredAction}`;
}

function inferRequiredAction(toolName: string): PermissionAction {
  const lower = toolName.toLowerCase();
  if (isMemPalaceWriteTool(lower)) return 'memory_write';
  if (isLikelyWriteTool(lower)) return 'write';
  if (lower.includes('search') || lower.startsWith('find_') || lower.startsWith('query_')) return 'search';
  return 'read';
}

interface PersonalContextSearchResult {
  item_id: string;
  source_id: string;
  source_type: 'filesystem' | 'mempalace' | 'generic';
  title: string;
  snippet: string;
  locator: string;
  actions: ['read_context_item'];
}

function buildSemanticToolDefinitions(): NamespacedTool[] {
  return [
    {
      namespacedName: 'search_personal_context',
      originalName: 'search_personal_context',
      connectorId: 'mvmt',
      sourceId: 'mvmt',
      requiredAction: 'search',
      toolKind: 'semantic',
      description: 'Search configured personal context sources and return source-attributed keyword results.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword or phrase to search for' },
          source_ids: { type: 'array', items: { type: 'string' }, description: 'Optional source IDs to search' },
          limit: { type: 'number', description: 'Maximum total results. Default 8, max 20' },
        },
        required: ['query'],
      },
    },
    {
      namespacedName: 'read_context_item',
      originalName: 'read_context_item',
      connectorId: 'mvmt',
      sourceId: 'mvmt',
      requiredAction: 'read',
      toolKind: 'semantic',
      description: 'Read a specific item returned by search_personal_context.',
      inputSchema: {
        type: 'object',
        properties: {
          source_id: { type: 'string', description: 'Source ID returned by search_personal_context' },
          item_id: { type: 'string', description: 'Item ID returned by search_personal_context' },
        },
        required: ['source_id', 'item_id'],
      },
    },
  ];
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

function isSemanticToolName(value: string): value is SemanticToolName {
  return value === 'search_personal_context' || value === 'read_context_item';
}

function isContextToolName(value: string): value is ContextToolName {
  return value === 'search' || value === 'list' || value === 'read' || value === 'write' || value === 'remove';
}

function semanticSourceAllowed(sourceId: string, action: PermissionAction, identity?: ClientIdentity): boolean {
  return pathAllowed(`/${sourceId}`, action, identity);
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
  const trimmed = inputPath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
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
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(20, Math.floor(value)));
}

function buildSearchArgs(toolName: string, query: string, limit: number): Record<string, unknown> {
  if (toolName === 'search_notes') return { query, maxResults: limit };
  if (toolName === 'search_files') return { path: '.', pattern: query };
  return { query, limit };
}

function buildReadArgs(toolName: string, itemId: string): Record<string, unknown> {
  if (toolName === 'read_note') return { notePath: itemId };
  if (toolName === 'read_file' || toolName === 'read_text_file') return { path: itemId };
  return { item_id: itemId };
}

function normalizeSearchResults(
  sourceId: string,
  sourceType: PersonalContextSearchResult['source_type'],
  query: string,
  raw: CallToolResult,
): PersonalContextSearchResult[] {
  const parsed = parseToolJson(raw);
  const rawResults = Array.isArray(parsed?.results) ? parsed.results : [];
  const results: PersonalContextSearchResult[] = [];

  for (const item of rawResults) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const locator = stringValue(record.path) ?? stringValue(record.file) ?? stringValue(record.id) ?? stringValue(record.title);
    if (!locator) continue;
    const snippet = stringValue(record.snippet) ?? stringValue(record.text) ?? stringValue(record.content) ?? query;
    results.push({
      item_id: locator,
      source_id: sourceId,
      source_type: sourceType,
      title: stringValue(record.title) ?? titleFromLocator(locator),
      snippet: snippet.slice(0, 500),
      locator,
      actions: ['read_context_item'],
    });
  }

  return results;
}

function parseToolJson(raw: CallToolResult): Record<string, unknown> | undefined {
  const text = extractToolText(raw);
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function extractToolText(raw: CallToolResult): string {
  return raw.content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
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

function sourceTypeFor(entry: ToolEntry): PersonalContextSearchResult['source_type'] {
  const fingerprint = `${entry.sourceId} ${entry.connector.id} ${entry.connector.displayName} ${entry.originalName}`.toLowerCase();
  if (fingerprint.includes('mempalace')) return 'mempalace';
  if (fingerprint.includes('file')) return 'filesystem';
  return 'generic';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function titleFromLocator(locator: string): string {
  const normalized = locator.replace(/\\/g, '/');
  const leaf = normalized.split('/').filter(Boolean).at(-1) ?? normalized;
  return leaf.replace(/\.md$/i, '') || locator;
}

function objectMetadata(value: Record<string, unknown> | undefined, keys: string[]): Record<string, string | string[]> {
  const metadata: Record<string, string | string[]> = {};
  if (!value) return metadata;
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === 'string') metadata[key] = entry;
    if (Array.isArray(entry) && entry.every((item) => typeof item === 'string')) metadata[key] = entry;
  }
  return metadata;
}

function semanticErrorText(result: CallToolResult): string | undefined {
  const text = extractToolText(result);
  return text.startsWith('Error: ') ? text.slice('Error: '.length, 180) : undefined;
}

function deniedReasonFromResult(result: CallToolResult): string | undefined {
  const text = extractToolText(result);
  const match = text.match(/^Error: access denied \((.+)\)\.?$/);
  return match?.[1] ?? semanticErrorText(result);
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
