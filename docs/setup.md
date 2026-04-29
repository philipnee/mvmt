# Setup Guide

This guide covers install, mount setup, server startup, and client connection.

## Requirements

- Node.js 20 or newer.
- npm.
- Optional: `cloudflared` or another tunnel command for remote web clients.

## Install

From this source checkout:

```bash
npm install
npm run build
npm link
mvmt --version
```

The current npm package named `mvmt` is not this CLI release yet. If
`npm install -g mvmt` leaves you with `zsh: command not found: mvmt`, use the
source install above.

## Configure Mounts

Run guided setup:

```bash
mvmt config setup
```

Or add mounts directly:

```bash
mvmt mounts add notes ~/Documents/Obsidian \
  --mount-path /notes \
  --read-only \
  --description "Personal notes and project journals" \
  --guidance "Search first. Read specific files before answering."
```

```bash
mvmt mounts add workspace ~/code/mvmt \
  --mount-path /workspace \
  --write \
  --protect ".env" \
  --protect ".env.*" \
  --protect ".claude/**" \
  --description "mvmt source code and design docs" \
  --guidance "Read README.md and docs before changing code."
```

The config is written to:

```text
~/.mvmt/config.yaml
```

At least one enabled mount is required. If there are no mounts, mvmt has no data to serve.

## Start mvmt

Interactive mode is easiest while testing:

```bash
mvmt serve -i
```

HTTP mode listens on:

```text
http://127.0.0.1:4141/mcp
```

For a one-off read-only folder without changing saved config:

```bash
mvmt serve --path ~/Documents -i
```

When adding a mount:

- **Folder on this computer** is the real local folder. It must already exist.
- **Virtual path clients will use** is the mvmt path, such as `/notes` or
  `/workspace`.

## Token

Show the current session bearer token. If the token file does not exist yet,
this command creates it.

```bash
mvmt token
```

Print only the raw token:

```bash
mvmt token show
```

Rotate it:

```bash
mvmt token rotate
```

If a client uses the old token, restart or update that client after rotation.

The session token is stored as a plaintext bearer token at
`~/.mvmt/.session-token` with file mode `600`. HTTP `mvmt serve` also creates it
automatically during startup.

## Rebuild the Index

Search uses the text index. mvmt rebuilds it in the background on startup.

Force a rebuild:

```bash
mvmt reindex
```

Use this after adding a mount or changing files outside mvmt.

## Connect Codex CLI

Codex stores the name of an environment variable, not the token value.

```bash
codex mcp add mvmt \
  --url http://127.0.0.1:4141/mcp \
  --bearer-token-env-var MVMT_TOKEN
```

Before starting Codex:

```bash
export MVMT_TOKEN="$(mvmt token show)"
codex
```

If you rotate the token:

```bash
export MVMT_TOKEN="$(mvmt token show)"
codex resume
```

Do not run `codex mcp login mvmt` for the local bearer-token setup. If Codex asks for login, the usual cause is a missing or stale `MVMT_TOKEN`.

## Connect Other Clients

Most local HTTP clients need:

```text
URL: http://127.0.0.1:4141/mcp
Authorization: Bearer <token>
```

Claude Desktop is different because it can launch mvmt over stdio:

```json
{
  "mcpServers": {
    "mvmt": {
      "command": "mvmt",
      "args": ["serve", "--stdio"]
    }
  }
}
```

See [Client Setup](client-setup.md) for more examples.

## Verify

Check server health:

```bash
TOKEN="$(mvmt token show)"
curl -i http://127.0.0.1:4141/health \
  -H "Authorization: Bearer $TOKEN"
```

Expected:

```json
{"status":"ok","tools":5}
```

In an MCP client, the normal mount tools are:

```text
search
list
read
write
remove
```

The exact list depends on client permissions.

## Common Problems

### `No mounts loaded. Nothing to serve.`

In an interactive terminal, `mvmt serve` will offer to add a mount before
starting. In scripts or CI, add at least one mount explicitly:

```bash
mvmt mounts add workspace ~/code/mvmt --mount-path /workspace --read-only
mvmt serve -i
```

### `Tools: (none)`

Usually one of these:

- no enabled mounts exist;
- the client has a stale token;
- the client is mapped to a policy with no matching permissions;
- the client cached a failed tool-list response.

Run:

```bash
mvmt doctor
mvmt mounts list
export MVMT_TOKEN="$(mvmt token show)"
```

Then restart the MCP client.

### Port `4141` is already in use

Start on another port:

```bash
mvmt serve -i --port 4142
```

### Token works in curl but not Codex

Codex only sees environment variables from the shell that launched it.

```bash
export MVMT_TOKEN="$(mvmt token show)"
codex
```
