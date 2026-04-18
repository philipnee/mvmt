# Security Policy

mvmt exposes personal local data. Security bugs should be handled privately and conservatively.

## Supported Versions

mvmt is pre-1.0. Security fixes target the latest code on `main` until a stable release process exists.

| Version | Supported |
| --- | --- |
| main | yes |
| < 0.1.0 | no |

## Reporting A Vulnerability

Please do not open a public issue with exploit details.

Use GitHub private vulnerability reporting for this repository if it is enabled. If private reporting is not available, open a minimal public issue asking for a private security contact and do not include sensitive details.

Include:

- Affected version or commit.
- Operating system.
- Whether mvmt was running local-only or through a tunnel.
- Minimal reproduction steps.
- Impact: what data or capability became accessible.
- Whether the issue requires local user access, local network access, or public internet access.

## Security Model Summary

Current protections:

- HTTP mode binds to `127.0.0.1` only.
- HTTP requests require a bearer token.
- Origin checks reject non-localhost browser origins unless allowlisted.
- Filesystem and Obsidian access are scoped by explicit user configuration.
- Write access is opt-in.
- Stdio child processes receive a scrubbed environment.
- Tool calls are written to a local audit log.

Known limits:

- Tunnel mode is experimental and intended for demos/testing.
- Localhost traffic is plaintext.
- There is not yet a per-client permission model.
- There is not yet rate limiting.
- The audit log can include truncated argument values.
- OAuth/tunnel auth is still evolving and should be treated as pre-production.

See `docs/security-memo.md` for more detail.
