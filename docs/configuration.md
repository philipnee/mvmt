# Configuration

mvmt stores its configuration at:

```text
~/.mvmt/config.yaml
```

The config controls the local mounts exposed to MCP clients, server access, per-client policy, and result plugins. On non-Windows systems, mvmt writes the config with mode `600`.

Use the CLI when possible:

```bash
mvmt config setup
mvmt mounts add
mvmt mounts edit
mvmt doctor
```

## Example

```yaml
version: 1

server:
  port: 4141
  allowedOrigins: []
  access: local

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
    description: mvmt source code and design docs.
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

clients:
  - id: codex
    name: Codex CLI
    auth:
      type: token
      tokenHash: "scrypt:v1:..."
    rawToolsEnabled: false
    permissions:
      - path: /workspace/**
        actions: [search, read, write]
      - path: /notes/**
        actions: [search, read]

plugins:
  - name: pattern-redactor
    enabled: true
    mode: redact
```

## `version`

Always `1`.

## `server`

| Field | Default | Description |
| --- | --- | --- |
| `port` | `4141` | HTTP port for Streamable HTTP MCP clients. |
| `allowedOrigins` | `[]` | Extra browser origins allowed through the Origin guard. Localhost origins are always allowed. |
| `access` | `local` | `local` binds to `127.0.0.1`. `tunnel` starts the configured tunnel process. |
| `tunnel` | none | Required when `access: tunnel`. |

Tunnel example:

```yaml
server:
  port: 4141
  access: tunnel
  tunnel:
    provider: cloudflare-quick
    command: cloudflared tunnel --url http://127.0.0.1:{port}
```

Stable tunnel example:

```yaml
server:
  port: 4141
  access: tunnel
  tunnel:
    provider: custom
    command: cloudflared tunnel --config /Users/you/.cloudflared/mvmt.yml run
    url: https://mvmt.example.com
```

## `mounts`

`mounts[]` is the active data-plane config. Each mount maps a virtual path to a local folder.

Clients use virtual paths such as `/notes/today.md`. They do not see the host path such as `/Users/you/Documents/Obsidian/today.md`.

| Field | Default | Description |
| --- | --- | --- |
| `name` | none | Stable lowercase mount id. |
| `type` | `local_folder` | Current shipped provider. |
| `path` | none | Virtual path visible to clients, such as `/notes`. Cannot be `/`. |
| `root` | none | Local folder on disk. `~` is expanded at runtime. |
| `description` | `""` | Short text returned by `list("/")`. |
| `guidance` | `""` | Optional client-facing guidance returned by `list("/")`. |
| `exclude` | `.git/**`, `node_modules/**`, `.claude/**` | Paths hidden from listing, reads, writes, removal, and indexing. |
| `protect` | `.env`, `.env.*`, `.claude/**` | Paths that cannot be written or removed. |
| `writeAccess` | `false` | Mount-level write gate. |
| `enabled` | `true` | Disabled mounts are ignored at runtime. |

An Obsidian vault is just a local folder mount. There is no special Obsidian runtime connector in the current mount-only shape.

## `clients`

`clients[]` is optional and is managed for token clients by `mvmt tokens add`.
The field name is internal config terminology; the CLI calls these API tokens.

If absent, mvmt keeps legacy local behavior: the session bearer token from
`mvmt token` can access all configured mounts. In tunnel mode, the legacy
session token is rejected unless `MVMT_ALLOW_LEGACY_TUNNEL=1` is set.

If present, `/mcp` becomes strict:

- bearer tokens must match a configured client `tokenHash`;
- OAuth access tokens must map to a configured OAuth client id;
- the session token no longer grants data-plane access;
- unknown OAuth clients are quarantined with zero permissions.

| Field | Description |
| --- | --- |
| `id` | Stable client id used in audit entries. Lowercase letters, numbers, `_`, and `-`. |
| `name` | Human-readable client name. |
| `auth.type` | `token` or `oauth`. |
| `auth.tokenHash` | Verifier for the client bearer token. New tokens use scrypt. Plaintext tokens are not stored. |
| `auth.oauthClientIds` | OAuth `client_id` values mapped to this client. |
| `rawToolsEnabled` | Legacy field. The mount-only runtime ignores raw proxy tools. Keep `false`. |
| `permissions` | Virtual path/action grants. |

Permission actions are:

| Action | Allows |
| --- | --- |
| `search` | `search` over indexed text chunks. |
| `read` | `list` and `read`. |
| `write` | `write` and `remove`, only when the mount also has `writeAccess: true`. |

Examples:

```yaml
permissions:
  - path: /notes/**
    actions: [search, read]
  - path: /workspace/**
    actions: [search, read, write]
```

Use `/**` as a global grant only for trusted clients:

```yaml
permissions:
  - path: /**
    actions: [search, read, write]
```

## `plugins`

The only built-in plugin is `pattern-redactor`.

```yaml
plugins:
  - name: pattern-redactor
    enabled: true
    mode: redact
```

Modes:

| Mode | Behavior |
| --- | --- |
| `warn` | Records matches but returns the original result. |
| `redact` | Replaces matches with configured replacement strings. |
| `block` | Blocks the entire result. |

The default patterns cover common API-key shapes. Pattern redaction is defense in depth, not the primary permission model.

## Legacy Fields

The schema still accepts older `proxy`, `source`, and `semanticTools` fields for compatibility with existing configs and older branches.

The current mount-only CLI runtime does not load proxy connectors as user-facing tools. Prefer `mounts[]` for new config.
