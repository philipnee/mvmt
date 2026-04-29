# Security Memo

**Date:** 2026-04-28

mvmt exposes selected local files to AI clients. Its security model is part of the product.

## Boundary

mvmt is local-first.

- HTTP mode binds to `127.0.0.1`.
- `/mcp` and `/health` require authentication.
- Browser Origin checks block drive-by browser requests from untrusted origins.
- Stdio mode has no network listener and depends on the launching MCP client for process isolation.

mvmt should not import trust decisions from Claude Desktop, Claude Code, Cursor, or other MCP client configs. The user chooses mvmt mounts directly.

## Mount Scope

Filesystem access is explicit by mount.

```yaml
mounts:
  - name: workspace
    path: /workspace
    root: /Users/you/code/mvmt
    writeAccess: false
```

Defaults:

- no mount means no data;
- mounts are read-only unless `writeAccess: true`;
- `exclude` hides paths from reads, writes, removes, listing, and indexing;
- `protect` blocks write and remove;
- path traversal and symlink escapes are rejected.

An Obsidian vault is just a local folder mount. MemPalace is not part of the current runtime surface.

## Token Handling

HTTP auth uses a 256-bit session bearer token stored at:

```text
~/.mvmt/.session-token
```

The token file is mode `600` on non-Windows systems.

Commands:

```bash
mvmt token
mvmt token show
mvmt token rotate
```

The HTTP server validates against the token file on each request, so rotation is effective without restarting mvmt. Clients using the old token still need to be restarted or updated.

Scoped bearer credentials use API tokens:

```bash
mvmt tokens add
mvmt tokens list
mvmt tokens remove
```

The plaintext API token is printed once. mvmt stores only its SHA-256 hash in
config.

## Per-Client Policy

When `clients[]` is absent, mvmt preserves legacy behavior: the session token can access all configured mounts.

When `clients[]` exists, `/mcp` resolves every request to a configured client:

- token clients match a stored SHA-256 `tokenHash`;
- OAuth clients match configured OAuth `client_id` values;
- unknown OAuth clients are quarantined with zero permissions;
- the session token no longer grants data-plane access.

Policy is path/action based:

```yaml
clients:
  - id: codex
    permissions:
      - path: /workspace/**
        actions: [search, read, write]
      - path: /notes/**
        actions: [search, read]
```

For writes, both checks must pass:

1. client has `write` for the virtual path;
2. mount has `writeAccess: true`.

Protected paths remain blocked even when both checks pass.

Tunnel mode can start without API tokens, but `/mcp` rejects the legacy
all-mount session token in that state. Public data access requires a scoped API
token or an approved OAuth client mapping. `MVMT_ALLOW_LEGACY_TUNNEL=1` exists
only as a temporary debugging escape hatch.

Mount access has two layers of path filtering: per-mount `exclude`/`protect` patterns and a global secret-path deny list. The global list blocks paths such as `.mvmt/**`, `.ssh/**`, `.aws/**`, `.kube/**`, and common credential files even when an older config omits those patterns.

## Known Limits

- Localhost traffic is plaintext. The OS user remains the main trust boundary.
- API-token rotation is not managed yet.
- There is no admin UI yet.
- Search is prototype keyword scoring over text files, not embeddings.
- Binary/PDF/image indexing is not shipped.
- Remote mvmt mounts are not shipped.
- Audit log rotation is manual.

## Pattern Redaction

The built-in `pattern-redactor` plugin is defense in depth for outbound tool results.

It is not the primary security boundary. If a client must not see data, do not mount that path for the client.

## Near-Term Security Priorities

- API-token rotation and revocation UX.
- Admin UI for mounts, client policy, and audit visibility.
- SQLite-backed index and incremental updates.
- Remote mvmt mounts with clear two-sided permission checks.
- Audit log rotation.
