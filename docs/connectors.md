# Connectors

A connector is mvmt's adapter for one local data source or tool surface.

Examples:

- **Obsidian** is a native connector. mvmt reads the vault directly with Node filesystem APIs.
- **Filesystem** is a proxy connector. mvmt launches the official filesystem MCP server as a child process and routes its tools through mvmt's auth, write gates, plugins, and audit log.
- **MemPalace** is a proxy connector setup. mvmt launches the local MemPalace MCP server as a child process and applies mvmt-side write gates, plugins, and audit logging.

Connectors are the boundary where mvmt decides what exists, what is exposed, what is read-only, and what counts as a write.

## What a connector does

A connector is responsible for:

- Validating its configured scope during startup.
- Listing MCP tools that should be visible to clients.
- Executing a tool call by original tool name.
- Returning a standard MCP `CallToolResult`.
- Refusing out-of-scope paths, tables, repos, vaults, or other resources.
- Hiding or blocking write tools unless write access is explicitly enabled.
- Cleaning up child processes, sockets, handles, or other resources on shutdown.

The router is responsible for namespacing and dispatch. The connector is responsible for source-specific safety.

## Connector interface

Native connectors implement `Connector` from `src/connectors/types.ts`.

```ts
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface CallToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
}

export interface Connector {
  readonly id: string;
  readonly displayName: string;
  initialize(): Promise<void>;
  listTools(): Promise<ToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  shutdown(): Promise<void>;
}
```

## Native vs proxy connectors

### Native connector

A native connector is implemented in mvmt itself. Use this when mvmt can provide a safer or more focused local integration than an existing MCP server.

Good native connector candidates:

- Local notes.
- Local files with mvmt-specific path controls.
- Local databases with per-table permissions.
- Local Git repositories with branch-aware search.

Native connectors should be narrow and explicit. A connector should never scan a whole machine unless the user selected that scope.

### Proxy connector

A proxy connector wraps an existing MCP server. mvmt starts it over stdio or connects to it over HTTP, then forwards tools through mvmt's router.

Proxy connectors are useful when the external MCP server is already the right implementation. Filesystem and MemPalace currently use this model.

Proxy connectors still need mvmt-side guardrails:

- Stdio children get scrubbed environment variables.
- Known write tools are hidden and rejected when `writeAccess: false`.
- Tool calls still go through plugins and audit logging.

HTTP proxy write gates are not complete in v0. Treat HTTP proxy connectors as advanced/manual configuration.

### MemPalace proxy setup

MemPalace is treated as a local stdio MCP server. During `mvmt init`, mvmt tries to detect:

- the `mempalace` executable on `PATH`,
- the Python executable from the `mempalace` script shebang,
- the palace path from `~/.mempalace/config.json`.

If detection is incomplete, init prompts for the missing command or palace path. The generated proxy looks like:

```yaml
proxy:
  - name: mempalace
    source: mempalace
    transport: stdio
    command: /Users/you/.local/pipx/venvs/mempalace/bin/python
    args: ["-m", "mempalace.mcp_server", "--palace", "/Users/you/.mempalace/palace"]
    env: {}
    writeAccess: false
    enabled: true
```

When `writeAccess: false`, mvmt hides and rejects known MemPalace write tools including drawer creation/deletion, KG mutation, tunnel creation/deletion, hook settings, and diary writes. Read/search/list tools remain visible.

## How to add a native connector

1. Add a connector class under `src/connectors/`.
2. Implement `Connector`.
3. Add a config schema in `src/config/schema.ts`.
4. Add setup prompts in `src/cli/init.ts`.
5. Wire startup in `src/cli/start.ts`.
6. Add diagnostics in `src/cli/doctor.ts`.
7. Add exports in `src/index.ts` if the connector is part of the public API.
8. Add tests for tool listing, scope validation, path traversal, write gates, and shutdown.
9. Document the connector in `README.md` and `docs/configuration.md`.

## Minimal native connector skeleton

```ts
import { Connector, ToolDefinition, CallToolResult } from './types.js';

export class ExampleConnector implements Connector {
  readonly id = 'example';
  readonly displayName = 'example';

  async initialize(): Promise<void> {
    // Validate configured scope here.
  }

  async listTools(): Promise<ToolDefinition[]> {
    return [
      {
        name: 'read_item',
        description: 'Read one scoped item.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
      },
    ];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (name !== 'read_item') {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ id: args.id, value: 'example' }, null, 2),
        },
      ],
    };
  }

  async shutdown(): Promise<void> {
    // Close resources here.
  }
}
```

## Security checklist

Before adding a connector, answer these questions in code and docs:

- What exact user-selected scope does this connector expose?
- What is read-only by default?
- Which tools write, mutate, delete, move, append, or upload data?
- How are path traversal, symlink escape, table escape, repo escape, or network escape blocked?
- What does `mvmt doctor` verify?
- What gets written to the audit log?
- What happens when startup validation fails?

If the safest answer is "exclude that data from scope," prefer scope controls over redaction.
