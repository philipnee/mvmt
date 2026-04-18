# mvmt

**mvmt is a local-first data hub that gives AI clients scoped access to your files, notes, and local tools.**

- Choose exactly which folders and local sources are exposed.
- Read-only by default, with explicit write access per connector.
- One local MCP endpoint for Claude, Cursor, Codex, VS Code, and other MCP clients.
- Native Obsidian connector, plus scoped filesystem access through the official filesystem MCP server.
- Bearer-token auth, Origin checks, optional pattern-based redaction, diagnostics, and a local audit log.

> [!WARNING]
> Tunnel mode is experimental and intended for demos or remote testing with narrow, read-only scopes.

## Quick Start

```bash
git clone https://github.com/philipnee/mvmt.git
cd mvmt
npm install
npm run build
npm link

mvmt init
mvmt start -i # -i stands for interactive mode
```

## Screenshot

> Screenshot/GIF placeholder: `mvmt init` -> `mvmt start` -> an MCP client reading a scoped local note or folder.

## Status

| Area | Status |
| --- | --- |
| Local filesystem folders | supported, read-only by default |
| Native Obsidian connector | supported, read-only by default |
| Local Streamable HTTP | supported |
| Stdio mode | supported |
| Interactive start mode | supported |
| Built-in pattern-based redactor plugin | supported, opt-in during `mvmt init` |
| Tunnel mode | experimental, demo/testing only |
| Public production remote access | not ready |
| HTTP proxy write gates | incomplete; advanced/manual config only |

## Client Compatibility

| Client | Transport | Status | Auth method | Known issues |
| --- | --- | --- | --- | --- |
| Claude Desktop | stdio | supported | process launch, no HTTP bearer token | Runs its own mvmt process per config |
| Claude Code | Streamable HTTP | supported | bearer token header | Token must be refreshed after `mvmt start` or `mvmt token rotate` |
| Codex CLI | Streamable HTTP | supported | bearer token env var | Start Codex from a shell where the token env var is set |
| Cursor | Streamable HTTP | expected | bearer token header | Client behavior may vary by Cursor MCP version |
| VS Code / Copilot | Streamable HTTP | expected | bearer token header | Client behavior may vary by MCP extension/version |
| claude.ai / ChatGPT web | public HTTPS tunnel | experimental | OAuth/tunnel flow in progress | Do not use for production data; SSE/tunnel behavior can be flaky |
| Raw HTTP/curl | Streamable HTTP | debug only | bearer token header | Must follow MCP session initialization rules |

## Security At A Glance

Every file and data access in mvmt is gated. There is no open mode.

- HTTP mode binds to `127.0.0.1`, not `0.0.0.0`.
- HTTP requests to `/mcp` and `/health` require a bearer token.
- Tokens are generated fresh on `mvmt start` and stored at `~/.mvmt/.session-token`.
- Browser requests from non-localhost origins are rejected unless allowlisted.
- Write access is opt-in per connector.
- Stdio child processes receive a scrubbed environment.
- Optional pattern-based redactor can warn, redact, or block configured regex matches in tool results.
- Tool calls are appended to `~/.mvmt/audit.log`.

Not yet enforced: TLS on localhost, per-client tokens, rate limiting, and full write gates for HTTP proxy connectors.

## Project Docs

- [Architecture](docs/architecture.md)
- [Security policy](SECURITY.md)
- [Security memo](docs/security-memo.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Full Client Setup

All clients connect to the same endpoint. Get your token first:
```bash
mvmt token show
```

Or `show token` in the interactive mode.

### Claude Desktop

Use stdio mode so Claude Desktop launches mvmt directly:

```json
{
  "mcpServers": {
    "mvmt": {
      "command": "mvmt",
      "args": ["start", "--stdio"]
    }
  }
}
```

No token is needed in stdio mode.

### Claude Code

Start mvmt first:

```bash
mvmt start
```

Then add the HTTP endpoint:

```bash
claude mcp add --transport http \
  --header "Authorization: Bearer $(mvmt token show)" \
  mvmt http://127.0.0.1:4141/mcp
```

If mvmt restarts, it generates a new token. Update the client token after each restart.

### Codex CLI

Codex stores a bearer-token environment variable name, not the token value itself:

```bash
export MVMT_TOKEN="$(mvmt token show)"
codex mcp add mvmt \
  --url http://127.0.0.1:4141/mcp \
  --bearer-token-env-var MVMT_TOKEN
```

Start new Codex sessions from a shell where `MVMT_TOKEN` is set:

```bash
MVMT_TOKEN="$(mvmt token show)" codex
```

### Cursor

Add to `.cursor/mcp.json` or through Cursor's MCP settings:

```json
{
  "mcpServers": {
    "mvmt": {
      "url": "http://127.0.0.1:4141/mcp",
      "headers": {
        "Authorization": "Bearer <paste token from ~/.mvmt/.session-token>"
      }
    }
  }
}
```

### VS Code

Add to `.vscode/mcp.json`:

```json
{
  "mcpServers": {
    "mvmt": {
      "url": "http://127.0.0.1:4141/mcp",
      "headers": {
        "Authorization": "Bearer <paste token from ~/.mvmt/.session-token>"
      }
    }
  }
}
```

### Raw HTTP

Direct `curl` is useful for debugging, but MCP Streamable HTTP is session-based. Initialize first, capture the `mcp-session-id` response header, then make later requests with that session ID.

```bash
TOKEN="$(mvmt token show)"

curl -i http://127.0.0.1:4141/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-06-18",
      "capabilities": {},
      "clientInfo": { "name": "curl", "version": "0.0.1" }
    }
  }'
```

In normal use, prefer an MCP client instead of raw HTTP.

## Configuration

`~/.mvmt/config.yaml`:

```yaml
version: 1

server:
  port: 4141
  allowedOrigins: []
  access: local

proxy:
  - name: filesystem
    source: manual
    transport: stdio
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-filesystem"
      - /Users/you/project
    env: {}
    writeAccess: false
    enabled: true

obsidian:
  path: /Users/you/Documents/ObsidianVault
  enabled: true
  writeAccess: false

plugins:
  - name: pattern-redactor
    enabled: true
    mode: redact
    maxBytes: 1048576
    patterns:
      - name: anthropic-keys
        regex: "\\bsk-ant-[A-Za-z0-9_-]{20,}\\b"
        flags: g
        replacement: "[REDACTED:ANTHROPIC_KEY]"
        enabled: true
      - name: openai-keys
        regex: "\\bsk-[A-Za-z0-9_-]{20,}\\b"
        flags: g
        replacement: "[REDACTED:OPENAI_KEY]"
        enabled: true
      - name: aws-access-keys
        regex: "\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b"
        flags: g
        replacement: "[REDACTED:AWS_ACCESS_KEY]"
        enabled: true
      - name: github-tokens
        regex: "\\b(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,255}|github_pat_[A-Za-z0-9_]{22,255})\\b"
        flags: g
        replacement: "[REDACTED:GITHUB_TOKEN]"
        enabled: true
      - name: slack-tokens
        regex: "\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b"
        flags: g
        replacement: "[REDACTED:SLACK_TOKEN]"
        enabled: true
      - name: jwt-looking-strings
        regex: "\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b"
        flags: g
        replacement: "[REDACTED:JWT]"
        enabled: true
```

Tunnel config example:

```yaml
server:
  port: 4141
  allowedOrigins: []
  access: tunnel
  tunnel:
    provider: cloudflare-quick
    command: cloudflared tunnel --url http://127.0.0.1:{port}
    # Optional for custom or named tunnels that do not print their public URL:
    # url: https://mvmt.example.com
```

Schema rules:

- `transport: stdio` requires `command`.
- `transport: http` requires `url`.
- `server.port` must be in `1..65535`.
- `server.allowedOrigins` defaults to `[]`.
- `server.access` defaults to `local`.
- `obsidian.writeAccess` defaults to `false`.
- `plugins[].name` currently supports the built-in `pattern-redactor` plugin.
- `pattern-redactor.mode` is `warn`, `redact`, or `block`.
- `pattern-redactor.patterns` is editable. Each pattern has `name`, `regex`, `flags`, `replacement`, and `enabled`.

## Commands

### `mvmt --version`

Prints the installed version and runs a best-effort npm update check.

```bash
mvmt --version
mvmt --version --no-update-check
```

Update checks never install anything. They are skipped when `MVMT_NO_UPDATE_CHECK=1` or `CI` is set. Notices are written to stderr so JSON stdout stays usable.

### `mvmt init`

Interactive setup:

1. Asks whether to expose filesystem folders. Default: no filesystem access.
2. If filesystem access is enabled, asks for exact folders and whether writes are allowed. Default: read-only.
3. Checks available local connectors. Currently, the native connector is Obsidian.
4. Detects Obsidian vaults in common locations, including iCloud Obsidian on macOS.
5. Asks whether Obsidian writes should be enabled. Default: read-only.
6. Asks which built-in security plugins to enable. Currently: pattern-based redactor.
7. If pattern redaction is enabled, asks for mode and default patterns.
8. Asks whether mvmt should be local-only or start a tunnel for a public URL.
9. Writes `~/.mvmt/config.yaml` with mode `600` on non-Windows systems.

Running `mvmt init` against an existing config prompts before overwriting.

### `mvmt start`

Starts the hub.

```bash
mvmt start
mvmt start -i
mvmt start --port 4142
mvmt start --config ~/.mvmt/config.yaml
mvmt start --stdio
```

Options:

| Flag | Description |
| --- | --- |
| `--port <n>` | Override `config.server.port` |
| `--config <p>` | Use a specific config file |
| `--stdio` | Serve MCP over stdio instead of HTTP |
| `--interactive`, `-i` | Start an interactive control prompt |
| `--verbose` | Print more startup details |

HTTP mode:

- Binds to `127.0.0.1`.
- Generates a fresh bearer token every launch.
- Writes the token to `~/.mvmt/.session-token` with mode `600`.
- Requires the token for `/mcp` and `/health`.

Stdio mode:

- Used by clients that launch mvmt directly.
- Does not use bearer-token auth because there is no HTTP listener.
- Skips update checks because stdout is reserved for MCP protocol messages.

Interactive mode:

- Run `mvmt start -i`.
- Keeps mvmt in the foreground with a prompt at the bottom.
- Supports `show token`, `rotate token`, `logs on`, `logs off`, `status`, `url`, and `quit`.
- Live logs show connector, tool name, argument keys, duration, and error state without printing full argument values.

### `mvmt doctor`

Validates the local install, config, and enabled connectors.

```bash
mvmt doctor
mvmt doctor --json
mvmt doctor --config ~/.mvmt/config.yaml
mvmt doctor --timeout-ms 20000
```

Checks include:

- Package version and update availability.
- Config file existence.
- Config schema validation.
- Config file permissions.
- Server port and allowed origins.
- Enabled filesystem connector startup and tool listing.
- Enabled Obsidian connector startup and tool listing.

`mvmt doctor` exits with status `0` when config is valid and all enabled connectors are healthy. It exits with status `1` when config is missing, invalid, or any enabled connector fails health checks.

### `mvmt token`

Manages the HTTP bearer token used by `/mcp` and `/health`.

```bash
mvmt token show
mvmt token rotate
```

`mvmt token show` prints the current token without regenerating it. `mvmt token rotate` writes a new token to `~/.mvmt/.session-token` and prints it. Running HTTP servers validate against the token file on each request, so rotation takes effect immediately. Any connected client that stored the old token must be updated.

## Obsidian Connector

The Obsidian connector is native. It does not spawn a child MCP process.

| Tool | Purpose | Requires `obsidian.writeAccess` |
| --- | --- | --- |
| `search_notes` | Search markdown files by keyword and filename | no |
| `read_note` | Read a note by vault-relative path | no |
| `list_notes` | List notes, optionally by folder, with tags | no |
| `list_tags` | Count tags across the vault | no |
| `append_to_daily` | Append text to `daily/YYYY-MM-DD.md` | yes |

Path traversal is blocked. Symlinked files and directories are skipped during vault walks. Reads also verify the resolved real path stays inside the vault.

## Filesystem Connector

mvmt does not implement its own general filesystem connector. During `mvmt init`, if you choose folder access, mvmt adds the official `@modelcontextprotocol/server-filesystem` as a stdio proxy:

```yaml
proxy:
  - name: filesystem
    source: manual
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/project"]
    env: {}
    writeAccess: false
    enabled: true
```

With `writeAccess: false`, mvmt exposes only this filesystem read allowlist:

- `directory_tree`
- `get_file_info`
- `list_allowed_directories`
- `list_directory`
- `read_file`
- `read_media_file`
- `read_multiple_files`
- `read_text_file`
- `search_files`

Underlying write tools still exist in the filesystem server, but mvmt hides them from `listTools` and rejects them at `callTool`.

## Plugins

Plugins are first-class TypeScript interfaces that can inspect or transform tool results before they leave mvmt. The current public build ships one built-in plugin: `pattern-redactor`.

`pattern-redactor` is a pattern-based redactor. It scans text tool results with configured regex patterns and can warn, replace matches, or block the whole result.

The default pattern set is deliberately small:

- OpenAI-style keys
- Anthropic-style keys
- AWS access key IDs
- GitHub classic and fine-grained tokens
- Slack tokens
- JWT-looking strings

You can edit `~/.mvmt/config.yaml` to add your own patterns.

Modes:

| Mode | Behavior |
| --- | --- |
| `warn` | Returns output unchanged and adds a warning message |
| `redact` | Replaces matches with labels such as `[REDACTED:EMAIL]` |
| `block` | Blocks the whole tool result when a match is found |

The redactor only scans text content. Image content is not modified. `maxBytes` caps scanning per text result so very large files do not create unbounded overhead.

> [!WARNING]
> This is a best-effort pattern matcher, not a security control. It will miss data that doesn't match your patterns, and may redact things you didn't intend. Do not rely on it for compliance, privacy, or security requirements.

Use the redactor as defense-in-depth for accidental leakage, such as a stray API key in a code comment. If your goal is to prevent private or regulated data from reaching AI tools, scope the connector so that data is not exposed at all.

## Tool Namespacing

mvmt prefixes every tool with its connector ID to avoid collisions.

| Connector | Original tool | Namespaced as |
| --- | --- | --- |
| `proxy_filesystem` | `read_file` | `proxy_filesystem__read_file` |
| `obsidian` | `search_notes` | `obsidian__search_notes` |

MCP clients see the namespaced names. The router strips the prefix before forwarding to the connector.

## Security Model

> [!WARNING]
> mvmt is local-first. Do not put it behind a public URL for production use. The current tunnel path is for demos and testing only.

> [!WARNING]
> HTTP proxy connectors are advanced/manual config. `writeAccess` is not fully enforced for HTTP proxy connectors yet, so only configure HTTP proxies you already trust.

> [!WARNING]
> Audit log previews may contain sensitive argument values. The audit log is local and permission-restricted, but it is not value-sanitized.

### Enforced Today

**Localhost bind**

HTTP mode listens on `127.0.0.1` only. It does not bind to `0.0.0.0`, your LAN IP or IPv6.

**Bearer token**

A 256-bit token is generated on every HTTP server start and written to `~/.mvmt/.session-token` with mode `600`. Validation uses constant-time comparison against the current token file, so `mvmt token rotate` takes effect without restarting the server.

Security design notes live in [docs/security-memo.md](docs/security-memo.md).

**Origin allowlist**

Requests with non-localhost `Origin` headers are rejected unless the origin is listed in `server.allowedOrigins`. Requests without an `Origin` header are allowed through this check and still require bearer auth.

**Environment scrubbing for stdio child processes**

Stdio child processes receive a small allowlist of inherited environment variables plus values explicitly set in `proxy[].env`. Parent-process secrets such as API keys are not forwarded unless you put them in the proxy config.

**Stdio proxy write gates**

- Filesystem proxies are read-only by default and use the filesystem allowlist above unless `writeAccess: true`.
- Non-filesystem stdio entries are advanced/manual config. They only apply generic write-name blocking when `writeAccess: false` is present.
- Generic blocking is name-based and catches tool names starting with common write verbs such as `write_`, `edit_`, `create_`, `delete_`, `remove_`, `move_`, `rename_`, `append_`, `update_`, `patch_`, `put_`, `upsert_`, `insert_`, `drop_`, `set_`, and `mkdir`.

HTTP proxy entries are advanced/manual config and are passed through as exposed by the upstream MCP server. mvmt does not currently enforce `writeAccess` on HTTP proxies.

**Obsidian write gate**

`append_to_daily` is hidden and blocked unless `obsidian.writeAccess: true`.

**Pattern-based redactor plugin**

If enabled, `pattern-redactor` runs on tool results after the connector returns and before the MCP client receives the response. It can warn, redact, or block configured regex matches depending on config. Redaction matches are recorded in the audit log with pattern name and count.

**Audit log**

Every tool call routed through mvmt is appended to `~/.mvmt/audit.log` as JSONL. mvmt creates the file with mode `600`.

### Not Enforced Yet

- TLS on localhost.
- Per-client connector scoping.
- Request rate limiting.
- Encrypted config or audit storage.
- OAuth, token revocation lists, or per-client tokens.
- MCP resources and prompts. mvmt currently exposes tools only.
- Write gates for HTTP proxy connectors.
- Dynamic plugin loading. Current plugins are built in.

## Audit Log

> [!WARNING]
> `argPreview` can include truncated argument values. Do not store secrets in tool arguments unless you are comfortable with those values appearing in `~/.mvmt/audit.log`.

Each tool call appends one JSON object to `~/.mvmt/audit.log`:

```json
{
  "ts": "2026-04-14T14:23:01.442Z",
  "connectorId": "obsidian",
  "tool": "obsidian__search_notes",
  "argKeys": ["query", "maxResults"],
  "argPreview": "{\"query\":\"meeting notes\",\"maxResults\":10}",
  "redactions": [
    {
      "pluginId": "pattern-redactor",
      "mode": "redact",
      "pattern": "openai-keys",
      "count": 1
    }
  ],
  "isError": false,
  "durationMs": 34
}
```

`argPreview` is truncated to 512 characters, but it can include argument values. Do not treat the audit log as value-sanitized. When `pattern-redactor` matches, `redactions` records the pattern name and count so you can see why output was changed or blocked.

View recent activity:

```bash
tail -20 ~/.mvmt/audit.log | jq .
```

Filter by connector:

```bash
jq 'select(.connectorId == "obsidian")' ~/.mvmt/audit.log
```

Count tool calls per connector:

```bash
jq -r '.connectorId' ~/.mvmt/audit.log | sort | uniq -c | sort -rn
```

mvmt never truncates or rotates the audit log. To archive it manually:

```bash
mv ~/.mvmt/audit.log ~/.mvmt/audit.log.bak
```

mvmt creates a new log on the next tool call.

## Remote Access

> [!WARNING]
> Tunnel mode is not production remote access. Use it only with narrow scopes, preferably read-only folders or a throwaway vault, and stop the tunnel when testing is done.

mvmt is local-first and binds to `127.0.0.1`. Cloud clients such as claude.ai or ChatGPT web cannot reach your local `localhost`.

For a short demo, `mvmt init` can configure a tunnel. When `mvmt start` runs, mvmt starts the tunnel command, watches its output for a public URL, and prints the MCP URL.

Built-in tunnel choices:

| Tool | Command | Public URL |
| --- | --- | --- |
| Cloudflare Quick Tunnel | `cloudflared tunnel --url http://127.0.0.1:{port}` | `https://random-words.trycloudflare.com/mcp` |
| localhost.run | `ssh -R 80:localhost:{port} nokey@localhost.run` | `https://abc123.localhost.run/mcp` |

Custom tunnel examples:

```bash
npx localtunnel --port {port}
ssh -p 443 -R0:127.0.0.1:{port} a.pinggy.io
```

Use `{port}` in tunnel commands as a placeholder for the configured mvmt port.

If a custom or named tunnel has a stable URL but does not print it on startup, set `server.tunnel.url` in config so mvmt can still print the MCP URL.

Cloudflare Quick Tunnels are for testing. Cloudflare documents that quick tunnels do not support Server-Sent Events, so use a named/stable tunnel or another provider if a client requires SSE.

Use a narrow demo config before exposing mvmt:

- Read-only filesystem access.
- A throwaway folder or demo vault.
- No production secrets in config.
- Stop the tunnel when the demo is over.

A production remote mode should use a proper relay/OAuth design rather than exposing your local hub directly.

## Troubleshooting

### `mvmt start` says port is in use

Another process is using the port.

```bash
mvmt start --port 4142
```

### Connector fails to start

Run:

```bash
mvmt doctor
mvmt start --verbose
```

Common causes:

- The MCP package is not installed or `npx` cannot download it.
- Required environment variables are missing from `proxy[].env`.
- The command is not on `PATH`.
- An advanced/manual HTTP proxy URL is not a Streamable HTTP MCP endpoint.

### Tools are missing

Check:

- Whether the connector is enabled in `~/.mvmt/config.yaml`.
- Whether `writeAccess: false` is hiding write-like tools.
- Whether `mvmt doctor` reports the connector healthy.

### Obsidian vault not detected

`mvmt init` scans these locations one level deep:

- `~/Documents/`
- `~/Obsidian/`
- `~/vaults/`
- `~/`
- `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/` on macOS

If your vault is elsewhere, enter the path manually.

### Token rejected by client

The bearer token changes every time `mvmt start` runs and every time you run `mvmt token rotate`. Read the current token:

```bash
mvmt token show
```

Then update or restart the client with that token.

If the token file is rejected even though mvmt is running, check that the client actually sent the new token. Existing MCP clients may need to be restarted after rotation.

## Coming Next

- Fast file indexer: use Chroma's embedded JS/TS version with its official default embedding function.
- Full key management: named keys, rotation, revocation, expiration, and audit-friendly ownership.
- SQLite connector: local `.db` files with per-table read/write permissions. Good for app data, AI agent state, logs, and side projects.
- Safer writes and atomic operations: atomic tempfile -> rename for all write tools, which helps prevent Obsidian file-locking issues and race conditions. Add optional `--preview` mode that shows a diff before committing a write.
- Git connector: native local repository tools for history, diffs, blame, and branch-aware search. Cloud AI can only see what is pushed, is limited to what GitHub exposes, and usually gets all-or-nothing repo access.

## Current Scope

In scope:

- Explicit user-selected folder exposure.
- Native Obsidian connector.
- Streamable HTTP server and stdio server modes.
- Optional tunnel startup for public HTTPS demos.
- Built-in pattern-based redactor plugin for configured regex matches.
- Token show and rotation commands.
- Version checks and diagnostics.
- Local bearer auth, Origin checks, env scrubbing, write gates, and audit logging.

Not in current v0:

- Native Postgres connector.
- Public relay or hosted remote access.
- Background daemon or PID file.
- File indexer, SQLite, FTS, or watcher.
- TLS on localhost.
- Per-client permissions.
- MCP resource or prompt proxying.
- Plugin marketplace or dynamic connector loading.
- Bundled third-party connector implementations.
- Importing existing MCP server configs from Claude Desktop, Claude Code, Cursor, or other clients.

## Contributing

Contributions are welcome while the project is early. Keep changes focused and security-conscious. Read [CONTRIBUTING.md](CONTRIBUTING.md) and report vulnerabilities through [SECURITY.md](SECURITY.md).

## Project Structure

```text
mvmt/
├── CHANGELOG.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE
├── SECURITY.md
├── .github/
│   ├── CODEOWNERS
│   └── workflows/ci.yml
├── bin/
│   └── mvmt.ts
├── docs/
│   ├── architecture.md
│   └── security-memo.md
├── src/
│   ├── index.ts
│   ├── cli/
│   │   ├── doctor.ts
│   │   ├── init.ts
│   │   ├── start.ts
│   │   └── token.ts
│   ├── config/
│   │   ├── loader.ts
│   │   └── schema.ts
│   ├── connectors/
│   │   ├── factory.ts
│   │   ├── obsidian.ts
│   │   ├── proxy-http.ts
│   │   ├── proxy-stdio.ts
│   │   └── types.ts
│   ├── server/
│   │   ├── index.ts
│   │   └── router.ts
│   ├── plugins/
│   │   ├── factory.ts
│   │   ├── pattern-redactor.ts
│   │   └── types.ts
│   └── utils/
│       ├── audit.ts
│       ├── logger.ts
│       ├── token.ts
│       ├── tunnel.ts
│       └── version.ts
├── tests/
├── fixtures/
└── package.json
```

## License

MIT
