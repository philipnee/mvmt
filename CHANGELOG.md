# Changelog

All notable changes to mvmt will be documented in this file.

This project follows the spirit of Keep a Changelog and uses semantic versioning once stable releases begin.

## Unreleased

### Added

- Repository governance files for open-source release preparation.
- Architecture documentation under `docs/architecture.md`.
- Explicit README warnings for public exposure, HTTP proxy write gates, and audit log sensitivity.
- Client compatibility, test, and platform matrices.
- Sharper README opening with quickstart, client example, status table, and screenshot placeholder.
- GitHub Actions CI for Node 20.x and 22.x.
- CODEOWNERS and `.nvmrc`.
- npm package export metadata and a restricted publish file list.
- Build specs and `rules.md` removed from the public tracked surface.
- `mvmt start -i` interactive control prompt with token, status, URL, and live-log controls.
- Typed connector setup registry (`src/connectors/setup-registry.ts`) so each connector owns its own detection, prompting, and config application.

### Changed

- Internal refactor: `src/cli/start.ts` split into focused modules (`connector-loader`, `interactive`, `tunnel-controller`). Per-connector setup extracted into `src/connectors/{filesystem,obsidian,mempalace}-setup.ts`. Shared `saveConfig()` consolidated on `src/config/loader.ts`.
- `PluginSchema` is now a single-variant `z.discriminatedUnion('name', ...)` so adding a second plugin is a schema addition rather than a structural refactor.
- OAuth `/authorize` now defaults a missing `resource` parameter to the instance's canonical `/mcp` resource for client compatibility, while preserving token audience binding and still rejecting explicit wrong resources.

### Deprecated

- `source` field on proxy config entries is no longer written by guided setup or `mvmt connectors add`. The schema still accepts it so existing configs continue to parse; it will be removed in a future release.

### Removed

- Internal CLI setup helpers are no longer exported from the package root: `init`, `buildConfig`, `createMemPalaceProxyConfig`, `countNotes`, `detectMemPalace`, `detectObsidianVaults`, `findExecutableOnPath`, `readShebangCommand`, `promptForMemPalace`, `DetectedMemPalace`, `MemPalaceConfigInput`. Use `setupConfig` for guided setup or import from the connector setup modules under `src/connectors/*-setup.ts` directly.

## 0.1.0 - Unreleased

### Added

- `mvmt init` for explicit local data setup.
- `mvmt start` for Streamable HTTP and stdio serving.
- `mvmt doctor` for config and connector diagnostics.
- `mvmt token show` and `mvmt token rotate`.
- Native Obsidian connector with read-only default and optional daily-note append.
- Filesystem access through the official MCP filesystem server as a proxied child process.
- Read-only write gates for filesystem and Obsidian.
- Local bearer-token auth, Origin checks, environment scrubbing, and audit logging.
- Experimental tunnel startup for public HTTPS demos.

### Security

- HTTP mode binds to `127.0.0.1`.
- Config and token files are written with restrictive permissions on non-Windows systems.
- Stdio child processes receive a minimal inherited environment plus explicit config env values.

### Known Limits

- Tunnel mode is experimental.
- OAuth/tunnel auth is not production-ready.
- No per-client connector scoping yet.
- No native Postgres, SQLite, or Git connector yet.
