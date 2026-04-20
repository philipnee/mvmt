# Configuration

mvmt stores its configuration at `~/.mvmt/config.yaml`. This file is created by `mvmt init` and controls which data sources are exposed, how the server runs, and what security plugins are active. You should not need to write this file by hand — `mvmt init` walks you through every option.

On non-Windows systems, the config file is written with mode `600` (owner-only read/write).

## Full example

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

  - name: mempalace
    source: mempalace
    transport: stdio
    command: /Users/you/.local/pipx/venvs/mempalace/bin/python
    args:
      - -m
      - mempalace.mcp_server
      - --palace
      - /Users/you/.mempalace/palace
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

## Sections

### `version`

Always `1`. This field exists so mvmt can detect and migrate config files if the schema changes in a future release.

### `server`

Controls the HTTP server that MCP clients connect to.

| Field | Default | Description |
| --- | --- | --- |
| `port` | `4141` | Port the HTTP server listens on. Must be `1..65535`. |
| `allowedOrigins` | `[]` | Extra origins allowed past the origin check. Localhost origins are always allowed. Browser requests from unlisted remote origins are rejected. |
| `access` | `local` | `local` binds to `127.0.0.1` only. `tunnel` also starts a tunnel process for public HTTPS access. |
| `tunnel` | — | Required when `access` is `tunnel`. See tunnel config below. |

### `server.tunnel`

Configures the tunnel process that mvmt starts alongside the HTTP server when `access` is `tunnel`.

| Field | Required | Description |
| --- | --- | --- |
| `provider` | yes | `cloudflare-quick` or `localhost-run`. `mvmt init` offers these two. The schema also accepts `pinggy` and `custom` for manual configs, but those are not part of the guided v0 flow. |
| `command` | yes | Shell command to start the tunnel. Use `{port}` as a placeholder for the mvmt port. |
| `url` | no | Set this if your tunnel has a stable URL that it does not print on startup. mvmt uses it to display the public MCP URL. |

Example:

```yaml
server:
  port: 4141
  allowedOrigins: []
  access: tunnel
  tunnel:
    provider: cloudflare-quick
    command: cloudflared tunnel --url http://127.0.0.1:{port}
```

### `proxy`

A list of external MCP servers that mvmt proxies. Each entry launches a child process (stdio) or connects to an existing server (http) and exposes its tools through mvmt.

`mvmt init` creates proxy entries when you choose to expose filesystem folders or enable MemPalace. You can also add entries by hand for other MCP servers.

| Field | Default | Description |
| --- | --- | --- |
| `name` | — | Identifier used in tool namespacing (e.g. `proxy_filesystem__read_file`). |
| `source` | — | Optional label for where this entry came from (e.g. `manual`). |
| `transport` | `stdio` | `stdio` spawns a child process. `http` connects to an existing HTTP MCP server. |
| `command` | — | Required for `stdio`. The command to run. |
| `args` | `[]` | Arguments passed to the command. |
| `url` | — | Required for `http`. The URL of the upstream MCP server. |
| `env` | `{}` | Environment variables passed to the child process. Parent-process env vars are scrubbed — only an allowlist plus these values are forwarded. |
| `writeAccess` | `false` | When `false`, mvmt hides write-like tools from `listTools` and rejects them at `callTool`. |
| `enabled` | `true` | Set to `false` to skip this connector without removing it from config. |

Schema rules:
- `transport: stdio` requires `command`.
- `transport: http` requires `url`.

MemPalace is represented as a stdio proxy because mvmt launches its MCP server as a child process. `mvmt init` tries to detect the Python executable from the local `mempalace` command shebang and the palace path from `~/.mempalace/config.json`. With `writeAccess: false`, known MemPalace write tools are hidden and rejected.

### `obsidian`

Configures the native Obsidian vault connector. This connector reads markdown files directly — it does not spawn a child MCP process.

| Field | Default | Description |
| --- | --- | --- |
| `path` | — | Absolute path to your Obsidian vault. |
| `enabled` | `true` | Set to `false` to disable the connector. |
| `writeAccess` | `false` | When `true`, exposes `append_to_daily` for writing to daily notes. |

### `plugins`

A list of plugins that inspect or transform tool results before they reach MCP clients. Currently the only built-in plugin is `pattern-redactor`.

#### `pattern-redactor`

Scans text tool results with regex patterns and can warn, replace matches, or block the entire result.

| Field | Default | Description |
| --- | --- | --- |
| `name` | — | Must be `pattern-redactor`. |
| `enabled` | `true` | Set to `false` to disable the plugin. |
| `mode` | `redact` | `warn` passes output through with a warning. `redact` replaces matches. `block` blocks the whole result. |
| `maxBytes` | `1048576` | Maximum bytes scanned per text result. Must be `1024..10485760`. |
| `patterns` | (defaults) | List of regex patterns. Each has `name`, `regex`, `flags`, `replacement`, and `enabled`. |

The default patterns cover Anthropic keys, OpenAI keys, AWS access key IDs, GitHub tokens, Slack tokens, and JWT-looking strings. You can add your own patterns or disable defaults by editing this list.

## Editing the config

The config is a plain YAML file. You can edit it with any text editor:

```bash
$EDITOR ~/.mvmt/config.yaml
```

After editing, restart mvmt or use `mvmt doctor` to validate:

```bash
mvmt doctor
```

To regenerate the config from scratch, run `mvmt init` again. It will prompt before overwriting an existing config.
