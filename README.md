# (mvmt) Multi-Volume Mount Transport

**One permissioned namespace for agent context.**

mvmt is a local-first MCP server that mounts selected data into one virtual
namespace for AI agents. Today those mounts are local folders. The same shape is
intended to extend to other volumes, storage backends, and remote mvmt
instances.

Agents call stable tools against paths such as `/notes`, `/workspace`, or
eventually `/desktop/projects`; they do not get full-computer access. mvmt
resolves the path, checks the client's permissions, and routes the allowed
operation to the right mount.

mvmt is federated access, not sync. Data stays where it lives.

- **One namespace, many volumes** - expose selected mounts through one endpoint.
- **Five stable tools** - `search`, `list`, `read`, `write`, and `remove`.
- **Read-only by default** - writes require both mount-level write access and
  client-level `write` permission.
- **Per-client policy** - bind different API keys or OAuth clients to different
  path/action permissions.
- **Agent context per mount** - descriptions and guidance are returned from
  `list("/")` so agents know what each mounted folder is for.
- **Tunnel-ready** - expose the same endpoint to web clients over HTTPS with
  OAuth/PKCE.

> [!WARNING]
> Tunnel mode exposes your configured mvmt endpoint beyond your machine. Keep
> mounts narrow, keep writes disabled unless needed, and use per-client policy
> before giving remote clients access.

![mvmt running in interactive mode](docs/assets/mvmt-start-interactive.png)

## Quick Start

```bash
npm install -g mvmt
mvmt serve -i
```

On first run, `mvmt serve` creates `~/.mvmt/config.yaml`, asks which local
folders to mount, optionally enables the pattern redactor, then starts the MCP
server.

For a one-off read-only folder without changing the saved config:

```bash
mvmt serve --path ~/Documents -i
```

For an existing config, add or edit mounts directly:

```bash
mvmt mounts add notes ~/Documents/Obsidian --mount-path /notes --read-only \
  --description "Personal notes and project journals" \
  --guidance "Search first. Read specific files before answering."

mvmt mounts add workspace ~/code/mvmt --mount-path /workspace --write \
  --protect ".env" \
  --protect ".env.*" \
  --protect ".claude/**"

mvmt mounts list
mvmt reindex
mvmt serve -i
```

At least one enabled mount is required. If no mounts are configured, mvmt has no
data to serve.

## Status

| Area | Status |
| --- | --- |
| Local folder mounts | supported |
| Text index | supported as a JSON prototype index beside the config file |
| MCP tools | `search`, `list`, `read`, `write`, `remove` |
| Mount management CLI | `mvmt mounts add/edit/remove/list` |
| Per-client path permissions | supported via `clients[]` config |
| Local Streamable HTTP | supported on `127.0.0.1` |
| Stdio mode | supported for clients that launch mvmt directly |
| OAuth/PKCE for web clients | supported, including Dynamic Client Registration |
| Tunnel mode | supported for personal remote access |
| Pattern redactor plugin | supported and opt-in during setup |
| Legacy proxy connectors | accepted by the schema for compatibility, ignored by the mount-only CLI runtime |
| Admin UI and managed key issuance | not shipped |
| Remote/federated mvmt mounts | not shipped |
| Binary/PDF/image indexing | not shipped |

## Client Compatibility

| Client | Transport | Status | Auth method | Notes |
| --- | --- | --- | --- | --- |
| Claude Desktop | stdio | supported | process launch | Runs its own mvmt process from the client config |
| Claude Code | Streamable HTTP | supported | bearer token | Update the client after `mvmt token rotate` |
| Codex CLI | Streamable HTTP | supported | bearer token | Start Codex with the token available to the client |
| Cursor | Streamable HTTP | expected | bearer token | Behavior depends on Cursor's MCP implementation |
| VS Code / Copilot | Streamable HTTP | expected | bearer token | Behavior depends on the MCP extension |
| claude.ai / ChatGPT web | public HTTPS tunnel | supported remote mode | OAuth/PKCE | Requires a reachable tunnel URL |
| Raw HTTP/curl | Streamable HTTP | debug only | bearer token | Must follow MCP session initialization rules |

Most HTTP clients need:

- **URL**: `http://127.0.0.1:4141/mcp`
- **Authorization header**: `Bearer <token from mvmt token>`

Remote web clients use the tunnel URL, usually ending in `/mcp`, and authorize
through OAuth 2.1 + PKCE. mvmt supports RFC 7591 Dynamic Client Registration.
Issued OAuth access tokens are audience-bound to the current mvmt resource, so a
token minted for one mvmt instance cannot be replayed against another.

Claude Desktop is different: it launches mvmt over stdio, so there is no HTTP
listener and no bearer token header.

## Tool Surface

When `mounts[]` is configured, mvmt exposes these MCP tools:

| Tool | Purpose | Permission |
| --- | --- | --- |
| `search` | Search indexed text chunks across permitted mounts | `search` |
| `list` | List permitted mount roots or a directory within one mount | `read` |
| `read` | Read one text file by virtual path | `read` |
| `write` | Create or overwrite one text file | `write` |
| `remove` | Delete one text file | `write` |

Important behavior:

- `list("/")` returns each visible mount root with its description, guidance,
  and write-access flag.
- `search` uses keyword scoring over indexed text chunks. It is intentionally
  simple today.
- `read` and `write` are text-only.
- `write` accepts `expected_hash` so clients can reject stale writes after a
  previous `read`.
- `remove` deletes files permanently. It does not remove directories.
- Non-text files are hidden from `list`, skipped by indexing, and rejected by
  `read`/`write`.

Supported text-like files include Markdown, plain text, JSON, YAML, TOML, CSV,
logs, shell scripts, HTML/CSS/XML, and common source-code extensions. Files over
2 MiB are skipped by the index and rejected as direct text reads.

## Configuration

The saved config lives at `~/.mvmt/config.yaml`. You can inspect it with
`mvmt config`, validate it with `mvmt doctor`, and update mounts with
`mvmt mounts ...`.

Minimal mount-based config:

```yaml
version: 1

server:
  port: 4141
  allowedOrigins: []
  access: local

proxy: []

mounts:
  - name: notes
    type: local_folder
    path: /notes
    root: /Users/you/Documents/Obsidian
    description: Personal notes and project journals.
    guidance: Search first. Read specific files before answering.
    exclude:
      - .git/**
      - node_modules/**
      - .claude/**
    protect:
      - .env
      - .env.*
      - .claude/**
    writeAccess: false
    enabled: true

  - name: workspace
    type: local_folder
    path: /workspace
    root: /Users/you/code/mvmt
    description: mvmt project source and design docs.
    guidance: Read README.md and docs before changing code.
    exclude:
      - .git/**
      - node_modules/**
      - dist/**
    protect:
      - .env
      - .env.*
      - .claude/**
    writeAccess: true
    enabled: true

plugins:
  - name: pattern-redactor
    enabled: true
    mode: redact
```

Mount fields:

| Field | Meaning |
| --- | --- |
| `name` | Stable lowercase mount id, such as `notes` |
| `path` | Virtual path visible to agents, such as `/notes` |
| `root` | Local folder on disk |
| `description` | Short summary returned from `list("/")` |
| `guidance` | Human-authored instructions returned from `list("/")` |
| `exclude` | Glob-like paths hidden from listing, reads, writes, and indexing |
| `protect` | Glob-like paths that cannot be written or removed |
| `writeAccess` | Mount-level write gate; defaults to `false` |
| `enabled` | Whether the mount is active |

An Obsidian vault is just a local folder mount. There is no special Obsidian
runtime connector in the current mount-only shape.

## Per-Client Policy

If `clients[]` is absent, mvmt keeps legacy behavior: the session bearer token
from `mvmt token` can access all configured mounts.

Once `clients[]` is present, `/mcp` becomes strict:

- bearer tokens must match a configured client `tokenHash`;
- OAuth access tokens must map to a configured OAuth client id;
- the session token no longer grants data-plane access;
- unknown OAuth clients are quarantined with zero permissions.

Client permissions are written against virtual mount paths, not local disk
paths:

```yaml
clients:
  - id: codex
    name: Codex CLI
    auth:
      type: token
      # SHA-256 hex of the client API key. Do not store the plaintext key.
      tokenHash: "0000000000000000000000000000000000000000000000000000000000000000"
    rawToolsEnabled: false
    permissions:
      - path: /workspace/**
        actions: [search, read, write]
      - path: /notes/**
        actions: [search, read]

  - id: chatgpt
    name: ChatGPT
    auth:
      type: oauth
      oauthClientIds:
        - chatgpt-mvmt
    rawToolsEnabled: false
    permissions:
      - path: /notes/**
        actions: [search, read]
```

Policy is additive. A call succeeds only when the resolved client has the
required action for the target virtual path. For writes, the mount itself must
also have `writeAccess: true`, and the target must not match `protect`.

Managed client-token creation is not shipped yet, so `clients[]` is currently a
manual config feature.

## Commands

| Command | Description |
| --- | --- |
| `mvmt serve` | Configure mvmt if needed, then start the MCP server |
| `mvmt serve -i` | Start with an interactive control prompt |
| `mvmt serve --path <dir>` | Temporarily serve one read-only folder without changing saved config |
| `mvmt reindex` | Force a full rebuild of the text index |
| `mvmt mounts` | List configured mounts |
| `mvmt mounts add [name] [root]` | Add a local folder mount |
| `mvmt mounts edit [name]` | Edit a mount |
| `mvmt mounts remove [name]` | Remove a mount |
| `mvmt config` | Show the saved config summary |
| `mvmt config setup` | Rerun guided setup and save config |
| `mvmt doctor` | Validate config and startup prerequisites |
| `mvmt token` | Show the current session bearer token and age |
| `mvmt token rotate` | Regenerate the session bearer token |
| `mvmt tunnel` | Show tunnel status |
| `mvmt tunnel config` | Choose a tunnel command and save it |
| `mvmt tunnel start` | Start the configured tunnel for the running mvmt process |
| `mvmt tunnel refresh` | Restart the configured tunnel and print the new URL |
| `mvmt tunnel stop` | Stop public tunnel exposure without stopping mvmt |
| `mvmt tunnel logs` | Show recent tunnel output |
| `mvmt tunnel logs stream` | Stream live tunnel output |
| `mvmt --version` | Print version and check for updates |

Interactive mode (`mvmt serve -i`) accepts the same command groups:

```text
> mounts
> mounts add
> mounts edit
> mounts remove

> config
> config setup

> token
> token rotate

> tunnel
> tunnel refresh
```

## Index Lifecycle

On `mvmt serve`, mvmt starts serving immediately and rebuilds the text index in
the background. Calls may return fewer search results until that rebuild
finishes.

Use `mvmt reindex` after changing files outside mvmt or after editing mount
configuration. Writes and removes performed through mvmt rebuild the index
automatically.

The current index is a JSON file beside the config file. SQLite and incremental
watching are planned, but not shipped.

## Security Model

Every data operation is gated by path and action.

- HTTP mode binds to `127.0.0.1`, not `0.0.0.0`.
- HTTP `/mcp` and `/health` require authentication.
- The session token is stored at `~/.mvmt/.session-token` with mode `600` and
  rotates with `mvmt token rotate`.
- Mount roots are resolved before access, and path traversal outside the mount
  root is rejected.
- `exclude` hides paths from listing, reading, writing, removal, and indexing.
- `protect` blocks write/remove for sensitive paths such as `.env` and
  `.claude/**`.
- Write operations require client `write` permission and mount `writeAccess`.
- Per-client policy quarantines unknown OAuth clients once `clients[]` exists.
- Browser-origin checks block drive-by browser requests from non-local origins.
- Optional pattern redactor can warn, redact, or block configured regex matches
  before tool output reaches clients.
- Tool calls are appended to `~/.mvmt/audit.log`.

Authentication controls who connects. Mounts and client policy control what they
can access.

## Remote Access

mvmt is local-first. Cloud clients such as ChatGPT and claude.ai cannot reach
`127.0.0.1` directly, so tunnel mode can publish a public HTTPS URL.

Remote access checklist:

1. Mount only the folders the remote client needs.
2. Prefer read-only mounts.
3. Configure `clients[]` before exposing a tunnel.
4. Use `protect` for secrets and agent-private folders.
5. Watch `~/.mvmt/audit.log` when testing a new remote client.

Quick tunnels are convenient but temporary. For repeatable remote OAuth flows,
use a stable tunnel URL.

## Current Limits

- The active CLI runtime is mount-only. Legacy proxy connector config still
  parses, but proxy connectors are not loaded as runtime tools.
- Local folders are the only shipped mount provider.
- The index supports text-like files only. PDFs, images, archives, and other
  binary files are skipped.
- Search is prototype keyword scoring, not semantic embedding search.
- There is no file watcher yet.
- Managed client-key issuance and an admin UI are not shipped.
- Remote/federated mvmt mounts are planned, but not shipped.
- mvmt does not sync, replicate, or resolve conflicts across machines.

## Coming Next

- SQLite-backed text index with incremental updates.
- Better mount and client management commands.
- Admin UI for client keys, path permissions, audit, and mount visibility.
- Remote mvmt mounts: one entrypoint namespace over multiple mvmt instances.
- More storage providers behind the same `search`/`list`/`read`/`write`/`remove`
  surface.

## Project Docs

- [Setup guide](docs/setup.md)
- [Client setup](docs/client-setup.md)
- [Text index prototype](docs/text-index-prototype.md)
- [Remote access](docs/remote-access.md)
- [Audit log](docs/audit-log.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture](docs/architecture.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Contributing

Contributions are welcome while the project is early. Keep changes focused and
security-conscious. Read [CONTRIBUTING.md](CONTRIBUTING.md) and report
vulnerabilities through [SECURITY.md](SECURITY.md).

## License

MIT
