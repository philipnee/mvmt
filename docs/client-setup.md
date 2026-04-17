# Client Setup

All clients connect to the same mvmt endpoint. Start mvmt first, then get your token:

```bash
mvmt start
mvmt show
```

Or `token show` in interactive mode.

Most MCP clients let you add servers through their settings UI. You only need two pieces of information:

- **URL**: `http://127.0.0.1:4141/mcp`
- **Authorization header**: `Bearer <token from mvmt show>`

Stdio mode (Claude Desktop) is the exception — it launches mvmt directly and does not need a token.

## Claude Desktop

Claude Desktop uses stdio mode, so it launches mvmt as a child process. No token is needed.

**Via UI**: Open Claude Desktop Settings > MCP Servers > Add. Set the command to `mvmt` and the arguments to `start --stdio`.

**Via JSON config** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

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

## Claude Code

```bash
mvmt start
claude mcp add --transport http \
  --header "Authorization: Bearer $(mvmt show)" \
  mvmt http://127.0.0.1:4141/mcp
```

If mvmt restarts, it generates a new token. Update the client token after each restart.

## Codex CLI

Codex stores a bearer-token environment variable name, not the token value itself:

```bash
export MVMT_TOKEN="$(mvmt show)"
codex mcp add mvmt \
  --url http://127.0.0.1:4141/mcp \
  --bearer-token-env-var MVMT_TOKEN
```

Start new Codex sessions from a shell where `MVMT_TOKEN` is set:

```bash
MVMT_TOKEN="$(mvmt show)" codex
```

## Cursor

**Via UI**: Open Cursor Settings > MCP > Add new MCP server. Set the URL to `http://127.0.0.1:4141/mcp` and add the authorization header with your token.

**Via JSON config** (`.cursor/mcp.json` in your project, or through Cursor's global MCP settings):

```json
{
  "mcpServers": {
    "mvmt": {
      "url": "http://127.0.0.1:4141/mcp",
      "headers": {
        "Authorization": "Bearer <paste token from mvmt show>"
      }
    }
  }
}
```

## VS Code / Copilot

**Via UI**: Open the Command Palette (`Cmd+Shift+P`) > `MCP: Add Server`. Choose HTTP, enter the URL `http://127.0.0.1:4141/mcp`, and set the authorization header with your token.

**Via JSON config** (`.vscode/mcp.json`):

```json
{
  "mcpServers": {
    "mvmt": {
      "url": "http://127.0.0.1:4141/mcp",
      "headers": {
        "Authorization": "Bearer <paste token from mvmt show>"
      }
    }
  }
}
```

## Raw HTTP / curl

Direct `curl` is useful for debugging, but MCP Streamable HTTP is session-based. Initialize first, capture the `mcp-session-id` response header, then make later requests with that session ID.

```bash
TOKEN="$(mvmt show)"

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
