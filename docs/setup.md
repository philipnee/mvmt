# Setup Guide

This guide covers the full path from install to a working MCP client. The README keeps the short path; this page has the details.

## Requirements

- Node.js 20 or newer.
- npm.
- Optional: Obsidian, if you want vault access.
- Optional: MemPalace already installed and configured, if you want memory palace access.
- Optional: `cloudflared`, if you want Cloudflare Tunnel.

## Install

### From npm

```bash
npm install -g mvmt
mvmt --version
```

### From source

Use this while developing mvmt or testing a feature branch:

```bash
git clone https://github.com/philipnee/mvmt.git
cd mvmt
npm install
npm run build
npm link
mvmt --version
```

`npm run build` restores executable permission on `dist/bin/mvmt.js`. If `mvmt` ever says `permission denied`, rebuild and relink:

```bash
npm run build
npm link
hash -r
mvmt --version
```

## Configure Local Sources

Run:

```bash
mvmt init
```

The wizard asks what local data mvmt is allowed to expose:

- Filesystem folders: exact folders only, read-only by default.
- Obsidian: one vault path, read-only by default.
- MemPalace: one palace path through the local MemPalace MCP server, read-only by default.
- Pattern-based redactor plugin: optional best-effort regex redaction.
- Access mode: local only or tunnel.

The config is written to:

```text
~/.mvmt/config.yaml
```

On macOS/Linux it is written with mode `600`.

## MemPalace Setup

mvmt does not install MemPalace or manage Python versions. It assumes MemPalace is already installed locally.

During `mvmt init`, mvmt tries to detect:

- the `mempalace` executable on `PATH`,
- the Python executable from that script's shebang,
- the palace path from `~/.mempalace/config.json`.

You can add MemPalace later without regenerating the whole config:

```bash
mvmt connectors list
mvmt connectors add mempalace
```

Then restart mvmt.

With MemPalace write access disabled, mvmt hides known write tools such as drawer writes, knowledge graph mutation, tunnel mutation, diary writes, and hook settings. With write access enabled, those tools are visible to clients.

## Start mvmt

Interactive mode is easiest while testing:

```bash
mvmt start -i
```

HTTP mode listens on:

```text
http://127.0.0.1:4141/mcp
```

The bearer token changes on every `mvmt start`. Show the current token with:

```bash
mvmt show
```

Rotate it without restarting:

```bash
mvmt rotate
```

## Connect Codex CLI

Codex stores the name of an environment variable, not the token value.

Add mvmt once:

```bash
codex mcp add mvmt \
  --url http://127.0.0.1:4141/mcp \
  --bearer-token-env-var MVMT_TOKEN
```

Before starting Codex, export the current token:

```bash
export MVMT_TOKEN="$(mvmt show)"
codex
```

If you restart mvmt, export the token again and restart Codex:

```bash
export MVMT_TOKEN="$(mvmt show)"
codex resume
```

Do not run `codex mcp login mvmt` for this local bearer-token setup. If Codex says:

```text
The mvmt MCP server is not logged in. Run `codex mcp login mvmt`.
```

it usually means `MVMT_TOKEN` is missing or stale in the shell that launched Codex.

Check the configured entry:

```bash
codex mcp get mvmt
```

It should show:

```text
transport: streamable_http
url: http://127.0.0.1:4141/mcp
bearer_token_env_var: MVMT_TOKEN
```

## Connect Other Clients

Most HTTP clients need:

- URL: `http://127.0.0.1:4141/mcp`
- Header: `Authorization: Bearer <token from mvmt show>`

Claude Desktop is different: use stdio mode so Claude launches mvmt directly:

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

See [Client Setup](client-setup.md) for Claude Desktop, Claude Code, Codex CLI, Cursor, VS Code, and raw HTTP examples.

## Verify

Check server health:

```bash
TOKEN="$(mvmt show)"
curl -i http://127.0.0.1:4141/health \
  -H "Authorization: Bearer $TOKEN"
```

Expected:

```json
{"status":"ok","tools":34}
```

The exact tool count depends on enabled connectors.

In Codex, `/mcp list` should show tools such as:

```text
obsidian__search_notes
proxy_mempalace__mempalace_status
proxy_mempalace__mempalace_search
```

## Common Problems

### `Tools: (none)`

Usually one of these:

- mvmt was still starting when the client connected.
- The client has a stale token.
- The client cached a failed tool-list response.
- Another old mvmt process is still using port `4141`.

Fix:

```bash
mvmt doctor
export MVMT_TOKEN="$(mvmt show)"
```

Then restart the MCP client.

### Port 4141 is already in use

Find the process:

```bash
lsof -nP -iTCP:4141
```

Stop the old mvmt process or start on another port:

```bash
mvmt start -i --port 4142
```

### Token works in curl but not Codex

Codex only sees environment variables from the shell that launched it. Re-export and restart Codex:

```bash
export MVMT_TOKEN="$(mvmt show)"
codex
```

### MemPalace does not show up

Check config:

```bash
mvmt connectors list
mvmt doctor
```

If MemPalace is missing:

```bash
mvmt connectors add mempalace
mvmt start -i
```

If it fails to start, verify the configured Python can import MemPalace:

```bash
/path/to/python -m mempalace.mcp_server --palace ~/.mempalace/palace
```

Stop that manual server after testing; mvmt starts its own child process.
