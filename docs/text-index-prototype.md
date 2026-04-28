# Text Index Prototype

This branch prototypes a simpler mvmt product shape:

```text
permissioned folder sources -> local text index -> five MCP tools
```

It intentionally supports text-like files only. Markdown and plain text are the primary targets. Binary files such as PDFs and images are skipped.

## Config

Add folder sources to `~/.mvmt/config.yaml`:

```yaml
sources:
  - id: workspace
    type: folder
    path: /Users/you/code/mvmt
    exclude:
      - .git/**
      - node_modules/**
      - .claude/**
    protect:
      - .claude/**
      - .env
    writeAccess: true
    enabled: true
```

Client policy uses the same `clients[]` model:

```yaml
clients:
  - id: codex
    name: Codex CLI
    auth:
      type: token
      tokenHash: "..."
    rawToolsEnabled: false
    permissions:
      - sourceId: workspace
        actions: [search, read, write]
```

## Tool Surface

When `sources[]` is configured, mvmt exposes:

| Tool | Purpose | Permission |
| --- | --- | --- |
| `search` | Search indexed text chunks | `search` |
| `list` | List permitted source roots or directories | `read` |
| `read` | Read one text file | `read` |
| `write` | Create or overwrite one text file | `write` |
| `delete` | Delete one text file | `write` |

`write` accepts `expected_hash` to reject stale writes after a previous `read`.

## Index Lifecycle

On `mvmt serve`, mvmt starts serving immediately and rebuilds the text index in the background.

Force a rebuild:

```bash
mvmt reindex
```

The current prototype stores the index as JSON beside the config file. The module boundary is isolated so this can be replaced with SQLite after choosing a dependency.

## Current Limits

- No SQLite dependency yet.
- No file watcher yet.
- Text-like extensions only.
- Deletes are permanent file deletes in this prototype.
- Existing connector/raw-tool behavior remains available on this branch for comparison.
