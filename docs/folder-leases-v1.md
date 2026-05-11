# mvmtOS V1: Folder Leases

V1 makes folder leases the product surface.

```text
one lease = one folder = one read-only token
```

The durable abstraction is not MCP or AI permissions. It is scoped, expiring,
audited access to one folder on the user's own machine.

## V1 Contract

- A lease is read-only.
- A lease points at one local folder.
- A lease has a required human label.
- A lease defaults to 24 hours.
- A lease can also last until revoked.
- A lease cannot expose paths outside its folder.
- A lease cannot bypass mount exclude rules or global secret-path blocks.
- Unsupported file types may still be downloaded.
- Search/indexing is allowed to support fewer file types than download.
- MCP is an adapter over the same permission engine, not the product core.

## Out Of Scope

- Write access.
- Uploads.
- Deletes.
- Multi-folder leases.
- Team ACLs.
- Hosted relay.
- Sync.
- Backup.
- Public admin dashboard.

## First Milestone

```bash
mvmt lease create ~/Documents/Taxes --label "Sarah - tax docs"
```

The generated link opens a scoped folder view. The recipient can browse and
download files from that folder until the lease expires or is revoked.
