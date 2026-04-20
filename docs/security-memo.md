# Security Memo

**Date:** 2026-04-14

mvmt exposes personal local data through MCP. That makes its default security posture part of the product, not a later hardening pass.

## Current Boundary

mvmt is local-first. HTTP mode binds to `127.0.0.1`, requires a bearer token, and rejects browser requests from non-localhost origins unless explicitly allowlisted. Stdio mode has no network listener and depends on the launching MCP client for process isolation.

`mvmt init` must only configure scopes that the user grants inside mvmt. It must not import Claude Desktop, Claude Code, Cursor, or other MCP client configs. Those configs can contain broad credentials and trust decisions that mvmt should not inherit implicitly.

## Access Scopes

Filesystem access is explicit by folder path. The default is read-only. Write tools are hidden and rejected unless the user enables write access for that filesystem scope.

Obsidian is a native connector. The scope is a single vault path. The default is read-only. `append_to_daily` is hidden and rejected unless Obsidian write access is enabled.

MemPalace is a stdio proxy connector. The scope is a single palace path. The default is read-only. Known memory write tools are hidden and rejected unless MemPalace write access is enabled.

Future connectors should follow the same pattern: exact scope first, read-only default where possible, and separate write consent.

## Token Handling

HTTP auth uses a 256-bit bearer token stored at `~/.mvmt/.session-token` with mode `600` on non-Windows systems.

- `mvmt start` generates a fresh token.
- `mvmt show` prints the current token without changing it.
- `mvmt rotate` generates a new token and writes it to the token file.

The HTTP server validates against the token file on each request. This makes token rotation effective without restarting the server, but clients that cached the old token still need to be updated or restarted.

## Known Limits

Localhost traffic is plaintext. A process running as the same OS user can usually read local files and process state anyway, so the OS user remains the main trust boundary.

There is no per-client permission model yet. Any authenticated HTTP client can see the same configured connectors.

There is no managed remote relay yet. For remote access, use a narrow config and read-only scopes where possible. Quick tunnels are temporary; use a named tunnel or reserved domain for a stable URL.

Tunnel OAuth discovery uses forwarded host/proto headers from the tunnel provider to construct public URLs. Cloudflare Quick Tunnel is the recommended v0 path; other tunnels may produce incorrect discovery URLs.

Audit logs are local JSONL files with mode `600`. They include argument key names and a truncated argument preview, which can contain values. Do not treat the audit log as sanitized.

## Pattern-Based Redaction

The built-in `pattern-redactor` plugin is defense-in-depth for outbound tool results. It is useful for accidental leakage, such as a stray API key in a code comment or log line.

This is a best-effort pattern matcher, not a security control. It will miss data that doesn't match your patterns, and may redact things you didn't intend. Do not rely on it for compliance, privacy, or security requirements.

If data must not reach AI tools, do not expose it through a connector. Scope the connector to exclude that data entirely.

When the redactor matches, audit entries include the matched pattern name and count so users can see why output was changed or blocked.

## Near-Term Security Priorities

- Per-client connector scopes.
- Rate limiting for HTTP mode.
- Clear remote relay design before marketing internet access.
- Audit log rotation.
- Stronger write policies for future native connectors such as Postgres.
