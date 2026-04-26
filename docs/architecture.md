# mvmt Architecture

mvmt is a local personal data plane. It runs on the user's machine, exposes only the local data the user explicitly scopes, and serves that data through MCP-compatible transports.

It is not a connector registry, marketplace, or bundled catalog of third-party services.

```text
                               LOCAL MACHINE
+--------------------------------------------------------------------------------+
|                                                                                |
|  User chooses scope                                                            |
|  +------------------+                                                          |
|  | mvmt init        |                                                          |
|  |                  |                                                          |
|  | - folders        |                                                          |
|  | - Obsidian vault |                                                          |
|  | - read/write     |                                                          |
|  | - local/tunnel   |                                                          |
|  +--------+---------+                                                          |
|           |                                                                    |
|           v                                                                    |
|  +-------------------------------+                                             |
|  | ~/.mvmt/config.yaml           |                                             |
|  |                               |                                             |
|  | server:                       |                                             |
|  |   port: 4141                  |                                             |
|  |   access: local | tunnel      |                                             |
|  | proxy:                        |                                             |
|  |   filesystem folders          |                                             |
|  | obsidian:                     |                                             |
|  |   vault path                  |                                             |
|  |   writeAccess: false          |                                             |
|  +-------------------------------+                                             |
|                                                                                |
|                                                                                |
|  +----------------------------------------------------------------------------+|
|  | mvmt start                                                                 ||
|  |                                                                            ||
|  |  +----------------------+       +--------------------------------------+   ||
|  |  | HTTP server          |       | stdio server                         |   ||
|  |  | 127.0.0.1:4141       |       | for clients that launch mvmt directly|   ||
|  |  | /mcp                 |       | no HTTP listener, no bearer token    |   ||
|  |  | /health              |       +--------------------------------------+   ||
|  |  | /authorize           |                                                 ||
|  |  | /token               |                                                 ||
|  |  +----------+-----------+                                                 ||
|  |             |                                                             ||
|  |             v                                                             ||
|  |  +----------------------+                                                 ||
|  |  | Security layer       |                                                 ||
|  |  |                      |                                                 ||
|  |  | - localhost bind     |                                                 ||
|  |  | - bearer token       |                                                 ||
|  |  | - origin check       |                                                 ||
|  |  | - OAuth/PKCE bridge  |                                                 ||
|  |  | - client identity    |                                                 ||
|  |  +----------+-----------+                                                 ||
|  |             |                                                             ||
|  |             v                                                             ||
|  |  +----------------------+                                                 ||
|  |  | Tool router          |                                                 ||
|  |  |                      |                                                 ||
|  |  | namespaces tools     |                                                 ||
|  |  | filters by policy    |                                                 ||
|  |  | semantic tools       |                                                 ||
|  |  | routes calls         |                                                 ||
|  |  | applies plugins      |                                                 ||
|  |  | writes audit log     |                                                 ||
|  |  +----------+-----------+                                                 ||
|  |             |                                                             ||
|  |             +---------------------+----------------------+                 ||
|  |                                   |                      |                 ||
|  |                                   v                      v                 ||
|  |  +----------------------+   +----------------------+   +----------------+ ||
|  |  | Filesystem proxy     |   | Obsidian connector   |   | Future native  | ||
|  |  |                      |   |                      |   | connectors     | ||
|  |  | stdio child process  |   | direct fs access     |   |                | ||
|  |  | official MCP fs      |   | markdown read/search |   | - Postgres     | ||
|  |  | read-only default    |   | read-only default    |   | - SQLite       | ||
|  |  | write gate           |   | write gate           |   | - Git          | ||
|  |  | env scrubbed         |   | path scoped          |   |                | ||
|  |  +----------+-----------+   +----------+-----------+   +----------------+ ||
|  |             |                          |                                  ||
|  +-------------|--------------------------|----------------------------------+|
|                |                          |                                   |
|                v                          v                                   |
|       +----------------+          +----------------------+                    |
|       | Allowed folders|          | Obsidian vault       |                    |
|       |                |          |                      |                    |
|       | ~/project      |          | ~/Documents/Vault    |                    |
|       | /tmp/demo      |          | daily/*.md           |                    |
|       +----------------+          +----------------------+                    |
|                                                                                |
|  +------------------------------+                                              |
|  | ~/.mvmt/.session-token       |                                              |
|  | current local bearer token   |                                              |
|  +------------------------------+                                              |
|                                                                                |
|  +------------------------------+                                              |
|  | ~/.mvmt/audit.log            |                                              |
|  | append-only JSONL tool calls |                                              |
|  +------------------------------+                                              |
|                                                                                |
+--------------------------------------------------------------------------------+
```

## Client Paths

Local HTTP clients connect to the local Streamable HTTP endpoint.

```text
+----------------+          Authorization: Bearer token          +---------------+
| Claude Code    | --------------------------------------------> | mvmt /mcp     |
| Cursor         |                                               | 127.0.0.1     |
| VS Code        | <-------------------------------------------- | Streamable    |
| Codex          |                MCP responses                  | HTTP          |
+----------------+                                               +---------------+
```

Clients that launch MCP servers directly can run mvmt in stdio mode.

```text
+----------------+              launches process                 +---------------+
| Claude Desktop | --------------------------------------------> | mvmt start    |
|                |                                               | --stdio       |
|                | <-------------------------------------------- | MCP over stdio|
+----------------+                                               +---------------+
```

Tunnel mode provides public HTTPS access for cloud and web MCP clients. Quick tunnel URLs are temporary; stable URLs require a named tunnel or reserved domain.

```text
+----------------+       public HTTPS URL        +------------------------------+
| Claude.ai      | ----------------------------> | Tunnel provider              |
| ChatGPT web    |                               |                              |
| remote client  | <---------------------------- | Cloudflare / localhost.run   |
+----------------+                               +---------------+--------------+
                                                                |
                                                                |
                                                                v
                                                     +----------------------+
                                                     | mvmt local HTTP      |
                                                     | 127.0.0.1:4141/mcp   |
                                                     | bearer/OAuth gate    |
                                                     +----------------------+
```

## Request Pipeline

Every tool list and tool call follows the same path.

```text
+---------+     +--------------+     +----------------+     +-------------+     +----------+
| client  | --> | auth/origin  | --> | client policy  | --> | tool router | --> | connector|
+---------+     +--------------+     +----------------+     +------+------+     +----+-----+
                                                                              ^          |
                                                                              |          v
                                                                              |   +-------------+
                                                                              |   | raw result  |
                                                                              |   +-------------+
                                                                              |          |
                                                                              |          v
                                                                              |   +-------------+
                                                                              +-- | plugins     |
                                                                                  | redactor    |
                                                                                  +------+------+
                                                                                         |
                                                                                         v
                                                                                  +-------------+
                                                                                  | audit log   |
                                                                                  | ~/.mvmt/    |
                                                                                  +-------------+
```

## Tool Names

mvmt namespaces tools by connector ID so different connectors can expose tools with the same original name.

```text
+--------------------+----------------------+--------------------------------+
| Connector          | Original tool        | Client sees                    |
+--------------------+----------------------+--------------------------------+
| proxy_filesystem   | read_file            | proxy_filesystem__read_file    |
| proxy_filesystem   | list_directory       | proxy_filesystem__list_directory|
| obsidian           | search_notes         | obsidian__search_notes         |
| obsidian           | read_note            | obsidian__read_note            |
+--------------------+----------------------+--------------------------------+
```

When `semanticTools` is configured, mvmt also exposes high-level tools without connector prefixes:

```text
+-------------------------+------------------------------------------------+
| Tool                    | Purpose                                        |
+-------------------------+------------------------------------------------+
| search_personal_context | Keyword-union retrieval across allowed sources |
| read_context_item       | Read an item returned by search                |
+-------------------------+------------------------------------------------+
```

These tools are policy-aware. A client can see and call them only for configured sources where its permissions include the required action.

## Shutdown

SIGINT or SIGTERM triggers shutdown. All cleanup tasks run in parallel:

- Shut down each connector (kills stdio child processes, closes HTTP clients).
- Close the HTTP server (closes MCP session transports, drains idle connections, force-closes after 1 second).
- Stop the tunnel process if running (SIGTERM, then SIGKILL after 2 seconds).

If cleanup does not finish within 5 seconds, the process force-exits.

On startup failure (e.g. port conflict), connectors that were already initialized are shut down before exit.

## Boundary

```text
mvmt is not the source of all connectors.
mvmt is the gatekeeper and router for local personal data that the user explicitly scoped.
```
