import crypto from 'crypto';
import type { Request } from 'express';
import { ClientConfig, PermissionConfig } from '../config/schema.js';
import { AccessToken } from './oauth.js';

export type ClientIdentitySource = 'session' | 'token' | 'oauth' | 'quarantine';

export interface ClientIdentity {
  // Stable mvmt-internal id used by audit, policy, and admin UI lookups.
  // For named clients this is `ClientConfig.id`. For the synthesized
  // legacy identity this is `default`. For unknown OAuth clients this
  // is `quarantine:<oauth_client_id>`.
  id: string;
  name: string;
  source: ClientIdentitySource;
  rawToolsEnabled: boolean;
  permissions: readonly PermissionConfig[];
  // True only for the synthesized identity used when `config.clients` is
  // absent. Marks that this client predates the per-client policy model
  // and should behave as the pre-PR single-token client (no enforcement
  // yet — enforcement lands in a follow-up PR).
  isLegacyDefault?: boolean;
  // Original OAuth client_id, present on `source === 'oauth'` and on
  // `source === 'quarantine'`. Useful for audit and admin triage.
  oauthClientId?: string;
}

const QUARANTINE_PREFIX = 'quarantine:';

export function synthesizeDefaultClient(): ClientIdentity {
  return {
    id: 'default',
    name: 'default (legacy session token)',
    source: 'session',
    rawToolsEnabled: true,
    permissions: [],
    isLegacyDefault: true,
  };
}

export function quarantineIdentity(oauthClientId: string): ClientIdentity {
  return {
    id: `${QUARANTINE_PREFIX}${oauthClientId}`,
    name: `Quarantined OAuth client (${oauthClientId})`,
    source: 'quarantine',
    rawToolsEnabled: false,
    permissions: [],
    oauthClientId,
  };
}

export interface ResolveClientIdentityInput {
  authHeader: string;
  // Configured named clients. Pass `config.clients ?? []`; the empty
  // array path resolves a session-authenticated request to the
  // synthesized default identity, which preserves pre-PR behavior.
  clients: readonly ClientConfig[];
  oauthAccessToken: AccessToken | undefined;
  validateSession: (authHeader: string) => boolean;
  // When false, the pre-policy session-token/OAuth compatibility path is
  // disabled even if clients[] is empty. Tunnel mode uses this so a public
  // endpoint can be reachable without giving the legacy session token
  // all-mount data access.
  allowLegacyDefault?: boolean;
}

// resolveClientIdentity returns the ClientIdentity for an authenticated
// request, or undefined if no auth path matches. Callers should treat
// `undefined` as 401 and a quarantine identity as "authenticated but
// permitted to do nothing" (enforcement in a follow-up PR).
export function resolveClientIdentity(input: ResolveClientIdentityInput): ClientIdentity | undefined {
  const policyConfigured = input.clients.length > 0;
  const allowLegacyDefault = input.allowLegacyDefault ?? true;

  // OAuth access token: the bearer was already verified by the caller.
  // Map its OAuth client_id to a named client. Behavior depends on
  // whether the operator has configured per-client policy:
  //   - empty clients[]  → legacy mode: synthesized default identity,
  //     same compatibility path used for the session token. Pre-PR
  //     OAuth flows keep working until the operator adds clients[].
  //   - non-empty clients[] → strict mode: unknown OAuth client_id is
  //     quarantined (zero permissions, raw tools off) so DCR-issued or
  //     unfamiliar OAuth clients cannot silently inherit the legacy
  //     surface.
  if (input.oauthAccessToken) {
    const oauthClientId = input.oauthAccessToken.clientId;
    const named = input.clients.find(
      (c) => c.auth.type === 'oauth' && c.auth.oauthClientIds.includes(oauthClientId),
    );
    if (named) return identityFromConfig(named, 'oauth', oauthClientId);
    if (!policyConfigured && allowLegacyDefault) return synthesizeDefaultClient();
    return quarantineIdentity(oauthClientId);
  }

  // Client bearer token: hash the bearer and look for a matching client
  // tokenHash. Compare uses timing-safe equality so the lookup does not
  // leak hash data via response time differences.
  const bearer = extractBearer(input.authHeader);
  if (bearer) {
    const incomingHash = sha256Hex(bearer);
    for (const client of input.clients) {
      if (client.auth.type !== 'token') continue;
      if (timingSafeHexEqual(incomingHash, client.auth.tokenHash)) {
        return identityFromConfig(client, 'token');
      }
    }
  }

  // Session token: pre-PR single-token mode. Synthesized default
  // identity preserves backward compatibility ONLY when no per-client
  // policy is configured. Once an operator adds clients[], the session
  // token stops being a /mcp credential — it remains valid for admin
  // and control endpoints, but data-plane access must come through a
  // configured client. This prevents the session token from being a
  // parallel credential that bypasses per-client policy.
  if (!policyConfigured && allowLegacyDefault && input.validateSession(input.authHeader)) {
    return synthesizeDefaultClient();
  }

  return undefined;
}

export function isQuarantined(identity: ClientIdentity): boolean {
  return identity.source === 'quarantine';
}

export function readClientIdentity(req: Request): ClientIdentity | undefined {
  const value = req.res?.locals?.mvmtClient;
  return isClientIdentity(value) ? value : undefined;
}

export function attachClientIdentity(req: Request, identity: ClientIdentity): void {
  if (req.res) req.res.locals.mvmtClient = identity;
}

function identityFromConfig(
  client: ClientConfig,
  source: 'token' | 'oauth',
  oauthClientId?: string,
): ClientIdentity {
  return {
    id: client.id,
    name: client.name,
    source,
    rawToolsEnabled: client.rawToolsEnabled,
    permissions: client.permissions,
    ...(oauthClientId ? { oauthClientId } : {}),
  };
}

function extractBearer(authHeader: string): string | undefined {
  if (!authHeader.startsWith('Bearer ')) return undefined;
  const token = authHeader.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function isClientIdentity(value: unknown): value is ClientIdentity {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof v.source === 'string';
}
