import { ClientConfig } from '../config/schema.js';
import { LeaseRecord, leaseResources, LeasePermission } from '../lease/store.js';

// A Grant is the unified read-model for a scoped capability, independent
// of where it is stored (clients[] in config, or the lease store) and of
// which surface consumes it (/mcp, the lease browser, raw HTTP).
//
// It is a pure projection: it owns no storage and mutates nothing. The
// adapters below turn the two existing record shapes into one Grant shape
// so auth resolution, exposure checks, and audit can work against a
// single type. Stores stay split; only the read-model is unified.

export type GrantAction = 'search' | 'read' | 'write';

export interface GrantScopeEntry {
  // Absolute virtual path or glob, e.g. /workspace/** or /notes/file.md.
  path: string;
  actions: GrantAction[];
}

// Where the underlying record lives. Drives nothing in the model itself;
// callers use it for audit labelling and surface-specific behaviour.
export type GrantKind = 'token' | 'oauth' | 'lease';

export interface Grant {
  // Stable id of the underlying record: ClientConfig.id or LeaseRecord.id.
  id: string;
  // Human label: ClientConfig.name or LeaseRecord.label.
  label: string;
  kind: GrantKind;
  scope: GrantScopeEntry[];
  // Whether the grant is reachable over the relay. See isGrantPublished()
  // for the grandfather rule applied to records minted before the
  // publish concept existed.
  published: boolean;
  expiresAt?: string;
  revokedAt?: string;
}

// Grandfather rule: a record without an explicit `published` value
// predates the exposure boundary and is treated as published, so every
// pre-existing API token and lease keeps working over the relay. Only a
// record explicitly minted with `published: false` is capability-only.
export function isGrantPublished(value: boolean | undefined): boolean {
  return value !== false;
}

export function clientConfigToGrant(client: ClientConfig): Grant {
  return {
    id: client.id,
    label: client.name,
    kind: client.auth.type === 'oauth' ? 'oauth' : 'token',
    scope: client.permissions.map((permission) => ({
      path: permission.path,
      actions: [...permission.actions],
    })),
    published: isGrantPublished(client.published),
    ...(client.expiresAt ? { expiresAt: client.expiresAt } : {}),
  };
}

export function leaseRecordToGrant(lease: LeaseRecord): Grant {
  const actions = leasePermissionsToGrantActions(lease.permissions);
  return {
    id: lease.id,
    label: lease.label,
    kind: 'lease',
    // A lease applies one permission set across all of its resources.
    scope: leaseResources(lease).map((resource) => ({
      path: resource.path,
      actions: [...actions],
    })),
    published: isGrantPublished(lease.published),
    ...(lease.expiresAt ? { expiresAt: lease.expiresAt } : {}),
    ...(lease.revokedAt ? { revokedAt: lease.revokedAt } : {}),
  };
}

// Maps the lease permission vocabulary into the canonical grant actions.
// `upload` is write-without-read: it grants `write` only, and the absence
// of `read` is what makes it upload-only. Leases never carry `search` —
// that action must be granted explicitly through an API-token grant.
function leasePermissionsToGrantActions(permissions: LeasePermission[]): GrantAction[] {
  const actions = new Set<GrantAction>();
  for (const permission of permissions) {
    if (permission === 'read') actions.add('read');
    if (permission === 'write') actions.add('write');
    if (permission === 'upload') actions.add('write');
  }
  return [...actions];
}
