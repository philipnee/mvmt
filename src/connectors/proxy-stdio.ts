import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResult, Connector, ToolDefinition } from './types.js';

export interface StdioProxyConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  writeAccess?: boolean;
}

export class StdioProxyConnector implements Connector {
  readonly id: string;
  readonly displayName: string;
  private client?: Client;
  private transport?: StdioClientTransport;
  private tools: ToolDefinition[] = [];
  private readonly readOnlyFilesystem: boolean;
  private readonly readOnlyGeneric: boolean;

  constructor(private readonly config: StdioProxyConfig) {
    this.id = `proxy_${sanitizeName(config.name)}`;
    this.displayName = config.name;
    const isFs = isFilesystemProxy(config);
    this.readOnlyFilesystem = isFs && config.writeAccess !== true;
    this.readOnlyGeneric = !isFs && config.writeAccess === false;
  }

  async initialize(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: buildChildEnv(this.config.env),
    });

    this.client = new Client(
      { name: `mvmt-proxy-${this.config.name}`, version: '0.1.0' },
      { capabilities: {} },
    );

    await this.client.connect(this.transport);

    const result = await this.client.listTools();
    this.tools = result.tools
      .map((tool) => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema,
      }))
      .filter((tool) => this.isToolAllowed(tool.name));
  }

  async listTools(): Promise<ToolDefinition[]> {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.client) throw new Error(`Connector not initialized: ${this.displayName}`);
    if (!this.isToolAllowed(name)) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: write access is disabled for tool "${name}". Set writeAccess: true for proxy "${this.displayName}" in ~/.mvmt/config.yaml or re-run mvmt init to enable writes.`,
          },
        ],
        isError: true,
      };
    }
    const result = await this.client.callTool({ name, arguments: args });
    return result as CallToolResult;
  }

  async shutdown(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // The child process may already be gone.
    }
  }

  private isToolAllowed(name: string): boolean {
    if (this.readOnlyFilesystem && !isReadOnlyFilesystemTool(name)) return false;
    if (this.readOnlyGeneric && isLikelyWriteTool(name)) return false;
    return true;
  }
}

export function sanitizeName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
  return sanitized || 'server';
}

function isFilesystemProxy(config: StdioProxyConfig): boolean {
  const fingerprint = [config.name, config.command, ...config.args].join(' ').toLowerCase();
  return fingerprint.includes('filesystem');
}

function isReadOnlyFilesystemTool(name: string): boolean {
  return READ_ONLY_FILESYSTEM_TOOLS.has(name);
}

const READ_ONLY_FILESYSTEM_TOOLS = new Set([
  'directory_tree',
  'get_file_info',
  'list_allowed_directories',
  'list_directory',
  'read_file',
  'read_media_file',
  'read_multiple_files',
  'read_text_file',
  'search_files',
]);

const WRITE_TOOL_PREFIXES = [
  'write_',
  'edit_',
  'create_',
  'delete_',
  'remove_',
  'move_',
  'rename_',
  'append_',
  'update_',
  'patch_',
  'put_',
  'upsert_',
  'insert_',
  'drop_',
  'set_',
  'mkdir',
];

export function isLikelyWriteTool(name: string): boolean {
  const lower = name.toLowerCase();
  return WRITE_TOOL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

const SAFE_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TERM',
  'TMPDIR',
  'PWD',
  'SYSTEMROOT',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMDATA',
  'USERPROFILE',
  'COMSPEC',
]);

export function buildChildEnv(configEnv: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SAFE_ENV_KEYS.has(key)) base[key] = value;
  }
  return { ...base, ...configEnv };
}
