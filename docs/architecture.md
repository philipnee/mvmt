# mvmt Architecture

mvmt is a local-first Multi-Volume Mount Transport. It exposes selected local folders through one permissioned MCP endpoint.

It is not sync, cloud storage, or a connector marketplace. Data stays where it lives. mvmt controls which mounted paths each client can search, list, read, write, or remove.

```text
                               LOCAL MACHINE
+--------------------------------------------------------------------------------+
|                                                                                |
|  ~/.mvmt/config.yaml                                                           |
|                                                                                |
|  mounts:                                                                       |
|    /notes      -> ~/Documents/Obsidian                                         |
|    /workspace  -> ~/code/mvmt                                                  |
|                                                                                |
|  clients:                                                                      |
|    codex can read/write /workspace                                             |
|    chatgpt can search/read /notes                                              |
|                                                                                |
|  +-----------------------+                                                     |
|  | mvmt serve            |                                                     |
|  |                       |                                                     |
|  | HTTP: 127.0.0.1:4141  |                                                     |
|  | stdio: optional       |                                                     |
|  +-----------+-----------+                                                     |
|              |                                                                 |
|              v                                                                 |
|  +-----------------------+                                                     |
|  | Security layer        |                                                     |
|  |                       |                                                     |
|  | bearer/OAuth auth     |                                                     |
|  | origin guard          |                                                     |
|  | client identity       |                                                     |
|  | path/action policy    |                                                     |
|  +-----------+-----------+                                                     |
|              |                                                                 |
|              v                                                                 |
|  +-----------------------+                                                     |
|  | Tool router           |                                                     |
|  |                       |                                                     |
|  | search/list/read      |                                                     |
|  | write/remove          |                                                     |
|  | plugins               |                                                     |
|  | audit log             |                                                     |
|  +-----------+-----------+                                                     |
|              |                                                                 |
|              v                                                                 |
|  +-----------------------+                                                     |
|  | Text context index    |                                                     |
|  | Mount registry        |                                                     |
|  | Local folder provider |                                                     |
|  +-----------+-----------+                                                     |
|              |                                                                 |
|              v                                                                 |
|  +-----------------------+                                                     |
|  | Selected local files  |                                                     |
|  +-----------------------+                                                     |
|                                                                                |
+--------------------------------------------------------------------------------+
```

## Runtime Paths

Local HTTP clients connect to:

```text
http://127.0.0.1:4141/mcp
```

They send:

```text
Authorization: Bearer <token>
```

Claude Desktop can launch mvmt over stdio instead:

```text
Claude Desktop -> mvmt serve --stdio -> MCP over stdio
```

Tunnel mode publishes the local HTTP endpoint through a public HTTPS URL for web clients such as ChatGPT or claude.ai. The local server still binds to `127.0.0.1`.

## Request Pipeline

```text
client
  -> transport auth
  -> origin guard
  -> client identity
  -> path/action policy
  -> tool router
  -> text index or local folder provider
  -> plugins
  -> audit log
  -> client
```

Authentication answers who is calling.

Mount and client policy answer what that caller may access.

## Tool Surface

The mount runtime exposes five tools:

| Tool | Purpose | Required permission |
| --- | --- | --- |
| `search` | Search indexed text chunks across permitted mounts. | `search` |
| `list` | List visible mount roots or directories. | `read` |
| `read` | Read one text file by virtual path. | `read` |
| `write` | Create or overwrite one text file. | `write` |
| `remove` | Delete one text file. | `write` |

`write` and `remove` also require the target mount to have `writeAccess: true`, and protected paths remain blocked.

## Mount Registry

The mount registry maps virtual paths to configured mount roots.

Example:

```yaml
mounts:
  - name: workspace
    path: /workspace
    root: /Users/you/code/mvmt
```

`/workspace/docs/setup.md` resolves to a file under `/Users/you/code/mvmt/docs/setup.md`.

Path traversal and symlink escapes are rejected by the local folder provider. Clients never receive host filesystem paths in tool results.

## Text Index

The text index is used by `search`.

On startup, mvmt serves immediately and rebuilds the index in the background. `mvmt reindex` forces a full rebuild.

The current index is a JSON snapshot beside the config. SQLite and incremental file watching are planned.

## Plugins

Plugins run after a tool returns and before the result reaches the client. The built-in `pattern-redactor` can warn, redact, or block regex matches in text results.

Plugins are defense in depth. They do not expand mount scope and they do not replace path/action policy.

## Shutdown

SIGINT or SIGTERM triggers cleanup:

- close stdio or HTTP MCP transports;
- stop the tunnel process if running;
- close the control socket;
- flush normal process cleanup.

If cleanup hangs, mvmt force-exits after the shutdown timeout.

## Future Federation

The long-term direction is mounted remote mvmt instances:

```text
/local    -> local folder
/desktop  -> remote mvmt instance
/server   -> remote mvmt instance
```

That is federation, not file sync. The first future abstraction is `resolve(path) -> AccessPlan`, followed by read-only remote mounts.
