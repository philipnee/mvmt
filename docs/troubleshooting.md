# Troubleshooting

## `mvmt start` says port is in use

Another process is using the port.

```bash
mvmt start --port 4142
```

## Connector fails to start

Run:

```bash
mvmt doctor
mvmt start --verbose
```

Common causes:

- The MCP package is not installed or `npx` cannot download it.
- Required environment variables are missing from `proxy[].env`.
- The command is not on `PATH`.
- An advanced/manual HTTP proxy URL is not a Streamable HTTP MCP endpoint.

## Tools are missing

Check:

- Whether the connector is enabled in `~/.mvmt/config.yaml`.
- Whether `writeAccess: false` is hiding write-like tools.
- Whether `mvmt doctor` reports the connector healthy.

## Obsidian vault not detected

`mvmt init` scans these locations one level deep:

- `~/Documents/`
- `~/Obsidian/`
- `~/vaults/`
- `~/`
- `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/` on macOS

If your vault is elsewhere, enter the path manually.

## Token rejected by client

The bearer token changes every time `mvmt start` runs and every time you run `mvmt rotate`. Read the current token:

```bash
mvmt show
```

Then update or restart the client with that token.

If the token file is rejected even though mvmt is running, check that the client actually sent the new token. Existing MCP clients may need to be restarted after rotation.

## Remote client cannot connect and no tool calls appear

OAuth and MCP handshake failures can happen before a tool call exists, so they do not appear in the tool-call audit log. In interactive mode, turn live logs on:

```bash
mvmt start -i
> logs on
```

Then retry the client connection. You should see sanitized events such as:

```text
oauth.discovery GET /.well-known/oauth-authorization-server/mcp 200
oauth.register POST /register 201
oauth.authorize GET /authorize 200
oauth.token POST /token 400 invalid_grant
mcp.auth GET /mcp 401 missing_or_invalid_bearer
```

These live events do not include bearer tokens, session tokens, authorization codes, code challenges, redirect URIs, or full query strings.
