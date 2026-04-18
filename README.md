# mvmt

mvmt is a local MCP server that sits between your data and your AI clients. You pick which folders, vaults, and tools are exposed. Everything else stays invisible.

- **One server, every client** — Claude, Cursor, Codex, VS Code, and any MCP-compatible tool connect to a single local endpoint.
- **Read-only by default** — write access is opt-in per connector. Nothing writes unless you said so.
- **Scoped, not open** — choose exact folders and Obsidian vaults. No full-disk access, no guessing.
- **Secure out of the box** — bearer-token auth, origin checks, environment scrubbing, audit log, and an optional pattern-based redactor for configured patterns.
- **Tunnel-ready** — expose mvmt to cloud clients like claude.ai over public HTTPS, with OAuth/PKCE for web clients.

> [!WARNING]
> Remote access is authenticated, but it still exposes your configured local tools beyond your machine. Keep connector scopes narrow before exposing mvmt over a tunnel.

![mvmt running in interactive mode](docs/assets/mvmt-start-interactive.png)

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

## Status

| Area | Status |
| --- | --- |
| Local filesystem folders | supported, read-only by default |
| Native Obsidian connector | supported, read-only by default |
| Local Streamable HTTP | supported |
| Stdio mode | supported |
| Interactive start mode | supported |
| Built-in pattern-based redactor plugin | supported, opt-in during `mvmt init` |
| Tunnel mode | supported for personal remote access; quick tunnel URLs are temporary |
| Managed remote relay / per-client remote access | not in v0 |
| HTTP proxy write gates | incomplete; advanced/manual config only |

## Client Compatibility

| Client | Transport | Status | Auth method | Known issues |
| --- | --- | --- | --- | --- |
| Claude Desktop | stdio | supported | process launch, no HTTP bearer token | Runs its own mvmt process per config |
| Claude Code | Streamable HTTP | supported | bearer token header | Token must be refreshed after `mvmt start` or `mvmt rotate` |
| Codex CLI | Streamable HTTP | supported | bearer token env var | Start Codex from a shell where the token env var is set |
| Cursor | Streamable HTTP | expected | bearer token header | Client behavior may vary by Cursor MCP version |
| VS Code / Copilot | Streamable HTTP | expected | bearer token header | Client behavior may vary by MCP extension/version |
| claude.ai / ChatGPT web | public HTTPS tunnel | supported remote mode | OAuth/PKCE over tunnel | Requires a public HTTPS URL; use a named tunnel for a stable URL |
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

- [Client setup](docs/client-setup.md)
- [Configuration](docs/configuration.md)
- [Connectors](docs/connectors.md)
- [Plugins](docs/plugins.md)
- [Remote access](docs/remote-access.md)
- [Audit log](docs/audit-log.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture](docs/architecture.md)
- [Security policy](SECURITY.md)
- [Security memo](docs/security-memo.md)
- [Personal memo](docs/personal-memo.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Client Setup

Most MCP clients let you add servers through their settings UI. You need two things:

- **URL**: `http://127.0.0.1:4141/mcp`
- **Authorization header**: `Bearer <token from mvmt show>`

Claude Desktop is the exception — it uses stdio mode and launches mvmt directly, so no token is needed.

See [Client Setup](docs/client-setup.md) for step-by-step instructions for Claude Desktop, Claude Code, Codex CLI, Cursor, VS Code, and raw HTTP.

## Configuration

`mvmt init` creates `~/.mvmt/config.yaml` with everything you selected during setup. The config controls four things:

- **`server`** — port, allowed origins, and whether to start a tunnel for public access.
- **`proxy`** — external MCP servers that mvmt proxies (e.g. the filesystem connector).
- **`obsidian`** — the native Obsidian vault connector.
- **`plugins`** — security plugins that inspect tool results before they reach clients (e.g. the pattern-based redactor).

You should not need to write this file by hand. To regenerate it, run `mvmt init` again. To validate it, run `mvmt doctor`.

See [Configuration](docs/configuration.md) for the full schema reference, field descriptions, and editing instructions.

## Commands

| Command | Description |
| --- | --- |
| `mvmt init` | Interactive setup wizard — choose folders, connectors, plugins, and access mode |
| `mvmt start` | Start the MCP server (HTTP by default, `--stdio` for direct client launch, `-i` for interactive) |
| `mvmt show` | Print the current HTTP bearer token |
| `mvmt rotate` | Generate a new bearer token and print it |
| `mvmt doctor` | Validate config and check connector health |
| `mvmt --version` | Print version and check for updates |

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
- Uses grouped commands for token, tunnel, and logs.
- Live logs show connector, tool name, argument keys, duration, and error state without printing full argument values.

Interactive command shape:

```text
> token
> token show
> token rotate

> tunnel
> tunnel show
> tunnel config
> tunnel start
> tunnel refresh
> tunnel stop
> tunnel logs

> logs
> logs show
> logs on
> logs off
```

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

### `mvmt show` / `mvmt rotate`

Manages the HTTP bearer token used by `/mcp` and `/health`.

```bash
mvmt show
mvmt rotate
```

`mvmt show` prints the current token without regenerating it. `mvmt rotate` writes a new token to `~/.mvmt/.session-token` and prints it. Running HTTP servers validate against the token file on each request, so rotation takes effect immediately. Any connected client that stored the old token must be updated.

`mvmt token show` and `mvmt token rotate` remain hidden compatibility aliases.

## Connectors

A connector is the code that gives mvmt access to one local data source or tool surface. It owns discovery, permissions, tool definitions, tool execution, and cleanup for that source.

mvmt currently ships two connectors. Both are read-only by default with opt-in write access.

**Obsidian** — native connector that reads markdown files directly from a vault. Tools: `search_notes`, `read_note`, `list_notes`, `list_tags`, and `append_to_daily` (write, opt-in). Path traversal is blocked; symlinks are skipped.

**Filesystem** — proxies the official `@modelcontextprotocol/server-filesystem` MCP server as a stdio child process. When `writeAccess: false`, mvmt hides write tools from `listTools` and rejects them at `callTool`.

Tools from all connectors are prefixed with the connector ID (e.g. `obsidian__search_notes`, `proxy_filesystem__read_file`) to avoid name collisions.

To add a native connector in v0, implement the `Connector` interface, add config schema for its scope, wire it into startup, and add tests for path/scope/write behavior. See [Connectors](docs/connectors.md) for the implementation checklist.

## Plugins

A plugin is a post-processing hook that runs after a connector returns a tool result and before that result is sent back to the MCP client. Plugins can inspect, annotate, transform, or block outbound tool results.

The built-in `pattern-redactor` plugin scans text tool results with regex patterns and can `warn`, `redact`, or `block` matches. Default patterns cover common API keys (OpenAI, Anthropic, AWS, GitHub, Slack) and JWT-looking strings.

> [!WARNING]
> This is a best-effort pattern matcher, not a security control. If data must not reach AI tools, scope the connector to exclude it.

To add a plugin in v0, implement the `ToolResultPlugin` interface, add config schema, register it in the plugin factory, and make audit events explicit when it changes output. See [Plugins](docs/plugins.md) for the implementation checklist.

## Security Model

Every file and data access in mvmt is gated. There is no open mode.

- **Localhost bind** — HTTP listens on `127.0.0.1` only.
- **Bearer token** — 256-bit, generated on each start, constant-time validation, rotatable without restart.
- **Origin allowlist** — browser requests from non-localhost origins are rejected unless explicitly allowed.
- **Environment scrubbing** — stdio child processes receive only an allowlist of env vars.
- **Write gates** — read-only by default per connector; write tools are hidden and rejected unless enabled.
- **Pattern redactor** — opt-in regex scrubbing of tool results before they reach clients.
- **Audit log** — every tool call appended to `~/.mvmt/audit.log` as JSONL with mode `600`.

Not yet enforced: TLS on localhost, per-client connector scoping, rate limiting, persistent OAuth client registry, token revocation, write gates for HTTP proxy connectors.

See [Security Memo](docs/security-memo.md) for design notes and [Audit Log](docs/audit-log.md) for log format and queries.

## Remote Access

mvmt is local-first. Cloud clients like claude.ai cannot reach `127.0.0.1` directly. `mvmt init` can configure a tunnel that gives you a public HTTPS URL.

Quick tunnels are temporary, which means you lose the URL when mvmt is shut down. Use a named tunnel or reserved domain to keep the same URL.

Recommended quick tunnel: Cloudflare. It has been more stable than `localhost.run`.

> [!WARNING]
> Remote web clients authorize with OAuth/PKCE. Direct HTTP clients use bearer tokens. Auth controls who connects; connector scope controls what they can access.

Remote access checklist:

- Use Cloudflare Tunnel when possible.
- Expose the smallest useful folder, vault, or connector scope.
- Keep write access disabled unless you explicitly need it.
- Do not expose secrets, credential folders, home directories, production databases, or browser profiles.
- Watch the audit log when using remote clients.
- Stop the tunnel when you are done with remote access.

See [Remote Access](docs/remote-access.md) for tunnel providers, runtime management, and safety guidelines.

## Troubleshooting

See [Troubleshooting](docs/troubleshooting.md) for common issues: port conflicts, connector failures, missing tools, vault detection, and token rejection.

## Coming Next

Planned work is focused on safer long-running use and better local data coverage:

- Fast file indexer with Chroma's embedded JS/TS version.
- Full key management: named keys, rotation, revocation, expiration.
- Per-client permissions and connector scoping.
- Runtime permission changes for folders, vaults, and connector write access.
- Remote access hardening guides for Cloudflare Named Tunnels, Cloudflare Access, and rate limiting.
- SQLite connector with per-table read/write permissions.
- Atomic writes and optional `--preview` mode.
- Git connector for local history, diffs, blame, and branch-aware search.

## Contributing

Contributions are welcome while the project is early. Keep changes focused and security-conscious. Read [CONTRIBUTING.md](CONTRIBUTING.md) and report vulnerabilities through [SECURITY.md](SECURITY.md).

## License

MIT
