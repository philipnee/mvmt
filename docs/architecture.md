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
|  |  +----------+-----------+                                                 ||
|  |             |                                                             ||
|  |             v                                                             ||
|  |  +----------------------+                                                 ||
|  |  | Tool router          |                                                 ||
|  |  |                      |                                                 ||
|  |  | namespaces tools     |                                                 ||
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

Tunnel mode is experimental and intended for demos or remote testing.

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

Every tool call follows the same path.

```text
+---------+     +--------------+     +------------+     +-------------+     +----------+
| client  | --> | auth/origin  | --> | write gate | --> | tool router | --> | connector|
+---------+     +--------------+     +------------+     +------+------+     +----+-----+
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

## Boundary

```text
mvmt is not the source of all connectors.
mvmt is the gatekeeper and router for local personal data that the user explicitly scoped.
```
