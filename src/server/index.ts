import { createHash, randomUUID } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import fsp from 'fs/promises';
import { Server as HttpServer } from 'node:http';
import os from 'os';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import express, { Request, Response } from 'express';
import type { AccessToken } from './oauth.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ToolRouter } from './router.js';
import { log } from '../utils/logger.js';
import { defaultClientsPath, defaultRefreshTokensPath, defaultSigningKeyPath, ensureSessionToken, ensureSigningKey, readSigningKey, TOKEN_PATH, validateSessionToken } from '../utils/token.js';
import { verifyApiToken } from '../utils/api-token-hash.js';
import { isExpired, parseTokenTtl } from '../utils/token-ttl.js';
import {
  CodeChallengeMethod,
  OAuthClientAlreadyRegisteredError,
  OAuthClientPersistenceError,
  OAuthClientRegistryLimitError,
  OAuthError,
  OAuthStore,
  getBaseUrl,
  renderAuthorizePage,
} from './oauth.js';
import { rateLimit } from './rate-limit.js';
import { ClientConfig, LocalFolderMountConfig } from '../config/schema.js';
import { readConfig, saveConfig, withConfigLock } from '../config/loader.js';
import { addMountToConfig, editMountInConfig, MountInput, removeMountFromConfig } from '../cli/mounts.js';
import { listDashboardFiles, normalizeDashboardPath, resolveDashboardFileTarget } from '../dashboard/files.js';
import {
  defaultPrivilegedUsersPath,
  PrivilegedUser,
  recordPrivilegedUserLogin,
  verifyPrivilegedUserPassword,
} from '../dashboard/users.js';
import { listLeaseDirectory, resolveLeaseFileTarget, resolveLeaseUploadTarget } from '../lease/files.js';
import {
  createLease,
  defaultLeasesPath,
  findLease,
  findLeaseByToken,
  leaseAllows,
  LeaseRecord,
  LeaseResource,
  leaseResources,
  leaseUnavailableReason,
  listLeases,
  recordLeaseUse,
  revokeLease,
  rotateLeaseToken,
  validateLeaseToken,
} from '../lease/store.js';
import {
  attachClientIdentity,
  ClientIdentity,
  clientBindingMatches,
  clientCredentialVersion,
  isQuarantined,
  readClientIdentity,
  resolveClientIdentity,
} from './client-identity.js';

// Rate limits are defense-in-depth against brute-force and DoS,
// primarily meaningful when mvmt is exposed via a tunnel. Auth-gated
// data-plane routes (/mcp) get a generous cap that comfortably covers
// MCP polling. Auth surface routes (/authorize, /token, /register) get
// a tight cap to slow session-token guessing. /health is polled
// frequently and only checks the bearer.
const DEFAULT_AUTH_RATE_LIMIT = { windowMs: 60_000, max: 30 };
const DEFAULT_MCP_RATE_LIMIT = { windowMs: 60_000, max: 600 };
const DEFAULT_HEALTH_RATE_LIMIT = { windowMs: 60_000, max: 120 };
const DEFAULT_MAX_LEASE_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_DASHBOARD_LEASE_TTL = '24h';
const DASHBOARD_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DASHBOARD_SESSION_COOKIE = 'mvmt_dashboard';

type McpSession = {
  transport: StreamableHTTPServerTransport;
  server: Server;
  clientIdentityRef: ClientIdentityRef;
  clientIdentity?: ClientIdentity;
  lastActivity: number;
};

type ClientIdentityRef = {
  current?: ClientIdentity;
};

type DashboardSession = {
  id: string;
  userId: string;
  username: string;
  expiresAt: number;
  admin: boolean;
};

export interface RateLimitOverrides {
  auth?: { windowMs: number; max: number };
  mcp?: { windowMs: number; max: number };
  health?: { windowMs: number; max: number };
}

export interface HttpServerOptions {
  port: number;
  allowedOrigins?: string[];
  tokenPath?: string;
  signingKeyPath?: string;
  // Called at request time to resolve the public-facing base URL for
  // OAuth metadata and redirect issuer values. When set, its result
  // overrides the request Host header. This is how the tunnel URL gets
  // propagated into OAuth responses without trusting X-Forwarded-* headers.
  resolvePublicBaseUrl?: () => string | undefined;
  // Override rate-limit buckets; used by tests to exercise the 429 path
  // without blasting thousands of requests.
  rateLimits?: RateLimitOverrides;
  requestLog?: (entry: HttpRequestLogEntry) => void;
  // Per-client policy entries (from `config.clients`). When undefined or
  // empty, requests authenticated via the session token resolve to a
  // synthesized default identity that preserves pre-PR single-token
  // behavior. Pass an array to enable per-client identity resolution.
  clients?: readonly ClientConfig[] | (() => readonly ClientConfig[] | undefined);
  leaseMounts?: readonly LocalFolderMountConfig[] | (() => readonly LocalFolderMountConfig[] | undefined);
  leaseStorePath?: string;
  privilegedUsersPath?: string;
  // Path to the on-disk config file. When set, the dashboard can persist
  // mount changes (add/edit/remove) through this file using the same
  // helpers and lock that the CLI uses. When undefined, dashboard mount
  // mutation endpoints respond 403.
  configPath?: string;
  // Defaults to true for local backward compatibility. Tunnel mode passes
  // false unless MVMT_ALLOW_LEGACY_TUNNEL is set, so a public endpoint can
  // start with no API tokens while exposing no data.
  allowLegacyDefaultClient?: boolean | (() => boolean);
}

export interface StartedHttpServer {
  port: number;
  close(): Promise<void>;
}

export interface HttpRequestLogEntry {
  ts: string;
  kind: string;
  method: string;
  path: string;
  status: number;
  detail?: string;
  clientId?: string;
  ip?: string;
}

export const MVMT_SERVER_INSTRUCTIONS = [
  'mvmt exposes selected local files through permissioned tools.',
  '',
  'Use mvmt when the user asks about their own notes, files, projects, workspace, local docs, or previously mounted content. For content questions, call search first. If a result looks relevant, call read with the returned path before answering.',
  '',
  'Use list only to discover available mounts or browse directories. Prefer search over list+read for topic questions.',
  '',
  'Do not use mvmt for general web or current-events questions unless the user asks about local files. Never write or remove unless the user explicitly asks to create, overwrite, or delete a specific file. If search returns no useful results, say that instead of inventing local file contents.',
].join('\n');

export function createMcpServer(router: ToolRouter, clientIdentity?: ClientIdentity | (() => ClientIdentity | undefined)): Server {
  const resolveClientIdentityForRequest = typeof clientIdentity === 'function'
    ? clientIdentity
    : () => clientIdentity;
  const server = new Server(
    { name: 'mvmt', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: MVMT_SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: router.getAllTools(resolveClientIdentityForRequest()).map((tool) => ({
      name: tool.namespacedName,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object'; properties?: Record<string, object>; required?: string[] },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await router.callTool(
        request.params.name,
        request.params.arguments ?? {},
        resolveClientIdentityForRequest(),
      );
      return result as any;
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// Returns a close handle so the caller can tear down the transport on
// shutdown. Without this, stdio child processes could outlive the parent.
export async function startStdioServer(router: ToolRouter): Promise<{ close(): Promise<void> }> {
  const server = createMcpServer(router);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return {
    close: () => transport.close(),
  };
}

export async function startHttpServer(router: ToolRouter, options: HttpServerOptions): Promise<StartedHttpServer> {
  const { port } = options;
  const tokenPath = options.tokenPath;
  const requestLog = options.requestLog;
  const resolvePublicBaseUrl = options.resolvePublicBaseUrl;
  // Proxied/tunneled deployments should set resolvePublicBaseUrl so OAuth
  // resource audience checks do not depend on the request Host header.
  const baseUrlFor = (req: Request): string => getBaseUrl(req, resolvePublicBaseUrl?.());
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  ensureSessionToken(tokenPath);
  const signingKeyPath = options.signingKeyPath ?? defaultSigningKeyPath(tokenPath ?? TOKEN_PATH);
  const leaseStorePath = options.leaseStorePath ?? defaultLeasesPath(tokenPath ?? TOKEN_PATH);
  const privilegedUsersPath = options.privilegedUsersPath ?? defaultPrivilegedUsersPath(tokenPath ?? TOKEN_PATH);
  // Create the signing key file on first boot, then re-read it on every
  // HMAC op. This way internal session-token rotation (which rewrites the file)
  // invalidates outstanding OAuth access tokens immediately, without
  // requiring a server restart.
  ensureSigningKey(signingKeyPath);
  const clientsPath = defaultClientsPath(tokenPath ?? TOKEN_PATH);
  const refreshTokensPath = defaultRefreshTokensPath(tokenPath ?? TOKEN_PATH);
  const oauth = new OAuthStore({
    signingKey: () => readSigningKey(signingKeyPath) ?? ensureSigningKey(signingKeyPath),
    clientsPath,
    refreshTokensPath,
  });
  const oauthCleanup = setInterval(() => oauth.cleanup(), 60 * 1000);
  oauthCleanup.unref();

  const sessions = new Map<string, McpSession>();
  const dashboardSessions = new Map<string, DashboardSession>();
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    const staleTimeoutMs = 30 * 60 * 1000;

    for (const [id, session] of sessions) {
      if (now - session.lastActivity > staleTimeoutMs) {
        session.transport.close().catch(() => undefined);
        sessions.delete(id);
      }
    }

    for (const [id, session] of dashboardSessions) {
      if (session.expiresAt <= now) dashboardSessions.delete(id);
    }
  }, 5 * 60 * 1000);
  cleanupInterval.unref();

  const authLimiter = rateLimit(options.rateLimits?.auth ?? DEFAULT_AUTH_RATE_LIMIT);
  const mcpLimiter = rateLimit(options.rateLimits?.mcp ?? DEFAULT_MCP_RATE_LIMIT);
  const healthLimiter = rateLimit(options.rateLimits?.health ?? DEFAULT_HEALTH_RATE_LIMIT);

  const originCheck = buildOriginCheck(options.allowedOrigins ?? []);

  const oauthOriginMiddleware: express.RequestHandler = (req, res, next) => {
    if (originCheck(req) || originMatchesBaseUrl(req, baseUrlFor(req))) {
      next();
      return;
    }
    logHttpRequest(requestLog, req, 403, 'oauth.origin', 'origin_not_allowed');
    res.status(403).json({ error: 'Origin not allowed' });
  };

  const authMiddleware: express.RequestHandler = (req, res, next) => {
    if (!originCheck(req)) {
      logHttpRequest(requestLog, req, 403, authLogKind(req), 'origin_not_allowed');
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }
    const authHeader = firstHeaderValue(req.headers.authorization);
    if (!authHeader) {
      const baseUrl = baseUrlFor(req);
      res.setHeader(
        'WWW-Authenticate',
        `Bearer realm="mvmt", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
      );
      logHttpRequest(requestLog, req, 401, authLogKind(req), 'missing_bearer');
      res.status(401).json({ error: 'Invalid or missing bearer token' });
      return;
    }
    if (!authHeader.startsWith('Bearer ')) {
      const baseUrl = baseUrlFor(req);
      res.setHeader(
        'WWW-Authenticate',
        `Bearer realm="mvmt", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
      );
      logHttpRequest(requestLog, req, 401, authLogKind(req), 'non_bearer_auth');
      res.status(401).json({ error: 'Invalid or missing bearer token' });
      return;
    }
    // Expected audience is the canonical resource identifier we
    // advertise in protected-resource-metadata. The authorize flow
    // copies the client-supplied `resource` into the token's `aud`;
    // we validate it here so a token minted for a different resource
    // cannot be replayed at this server.
    const expectedAudience = `${baseUrlFor(req)}/mcp`;
    const oauthAccessToken = oauth.validateAccessToken(authHeader, {
      expectedAudience,
      allowLegacyNoAudience: true,
    });
    let identity = resolveClientIdentity({
      authHeader,
      clients: resolveClients(options.clients),
      oauthAccessToken,
      validateSession: (header) => validateSessionToken(header, tokenPath),
      allowLegacyDefault: resolveAllowLegacyDefaultClient(options.allowLegacyDefaultClient),
      clientHint: requestClientHint(req, oauthAccessToken?.clientId),
    });
    if (!identity) {
      const lease = findLeaseByToken(leaseStorePath, bearerToken(req));
      if (lease && !leaseUnavailableReason(lease)) identity = identityFromLease(lease);
    }
    if (identity && isQuarantined(identity)) {
      // Quarantined identities are authenticated (the OAuth access token
      // is valid) but the OAuth client_id has no mapping to a configured
      // client. Reject at auth time until a separate enforcement layer
      // exists; otherwise quarantine would be in-name-only and the
      // unknown client would still reach the global tool surface.
      logHttpRequest(
        requestLog,
        req,
        403,
        authLogKind(req),
        `quarantined oauth_client_id=${identity.oauthClientId ?? '(none)'}`,
        identity.id,
      );
      res.status(403).json({
        error: 'oauth_client_quarantined',
        error_description: 'OAuth client_id is not mapped to a configured mvmt client; admin must approve',
      });
      return;
    }
    if (identity) {
      attachClientIdentity(req, identity);
      next();
      return;
    }

    const baseUrl = baseUrlFor(req);
    res.setHeader(
      'WWW-Authenticate',
      `Bearer realm="mvmt", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
    );
    logHttpRequest(requestLog, req, 401, authLogKind(req), 'invalid_bearer');
    res.status(401).json({ error: 'Invalid or missing bearer token' });
  };

  const authorizationServerMetadata = (req: Request, res: Response) => {
    const baseUrl = baseUrlFor(req);
    logHttpRequest(requestLog, req, 200, 'oauth.discovery');
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp', 'offline_access'],
    });
  };
  app.get('/.well-known/oauth-authorization-server', authorizationServerMetadata);
  app.get('/.well-known/oauth-authorization-server/mcp', authorizationServerMetadata);

  const protectedResourceMetadata = (req: Request, res: Response) => {
    const baseUrl = baseUrlFor(req);
    logHttpRequest(requestLog, req, 200, 'oauth.resource');
    res.json({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp', 'offline_access'],
    });
  };
  app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata);

  app.post('/register', authLimiter, oauthOriginMiddleware, (req, res) => {
    const requested = (req.body ?? {}) as Record<string, unknown>;
    const requestedClientId = stringField(requested.client_id);
    if (requestedClientId && !validateSessionToken(firstHeaderValue(req.headers.authorization), tokenPath)) {
      logHttpRequest(requestLog, req, 401, 'oauth.register', 'client_id_requires_session_token', requestedClientId);
      res.status(401).json({
        error: 'invalid_client',
        error_description: 'Supplying client_id requires the mvmt session token',
      });
      return;
    }
    const clientId = requestedClientId ?? `mvmt-${randomUUID()}`;
    const clientName = typeof requested.client_name === 'string' ? requested.client_name : undefined;
    const scope = typeof requested.scope === 'string' ? requested.scope : undefined;
    const redirectUris = Array.isArray(requested.redirect_uris)
      ? requested.redirect_uris.filter((uri): uri is string => typeof uri === 'string' && uri.length > 0)
      : [];
    if (redirectUris.length === 0) {
      logHttpRequest(
        requestLog, req, 400, 'oauth.register',
        'missing_redirect_uris', clientId,
      );
      res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' });
      return;
    }
    const redirectHosts: string[] = [];
    for (const uri of redirectUris) {
      try {
        const parsed = new URL(uri);
        redirectHosts.push(parsed.host);
      } catch {
        logHttpRequest(requestLog, req, 400, 'oauth.register', 'invalid_redirect_uri', clientId);
        res.status(400).json({ error: 'invalid_redirect_uri' });
        return;
      }
    }
    let registered;
    try {
      registered = oauth.registerClient({ clientId, redirectUris });
    } catch (err) {
      if (err instanceof OAuthClientAlreadyRegisteredError) {
        logHttpRequest(requestLog, req, 409, 'oauth.register', 'client_id_already_registered', clientId);
        res.status(409).json({
          error: 'invalid_client_metadata',
          error_description: 'client_id is already registered',
        });
        return;
      }
      if (err instanceof OAuthClientPersistenceError) {
        logHttpRequest(requestLog, req, 500, 'oauth.register', 'persist_failed', clientId);
        res.status(500).json({
          error: 'server_error',
          error_description: 'Failed to persist OAuth client registration',
        });
        return;
      }
      if (err instanceof OAuthClientRegistryLimitError) {
        logHttpRequest(requestLog, req, 429, 'oauth.register', 'registry_limit', clientId);
        res.status(429).json({
          error: 'invalid_client_metadata',
          error_description: err.message,
        });
        return;
      }
      throw err;
    }
    const detail = `redirect_uris=${registered.redirectUris.length} hosts=${[...new Set(redirectHosts)].join(',')}${clientName ? ` name="${clientName}"` : ''}`;
    logHttpRequest(requestLog, req, 201, 'oauth.register', detail, clientId);
    // Response shape follows RFC 7591 §3.2.1 (Client Information Response).
    // We are a public client (no client_secret), so token_endpoint_auth_method
    // is "none". client_id_issued_at helps clients audit when they were
    // provisioned. client_name and scope are echoed only when the client
    // supplied them.
    res.status(201).json({
      client_id: registered.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: registered.redirectUris,
      ...(clientName ? { client_name: clientName } : {}),
      ...(scope ? { scope } : {}),
    });
  });

  app.get('/authorize', authLimiter, oauthOriginMiddleware, (req, res) => {
    const parsed = parseAuthorizeParams(req.query);
    if ('error' in parsed) {
      logHttpRequest(requestLog, req, 400, 'oauth.authorize', parsed.error);
      res.status(400).type('text/plain').send(parsed.error);
      return;
    }
    const canonicalResource = `${baseUrlFor(req)}/mcp`;
    const { params, resourceDefaulted } = defaultAuthorizeResource(parsed, canonicalResource);
    if (!oauth.isRedirectUriAllowed(params.clientId, params.redirectUri)) {
      const rejectedHost = safeHost(params.redirectUri);
      logHttpRequest(
        requestLog, req, 400, 'oauth.authorize',
        `unregistered_redirect_uri host=${rejectedHost}`, params.clientId,
      );
      res.status(400).type('text/plain').send('redirect_uri is not registered for this client');
      return;
    }
    const resourceError = validateAuthorizeResource(params.resource, canonicalResource);
    if (resourceError) {
      const redirect = authorizeErrorRedirect(params, 'invalid_target', resourceError.description);
      logHttpRequest(requestLog, req, 302, 'oauth.authorize', resourceError.code, params.clientId);
      res.redirect(302, redirect);
      return;
    }
    const requestId = params.requestId ?? randomUUID();
    const promptDetail = formatAuthorizeLogDetail({
      phase: 'prompt',
      requestId,
      redirectUri: params.redirectUri,
      resource: params.resource,
      resourceDefaulted,
      state: params.state,
    });
    logHttpRequest(requestLog, req, 200, 'oauth.authorize', promptDetail, params.clientId);
    res.type('text/html').send(renderAuthorizePage({ ...params, requestId }));
  });

  app.post('/authorize', authLimiter, oauthOriginMiddleware, (req, res) => {
    const parsed = parseAuthorizeParams(req.body ?? {});
    if ('error' in parsed) {
      logHttpRequest(requestLog, req, 400, 'oauth.authorize', parsed.error);
      res.status(400).type('text/plain').send(parsed.error);
      return;
    }
    const canonicalResource = `${baseUrlFor(req)}/mcp`;
    const { params, resourceDefaulted } = defaultAuthorizeResource(parsed, canonicalResource);
    if (!oauth.isRedirectUriAllowed(params.clientId, params.redirectUri)) {
      const rejectedHost = safeHost(params.redirectUri);
      logHttpRequest(
        requestLog, req, 400, 'oauth.authorize',
        `unregistered_redirect_uri host=${rejectedHost}`, params.clientId,
      );
      res.status(400).type('text/plain').send('redirect_uri is not registered for this client');
      return;
    }
    const resourceError = validateAuthorizeResource(params.resource, canonicalResource);
    if (resourceError) {
      const redirect = authorizeErrorRedirect(params, 'invalid_target', resourceError.description);
      logHttpRequest(requestLog, req, 302, 'oauth.authorize', resourceError.code, params.clientId);
      res.redirect(302, redirect);
      return;
    }

    const requestId = params.requestId ?? randomUUID();
    const approval = resolveAuthorizeApproval(
      req.body ?? {},
      resolveClients(options.clients),
      tokenPath,
      requestClientHint(req, params.clientId),
    );
    if (!approval.ok) {
      const denyDetail = formatAuthorizeLogDetail({
        phase: approval.phase,
        requestId,
        redirectUri: params.redirectUri,
        resource: params.resource,
        resourceDefaulted,
        state: params.state,
      });
      logHttpRequest(requestLog, req, 401, 'oauth.authorize', denyDetail, params.clientId);
      res
        .status(401)
        .type('text/html')
        .send(renderAuthorizePage({ ...params, requestId, error: approval.message }));
      return;
    }

    const authCode = oauth.issueCode({
      clientId: params.clientId,
      mvmtClientId: approval.mvmtClientId,
      mvmtClientCredentialVersion: approval.mvmtClientCredentialVersion,
      redirectUri: params.redirectUri,
      resource: params.resource,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      scope: params.scope,
    });

    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set('code', authCode.code);
    if (params.state) redirect.searchParams.set('state', params.state);
    const approveDetail = formatAuthorizeLogDetail({
      phase: 'approved_redirect',
      requestId,
      redirectUri: params.redirectUri,
      resource: params.resource,
      resourceDefaulted,
      state: params.state,
      authorizedClientId: approval.mvmtClientId,
    });
    logHttpRequest(requestLog, req, 302, 'oauth.authorize', approveDetail, params.clientId);
    res.redirect(302, redirect.toString());
  });

  app.post('/token', authLimiter, oauthOriginMiddleware, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const grantType = typeof body.grant_type === 'string' ? body.grant_type : undefined;
    const requestClientId = typeof body.client_id === 'string' ? body.client_id : undefined;
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
      logHttpRequest(requestLog, req, 400, 'oauth.token', 'unsupported_grant_type');
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }

    try {
      if (grantType === 'authorization_code') {
        const code = typeof body.code === 'string' ? body.code : undefined;
        const clientId = requestClientId;
        const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : undefined;
        const resource = typeof body.resource === 'string' ? body.resource : undefined;
        const codeVerifier = typeof body.code_verifier === 'string' ? body.code_verifier : undefined;

        if (!code || !clientId || !redirectUri || !codeVerifier) {
          logHttpRequest(requestLog, req, 400, 'oauth.token', 'invalid_request', clientId);
          res.status(400).json({ error: 'invalid_request' });
          return;
        }

        const tokens = oauth.exchangeCode({ code, clientId, redirectUri, resource, codeVerifier });
        if (!oauthGrantMatchesCurrentClient(
          tokens.accessToken,
          resolveClients(options.clients),
          requestClientHint(req, clientId),
        )) {
          throw new OAuthError('invalid_grant', 'Scoped API token was rotated or removed');
        }
        const tokenDetail = `issued grant=authorization_code aud=${tokens.accessToken.audience ? safeHost(tokens.accessToken.audience) : '(none)'}`;
        logHttpRequest(requestLog, req, 200, 'oauth.token', tokenDetail, clientId);
        res.json({
          access_token: tokens.accessToken.token,
          token_type: 'Bearer',
          expires_in: oauth.tokenTtlSeconds,
          refresh_token: tokens.refreshToken.token,
          scope: tokens.accessToken.scope,
        });
        return;
      }

      const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : undefined;
      const clientId = requestClientId;
      const scope = typeof body.scope === 'string' ? body.scope : undefined;
      if (!refreshToken || !clientId) {
        logHttpRequest(requestLog, req, 400, 'oauth.token', 'invalid_request', clientId);
        res.status(400).json({ error: 'invalid_request' });
        return;
      }

      const tokens = oauth.exchangeRefreshToken({ refreshToken, clientId, scope });
      if (!oauthGrantMatchesCurrentClient(
        tokens.accessToken,
        resolveClients(options.clients),
        requestClientHint(req, clientId),
      )) {
        throw new OAuthError('invalid_grant', 'Scoped API token was rotated or removed');
      }
      const tokenDetail = `issued grant=refresh_token aud=${tokens.accessToken.audience ? safeHost(tokens.accessToken.audience) : '(none)'}`;
      logHttpRequest(requestLog, req, 200, 'oauth.token', tokenDetail, clientId);
      res.json({
        access_token: tokens.accessToken.token,
        token_type: 'Bearer',
        expires_in: oauth.tokenTtlSeconds,
        refresh_token: tokens.refreshToken.token,
        scope: tokens.accessToken.scope,
      });
    } catch (err) {
      if (err instanceof OAuthError) {
        const status = err.code === 'server_error' ? 500 : 400;
        logHttpRequest(requestLog, req, status, 'oauth.token', err.code, requestClientId);
        res.status(status).json({ error: err.code, error_description: err.message });
        return;
      }
      log.warn(`Token exchange failed: ${err instanceof Error ? err.message : 'unknown'}`);
      logHttpRequest(requestLog, req, 500, 'oauth.token', 'server_error', requestClientId);
      res.status(500).json({ error: 'server_error' });
    }
  });

  const dashboardOriginMiddleware: express.RequestHandler = (req, res, next) => {
    if (originCheck(req) || originMatchesBaseUrl(req, baseUrlFor(req))) {
      next();
      return;
    }
    logHttpRequest(requestLog, req, 403, 'dashboard.origin', 'origin_not_allowed');
    res.status(403).json({ error: 'Origin not allowed' });
  };

  const dashboardAuthMiddleware: express.RequestHandler = (req, res, next) => {
    const session = dashboardSessionForRequest(req, dashboardSessions);
    if (!session) {
      logHttpRequest(requestLog, req, 401, 'dashboard.auth', 'missing_session');
      res.status(401).json({ error: 'dashboard_login_required' });
      return;
    }
    res.locals.dashboardSession = session;
    next();
  };

  // Admin-only endpoints (mount mutation, local filesystem browse). Non-admin
  // dashboard users can still log in, browse the configured mounts, and
  // create/revoke leases — they just can't change the mount config or list
  // arbitrary local directories.
  const dashboardAdminMiddleware: express.RequestHandler = (req, res, next) => {
    const session = res.locals.dashboardSession as DashboardSession | undefined;
    if (!session || !session.admin) {
      logHttpRequest(requestLog, req, 403, 'dashboard.admin', 'not_admin', session?.username);
      res.status(403).json({ error: 'admin_required' });
      return;
    }
    next();
  };

  app.get('/dashboard', (_req, res) => {
    res.status(200).type('html').send(DASHBOARD_PAGE_HTML);
  });

  app.post('/dashboard/api/login', authLimiter, dashboardOriginMiddleware, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof body.username === 'string' ? body.username : undefined;
    const password = typeof body.password === 'string' ? body.password : undefined;
    const user = verifyPrivilegedUserPassword(privilegedUsersPath, username, password);
    if (!user) {
      logHttpRequest(requestLog, req, 401, 'dashboard.login', 'invalid_credentials', username);
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }
    recordPrivilegedUserLogin(privilegedUsersPath, user.id);
    const session = createDashboardSession(user.id, user.username, Boolean(user.admin));
    dashboardSessions.set(session.id, session);
    res.setHeader('Set-Cookie', dashboardSessionCookie(session, baseUrlFor(req)));
    logHttpRequest(requestLog, req, 200, 'dashboard.login', 'ok', user.username);
    res.json({ user: { ...publicDashboardUser(user), admin: Boolean(user.admin) } });
  });

  app.post('/dashboard/api/logout', dashboardOriginMiddleware, dashboardAuthMiddleware, (req, res) => {
    const session = res.locals.dashboardSession as DashboardSession;
    dashboardSessions.delete(session.id);
    res.setHeader('Set-Cookie', clearDashboardSessionCookie(baseUrlFor(req)));
    logHttpRequest(requestLog, req, 200, 'dashboard.logout', 'ok', session.username);
    res.json({ ok: true });
  });

  app.get('/dashboard/api/me', dashboardOriginMiddleware, dashboardAuthMiddleware, (_req, res) => {
    const session = res.locals.dashboardSession as DashboardSession;
    res.json({ user: { username: session.username, admin: session.admin }, localOwner: false });
  });

  app.get('/dashboard/api/mounts', dashboardOriginMiddleware, dashboardAuthMiddleware, (req, res) => {
    const session = res.locals.dashboardSession as DashboardSession;
    const mounts = resolveLeaseMounts(options.leaseMounts);
    logHttpRequest(requestLog, req, 200, 'dashboard.mounts');
    res.json({
      canManage: Boolean(options.configPath) && session.admin,
      mounts: mounts.map((mount) => ({
        name: mount.name,
        path: mount.path,
        // Local filesystem paths are admin-only info; non-admins see the
        // virtual path and base permission, not the on-disk root.
        ...(session.admin ? { root: mount.root } : {}),
        description: mount.description,
        writeAccess: Boolean(mount.writeAccess),
        enabled: mount.enabled !== false,
      })),
    });
  });

  app.get('/dashboard/api/files', dashboardOriginMiddleware, dashboardAuthMiddleware, async (req, res) => {
    const requestPath = firstStringQuery(req.query.path) ?? '/';
    try {
      const listing = await listDashboardFiles(resolveLeaseMounts(options.leaseMounts), requestPath);
      logHttpRequest(requestLog, req, 200, 'dashboard.files', listing.path);
      res.json(listing);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unavailable';
      logHttpRequest(requestLog, req, 404, 'dashboard.files', detail);
      res.status(404).json({ error: 'file_unavailable' });
    }
  });

  app.get('/dashboard/api/leases', dashboardOriginMiddleware, dashboardAuthMiddleware, (req, res) => {
    logHttpRequest(requestLog, req, 200, 'dashboard.leases');
    res.json({ leases: listLeases(leaseStorePath) });
  });

  app.post('/dashboard/api/leases', dashboardOriginMiddleware, dashboardAuthMiddleware, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const mode = typeof body.mode === 'string' ? body.mode.trim().toLowerCase() : 'read';
    const paths = dashboardLeasePaths(body);
    if (!label) {
      res.status(400).json({ error: 'label_required' });
      return;
    }
    if (paths.length === 0) {
      res.status(400).json({ error: 'path_required' });
      return;
    }
    // Dashboard exposes three modes, mapped onto the underlying primitives:
    //   read     → ['read']           browse + download
    //   upload   → ['upload']         drop-box (no download, no overwrite)
    //   two-way  → ['read', 'upload'] browse + download + add new files
    // `write` (overwrite + delete) is intentionally not exposed by the
    // dashboard — see lease/files.ts for collision-suffix semantics.
    const permissions = leasePermissionsForDashboardMode(mode);
    if (!permissions) {
      res.status(400).json({ error: 'invalid_mode' });
      return;
    }
    try {
      const resources = await dashboardLeaseResources(resolveLeaseMounts(options.leaseMounts), paths);
      if (mode !== 'read' && resources.some((resource) => resource.type === 'file')) {
        res.status(400).json({ error: 'mode_requires_folder' });
        return;
      }
      if (permissions.includes('upload') && !(await dashboardLeaseResourcesAreWritable(resolveLeaseMounts(options.leaseMounts), paths))) {
        res.status(400).json({ error: 'mount_read_only' });
        return;
      }
      const ttl = parseTokenTtl(typeof body.expires === 'string' ? body.expires : DEFAULT_DASHBOARD_LEASE_TTL);
      const created = createLease(leaseStorePath, {
        label,
        path: resources[0]!.sourcePath,
        resources,
        expiresAt: ttl.expiresAt,
        permissions: [...permissions],
      });
      const url = leasePublicUrl(baseUrlFor(req), created.record.id, created.token);
      logHttpRequest(requestLog, req, 201, 'dashboard.leases', `created ${created.record.id}`);
      res.status(201).json({ lease: { ...created.record, url } });
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'lease_failed';
      logHttpRequest(requestLog, req, 400, 'dashboard.leases', detail);
      res.status(400).json({ error: 'lease_failed', detail });
    }
  });

  app.post('/dashboard/api/leases/:id/revoke', dashboardOriginMiddleware, dashboardAuthMiddleware, (req, res) => {
    const id = firstStringQuery(req.params.id);
    if (!id || !revokeLease(leaseStorePath, id)) {
      logHttpRequest(requestLog, req, 404, 'dashboard.leases', 'unknown_lease');
      res.status(404).json({ error: 'lease_not_found' });
      return;
    }
    logHttpRequest(requestLog, req, 200, 'dashboard.leases', `revoked ${id}`);
    res.json({ ok: true });
  });

  // Rotates a lease's token, invalidating any previously-issued URL. Used
  // by the dashboard when an admin needs a shareable URL for a lease whose
  // original token is no longer in browser localStorage.
  app.post('/dashboard/api/leases/:id/rotate', dashboardOriginMiddleware, dashboardAuthMiddleware, (req, res) => {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    if (!id) {
      res.status(400).json({ error: 'id_required' });
      return;
    }
    const lease = findLease(leaseStorePath, id);
    if (!lease) {
      logHttpRequest(requestLog, req, 404, 'dashboard.leases', 'unknown_lease');
      res.status(404).json({ error: 'lease_not_found' });
      return;
    }
    if (lease.revokedAt) {
      logHttpRequest(requestLog, req, 410, 'dashboard.leases', 'revoked_lease');
      res.status(410).json({ error: 'lease_revoked' });
      return;
    }
    const rotated = rotateLeaseToken(leaseStorePath, id);
    if (!rotated) {
      logHttpRequest(requestLog, req, 404, 'dashboard.leases', 'unknown_lease');
      res.status(404).json({ error: 'lease_not_found' });
      return;
    }
    const url = leasePublicUrl(baseUrlFor(req), rotated.record.id, rotated.token);
    logHttpRequest(requestLog, req, 200, 'dashboard.leases', `rotated ${id}`);
    res.json({ lease: { ...rotated.record, url } });
  });

  // Mount management endpoints. These persist through the same config file
  // and lock that the CLI uses, so a privileged dashboard user can add,
  // edit, or remove mounts without local shell access. Mutation endpoints
  // require options.configPath; without it they respond 403.
  const requireConfigPath = (req: Request, res: Response): string | undefined => {
    if (!options.configPath) {
      logHttpRequest(requestLog, req, 403, 'dashboard.mounts', 'no_config_path');
      res.status(403).json({ error: 'mount_management_disabled' });
      return undefined;
    }
    return options.configPath;
  };

  app.get('/dashboard/api/browse', dashboardOriginMiddleware, dashboardAuthMiddleware, dashboardAdminMiddleware, async (req, res) => {
    const requestPath = firstStringQuery(req.query.path);
    try {
      const listing = await listLocalDirectory(requestPath);
      logHttpRequest(requestLog, req, 200, 'dashboard.browse', listing.path);
      res.json(listing);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unavailable';
      logHttpRequest(requestLog, req, 404, 'dashboard.browse', detail);
      res.status(404).json({ error: 'path_unavailable' });
    }
  });

  app.post('/dashboard/api/mounts', dashboardOriginMiddleware, dashboardAuthMiddleware, dashboardAdminMiddleware, async (req, res) => {
    const configPath = requireConfigPath(req, res);
    if (!configPath) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const saved = await withConfigLock(configPath, async () => {
        const current = readConfig(configPath);
        const mountInput = mountInputFromBody(body, current.mounts);
        if (typeof mountInput === 'string') throw new Error(mountInput);
        const next = addMountToConfig(current, mountInput);
        await saveConfig(configPath, next);
        return next.mounts.find((mount) => mount.name === mountInput.name);
      });
      if (!saved) throw new Error('mount_failed');
      logHttpRequest(requestLog, req, 201, 'dashboard.mounts', `added ${saved.name}`);
      res.status(201).json({ mount: saved });
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'mount_failed';
      const knownValidation = new Set(['root_required', 'invalid_name', 'invalid_root', 'invalid_path']);
      const error = knownValidation.has(detail) ? detail : 'mount_failed';
      logHttpRequest(requestLog, req, 400, 'dashboard.mounts', detail);
      res.status(400).json({ error, detail });
    }
  });

  app.patch('/dashboard/api/mounts/:name', dashboardOriginMiddleware, dashboardAuthMiddleware, dashboardAdminMiddleware, async (req, res) => {
    const configPath = requireConfigPath(req, res);
    if (!configPath) return;
    const name = typeof req.params.name === 'string' ? req.params.name : '';
    if (!name) {
      res.status(400).json({ error: 'name_required' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch = mountPatchFromBody(body);
    if (typeof patch === 'string') {
      logHttpRequest(requestLog, req, 400, 'dashboard.mounts', patch);
      res.status(400).json({ error: patch });
      return;
    }
    try {
      const saved = await withConfigLock(configPath, async () => {
        const current = readConfig(configPath);
        const next = editMountInConfig(current, name, patch);
        await saveConfig(configPath, next);
        return next.mounts.find((mount) => mount.name === name);
      });
      logHttpRequest(requestLog, req, 200, 'dashboard.mounts', `edited ${name}`);
      res.json({ mount: saved });
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'mount_failed';
      logHttpRequest(requestLog, req, 400, 'dashboard.mounts', detail);
      res.status(400).json({ error: 'mount_failed', detail });
    }
  });

  app.delete('/dashboard/api/mounts/:name', dashboardOriginMiddleware, dashboardAuthMiddleware, dashboardAdminMiddleware, async (req, res) => {
    const configPath = requireConfigPath(req, res);
    if (!configPath) return;
    const name = typeof req.params.name === 'string' ? req.params.name : '';
    if (!name) {
      res.status(400).json({ error: 'name_required' });
      return;
    }
    try {
      await withConfigLock(configPath, async () => {
        const current = readConfig(configPath);
        const next = removeMountFromConfig(current, name);
        await saveConfig(configPath, next);
      });
      logHttpRequest(requestLog, req, 200, 'dashboard.mounts', `removed ${name}`);
      res.json({ ok: true });
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'mount_failed';
      logHttpRequest(requestLog, req, 400, 'dashboard.mounts', detail);
      res.status(400).json({ error: 'mount_failed', detail });
    }
  });

  const authorizeLeaseRequest = (req: Request, res: Response): ReturnType<typeof findLease> => {
    const id = regexParam(req, 0) ?? firstStringQuery(req.params.id);
    const lease = id ? findLease(leaseStorePath, id) : undefined;
    if (!lease) {
      logHttpRequest(requestLog, req, 404, 'lease.request', 'unknown_lease');
      res.status(404).json({ error: 'lease_not_found' });
      return undefined;
    }

    const token = bearerToken(req) ?? firstStringQuery(req.query.token) ?? firstStringQuery(req.query.t);
    if (!validateLeaseToken(lease, token)) {
      logHttpRequest(requestLog, req, 401, 'lease.request', 'invalid_token', lease.id);
      res.status(401).json({ error: 'invalid_lease_token' });
      return undefined;
    }

    const unavailable = leaseUnavailableReason(lease);
    if (unavailable) {
      logHttpRequest(requestLog, req, 410, 'lease.request', unavailable, lease.id);
      res.status(410).json({ error: `lease_${unavailable}` });
      return undefined;
    }
    return lease;
  };

  const leasePageHandler: express.RequestHandler = async (req, res) => {
    const lease = authorizeLeaseRequest(req, res);
    if (!lease) return;
    if (!leaseAllows(lease, 'read')) {
      if (leaseAllows(lease, 'upload')) {
        recordLeaseUse(leaseStorePath, lease.id);
        logHttpRequest(requestLog, req, 200, 'lease.request', 'upload_page', lease.id);
        res.status(200).type('html').send(LEASE_UPLOAD_PAGE_HTML);
        return;
      }
      logHttpRequest(requestLog, req, 403, 'lease.request', 'permission_denied', lease.id);
      res.status(403).json({ error: 'lease_permission_denied' });
      return;
    }
    recordLeaseUse(leaseStorePath, lease.id);
    logHttpRequest(requestLog, req, 200, 'lease.request', 'browser_page', lease.id);
    res.status(200).type('html').send(LEASE_BROWSER_PAGE_HTML);
  };

  const leaseFilesHandler: express.RequestHandler = async (req, res) => {
    const lease = authorizeLeaseRequest(req, res);
    if (!lease) return;
    if (!leaseAllows(lease, 'read')) {
      logHttpRequest(requestLog, req, 403, 'lease.request', 'permission_denied', lease.id);
      res.status(403).json({ error: 'lease_permission_denied' });
      return;
    }
    const requestPath = regexParam(req, 1) ?? firstStringQuery(req.query.path) ?? '';

    try {
      const listing = await listLeaseDirectory(resolveLeaseMounts(options.leaseMounts), lease, requestPath);
      recordLeaseUse(leaseStorePath, lease.id);
      logHttpRequest(requestLog, req, 200, 'lease.request', listing.path, lease.id);
      res.status(200).json({
        ...listing,
        canUpload: leaseAllows(lease, 'upload') || leaseAllows(lease, 'write'),
      });
      return;
    } catch {
      // If it is not a directory, try serving it as a file below.
    }

    let target;
    try {
      target = await resolveLeaseFileTarget(resolveLeaseMounts(options.leaseMounts), lease, requestPath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unavailable';
      logHttpRequest(requestLog, req, 404, 'lease.request', detail, lease.id);
      res.status(404).json({ error: 'lease_target_unavailable' });
      return;
    }

    const range = parseRangeHeader(firstHeaderValue(req.headers.range), target.size);
    if (range === 'invalid') {
      res.setHeader('Content-Range', `bytes */${target.size}`);
      logHttpRequest(requestLog, req, 416, 'lease.request', 'invalid_range', lease.id);
      res.status(416).end();
      return;
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, target.size - 1);
    const status = range ? 206 : 200;
    res.status(status);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${escapeHeaderValue(target.filename)}"`);
    res.setHeader('Content-Length', String(target.size === 0 ? 0 : end - start + 1));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Last-Modified', new Date(target.mtimeMs).toUTCString());
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${target.size}`);

    logHttpRequest(requestLog, req, status, 'lease.request', target.leaseRelativePath || '/', lease.id);
    if (req.method === 'HEAD') {
      recordLeaseUse(leaseStorePath, lease.id);
      res.end();
      return;
    }

    res.on('finish', () => {
      if (res.statusCode < 400) {
        try {
          recordLeaseUse(leaseStorePath, lease.id, { downloaded: true });
        } catch {
          // Never let lease accounting break a download.
        }
      }
    });
    createReadStream(target.realPath, target.size === 0 ? {} : { start, end })
      .on('error', () => {
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
      })
      .pipe(res);
  };

  const leaseUploadHandler: express.RequestHandler = async (req, res) => {
    const lease = authorizeLeaseRequest(req, res);
    if (!lease) return;
    const allowOverwrite = leaseAllows(lease, 'write');
    const allowUpload = leaseAllows(lease, 'upload');
    if (!allowUpload && !allowOverwrite) {
      logHttpRequest(requestLog, req, 403, 'lease.request', 'permission_denied', lease.id);
      res.status(403).json({ error: 'lease_permission_denied' });
      return;
    }
    // Drop-box semantics: when the lease has upload but not write, the
    // recipient cannot overwrite an existing file. On a name collision we
    // suffix the upload (`note.txt` → `note (2).txt`) so two recipients
    // dropping the same filename never clobber each other.
    const suffixOnCollision = allowUpload && !allowOverwrite;

    const contentLength = parseContentLength(firstHeaderValue(req.headers['content-length']));
    if (contentLength === 'invalid') {
      logHttpRequest(requestLog, req, 400, 'lease.upload', 'invalid_content_length', lease.id);
      res.status(400).json({ error: 'invalid_content_length' });
      return;
    }
    if (contentLength !== undefined && contentLength > DEFAULT_MAX_LEASE_UPLOAD_BYTES) {
      logHttpRequest(requestLog, req, 413, 'lease.upload', 'upload_too_large', lease.id);
      res.status(413).json({ error: 'lease_upload_too_large' });
      return;
    }

    const requestPath = regexParam(req, 1) ?? firstStringQuery(req.query.path) ?? '';
    let target;
    try {
      target = await resolveLeaseUploadTarget(resolveLeaseMounts(options.leaseMounts), lease, requestPath, { allowOverwrite, suffixOnCollision });
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unavailable';
      const exists = detail.includes('already exists');
      logHttpRequest(requestLog, req, exists ? 409 : 404, 'lease.upload', detail, lease.id);
      res.status(exists ? 409 : 404).json({ error: exists ? 'lease_upload_exists' : 'lease_target_unavailable' });
      return;
    }

    try {
      const bytes = await writeLeaseUpload(req, target.parentRealPath, target.realPath, DEFAULT_MAX_LEASE_UPLOAD_BYTES, { overwrite: allowOverwrite });
      recordLeaseUse(leaseStorePath, lease.id, { uploaded: true });
      const status = allowOverwrite ? 200 : 201;
      const savedPath = target.leaseRelativePath ? `/${target.leaseRelativePath}` : '/';
      logHttpRequest(requestLog, req, status, 'lease.upload', target.leaseRelativePath, lease.id);
      res.status(status).json({ path: savedPath, filename: target.filename, bytes });
    } catch (err) {
      const status = err instanceof LeaseUploadTooLargeError ? 413 : isNodeErrorCode(err, 'EEXIST') ? 409 : 500;
      const error = status === 413 ? 'lease_upload_too_large' : status === 409 ? 'lease_upload_exists' : 'lease_upload_failed';
      const detail = err instanceof Error ? err.message : error;
      logHttpRequest(requestLog, req, status, 'lease.upload', detail, lease.id);
      res.status(status).json({ error });
    }
  };

  const leaseDeleteHandler: express.RequestHandler = async (req, res) => {
    const lease = authorizeLeaseRequest(req, res);
    if (!lease) return;
    if (!leaseAllows(lease, 'write')) {
      logHttpRequest(requestLog, req, 403, 'lease.delete', 'permission_denied', lease.id);
      res.status(403).json({ error: 'lease_permission_denied' });
      return;
    }
    const requestPath = regexParam(req, 1) ?? firstStringQuery(req.query.path) ?? '';
    let target;
    try {
      target = await resolveLeaseFileTarget(resolveLeaseMounts(options.leaseMounts), lease, requestPath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unavailable';
      logHttpRequest(requestLog, req, 404, 'lease.delete', detail, lease.id);
      res.status(404).json({ error: 'lease_target_unavailable' });
      return;
    }
    try {
      await fsp.unlink(target.realPath);
      logHttpRequest(requestLog, req, 200, 'lease.delete', target.leaseRelativePath || '/', lease.id);
      res.json({ ok: true });
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'delete_failed';
      logHttpRequest(requestLog, req, 500, 'lease.delete', detail, lease.id);
      res.status(500).json({ error: 'lease_delete_failed' });
    }
  };

  const leaseFilesRoute = /^\/lease\/([^/]+)\/files(?:\/(.*))?$/;
  app.get('/lease/:id', mcpLimiter, leasePageHandler);
  app.get(leaseFilesRoute, mcpLimiter, leaseFilesHandler);
  app.head(leaseFilesRoute, mcpLimiter, leaseFilesHandler);
  app.put(leaseFilesRoute, mcpLimiter, leaseUploadHandler);
  app.delete(leaseFilesRoute, mcpLimiter, leaseDeleteHandler);

  app.post('/mcp', mcpLimiter, authMiddleware, async (req, res) => {
    await handleMcpRequest(req, res, router, sessions);
    logHttpRequest(requestLog, req, res.statusCode, 'mcp.request');
  });

  app.get('/mcp', mcpLimiter, authMiddleware, async (req, res) => {
    await handleMcpRequest(req, res, router, sessions);
    logHttpRequest(requestLog, req, res.statusCode, 'mcp.request');
  });

  app.delete('/mcp', mcpLimiter, authMiddleware, async (req, res) => {
    const sessionId = getSessionId(req);
    if (!sessionId || !sessions.has(sessionId)) {
      logHttpRequest(requestLog, req, 404, 'mcp.request', 'session_not_found');
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const session = sessions.get(sessionId)!;
    await session.transport.close();
    sessions.delete(sessionId);
    logHttpRequest(requestLog, req, 200, 'mcp.request');
    res.status(200).json({ ok: true });
  });

  app.get('/health', healthLimiter, authMiddleware, (_req, res) => {
    logHttpRequest(requestLog, _req, 200, 'health.request');
    res.json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      tools: router.getAllTools(readClientIdentity(_req)).length,
      sessions: sessions.size,
    });
  });

  let httpServer: HttpServer;
  try {
    httpServer = await new Promise<HttpServer>((resolve, reject) => {
      const server = app.listen(port, '127.0.0.1', () => {
        resolve(server);
      });
      server.on('error', reject);
    });
  } catch (err) {
    clearInterval(oauthCleanup);
    clearInterval(cleanupInterval);
    throw err;
  }

  const address = httpServer.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;

  let closed = false;
  return {
    port: actualPort,
    close: async () => {
      if (closed) return;
      closed = true;

      clearInterval(oauthCleanup);
      clearInterval(cleanupInterval);

      const activeSessions = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(activeSessions.map((session) => session.transport.close()));
      await closeHttpServer(httpServer);
    },
  };
}

async function handleMcpRequest(
  req: Request,
  res: Response,
  router: ToolRouter,
  sessions: Map<string, McpSession>,
): Promise<void> {
  const sessionId = getSessionId(req);

  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    const requestIdentity = readClientIdentity(req);
    if (!sameClientIdentity(session.clientIdentity, requestIdentity)) {
      res.status(403).json({ error: 'mcp_session_client_mismatch' });
      return;
    }
    session.clientIdentity = requestIdentity;
    session.clientIdentityRef.current = requestIdentity;
    session.lastActivity = Date.now();
    if (isStandaloneSseRequest(req)) {
      session.transport.closeStandaloneSSEStream();
    }
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  if (sessionId) {
    await handleStatelessMcpRequest(req, res, router);
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  const clientIdentityRef: ClientIdentityRef = { current: readClientIdentity(req) };
  const server = createMcpServer(router, () => clientIdentityRef.current);

  transport.onerror = (error) => {
    if (isBenignDuplicateSseConflict(error)) {
      log.debug(`MCP transport notice: ${error.message}`);
      return;
    }
    log.warn(`MCP transport error: ${error.message}`);
  };

  await server.connect(transport);

  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  await transport.handleRequest(req, res, req.body);

  if (transport.sessionId) {
    sessions.set(transport.sessionId, {
      transport,
      server,
      clientIdentityRef,
      clientIdentity: clientIdentityRef.current,
      lastActivity: Date.now(),
    });
  }
}

async function handleStatelessMcpRequest(req: Request, res: Response, router: ToolRouter): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = createMcpServer(router, readClientIdentity(req));

  transport.onerror = (error) => {
    if (isBenignDuplicateSseConflict(error)) {
      log.debug(`MCP transport notice: ${error.message}`);
      return;
    }
    log.warn(`MCP transport error: ${error.message}`);
  };

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

function sameClientIdentity(left: ClientIdentity | undefined, right: ClientIdentity | undefined): boolean {
  return left?.id === right?.id;
}

function authLogKind(req: Request): string {
  if (req.path === '/mcp') return 'mcp.auth';
  if (req.path === '/health') return 'health.auth';
  return 'http.auth';
}

function resolveAllowLegacyDefaultClient(value: HttpServerOptions['allowLegacyDefaultClient']): boolean | undefined {
  return typeof value === 'function' ? value() : value;
}

function resolveClients(value: HttpServerOptions['clients']): readonly ClientConfig[] {
  return (typeof value === 'function' ? value() : value) ?? [];
}

function resolveLeaseMounts(value: HttpServerOptions['leaseMounts']): readonly LocalFolderMountConfig[] {
  return (typeof value === 'function' ? value() : value) ?? [];
}

function identityFromLease(lease: LeaseRecord): ClientIdentity {
  return {
    id: `lease:${lease.id}`,
    name: `Lease: ${lease.label}`,
    source: 'lease',
    rawToolsEnabled: false,
    permissions: leaseAllows(lease, 'read')
      ? leaseResources(lease).map((resource) => ({
          path: resource.type === 'folder' ? `${stripTrailingSlashes(resource.sourcePath)}/**` : resource.sourcePath,
          actions: leaseAllows(lease, 'write')
            ? ['search' as const, 'read' as const, 'write' as const]
            : ['search' as const, 'read' as const],
        }))
      : [],
  };
}

function logHttpRequest(
  requestLog: ((entry: HttpRequestLogEntry) => void) | undefined,
  req: Request,
  status: number,
  kind: string,
  detail?: string,
  clientId?: string,
): void {
  if (!requestLog) return;
  const ip = remoteAddressFor(req);
  requestLog({
    ts: new Date().toISOString(),
    kind,
    method: req.method,
    path: req.path,
    status,
    ...(detail ? { detail } : {}),
    ...(clientId ? { clientId } : {}),
    ...(ip ? { ip } : {}),
  });
}

function remoteAddressFor(req: Request): string | undefined {
  const raw = req.socket?.remoteAddress;
  if (!raw) return undefined;
  // Strip the IPv4-mapped IPv6 prefix so logs show 127.0.0.1 instead of ::ffff:127.0.0.1.
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

function getSessionId(req: Request): string | undefined {
  const header = req.headers['mcp-session-id'];
  return Array.isArray(header) ? header[0] : header;
}

export function isStandaloneSseRequest(req: Request): boolean {
  return req.method === 'GET' && headerIncludes(req.headers.accept, 'text/event-stream');
}

export function isBenignDuplicateSseConflict(error: Error): boolean {
  return error.message === 'Conflict: Only one SSE stream is allowed per session';
}

function headerIncludes(value: string | string[] | undefined, needle: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => entry.includes(needle));
  return value?.includes(needle) ?? false;
}

function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const forceCloseTimer = setTimeout(() => {
      server.closeAllConnections?.();
    }, 1000);
    forceCloseTimer.unref();

    server.close((err) => {
      clearTimeout(forceCloseTimer);
      if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(err);
        return;
      }
      resolve();
    });
    server.closeIdleConnections?.();
  });
}

type AuthorizeParams = {
  responseType: string;
  clientId: string;
  redirectUri: string;
  resource?: string;
  state?: string;
  requestId?: string;
  scope?: string;
  codeChallenge: string;
  codeChallengeMethod: CodeChallengeMethod;
};

function parseAuthorizeParams(source: Record<string, unknown>): AuthorizeParams | { error: string } {
  const responseType = stringField(source.response_type);
  const clientId = stringField(source.client_id);
  const redirectUri = stringField(source.redirect_uri);
  const resource = stringField(source.resource);
  const codeChallenge = stringField(source.code_challenge);
  const codeChallengeMethodRaw = stringField(source.code_challenge_method) ?? 'S256';

  if (!responseType) return { error: 'Missing response_type' };
  if (responseType !== 'code') return { error: 'Only response_type=code is supported' };
  if (!clientId) return { error: 'Missing client_id' };
  if (!redirectUri) return { error: 'Missing redirect_uri' };
  if (!codeChallenge) return { error: 'Missing code_challenge (PKCE required)' };

  try {
    new URL(redirectUri);
  } catch {
    return { error: 'Invalid redirect_uri' };
  }
  if (codeChallengeMethodRaw !== 'S256') {
    return { error: 'Unsupported code_challenge_method (S256 required)' };
  }

  return {
    responseType,
    clientId,
    redirectUri,
    resource,
    state: stringField(source.state),
    requestId: stringField(source.request_id),
    scope: stringField(source.scope),
    codeChallenge,
    codeChallengeMethod: 'S256',
  };
}

function defaultAuthorizeResource(
  params: AuthorizeParams,
  canonicalResource: string,
): { params: AuthorizeParams; resourceDefaulted: boolean } {
  if (params.resource) return { params, resourceDefaulted: false };
  return {
    params: { ...params, resource: canonicalResource },
    resourceDefaulted: true,
  };
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

type ResourceValidationError = {
  code: 'missing_resource' | 'invalid_resource';
  description: string;
};

function validateAuthorizeResource(resource: string | undefined, expectedResource: string): ResourceValidationError | undefined {
  if (!resource) return { code: 'missing_resource', description: 'Missing resource' };
  const normalized = normalizeResourceUrl(resource);
  const expected = normalizeResourceUrl(expectedResource);
  if (!normalized || !expected || normalized !== expected) {
    return { code: 'invalid_resource', description: 'Invalid resource' };
  }
  return undefined;
}

function normalizeResourceUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.hash) return undefined;
    const pathname = stripTrailingSlashes(parsed.pathname) || '/';
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}${parsed.search}`;
  } catch {
    return undefined;
  }
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

function authorizeErrorRedirect(
  params: Pick<AuthorizeParams, 'redirectUri' | 'state'>,
  error: string,
  description: string,
): string {
  const redirect = new URL(params.redirectUri);
  redirect.searchParams.set('error', error);
  redirect.searchParams.set('error_description', description);
  if (params.state) redirect.searchParams.set('state', params.state);
  return redirect.toString();
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function firstStringQuery(value: unknown): string | undefined {
  if (Array.isArray(value)) return firstStringQuery(value[0]);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function regexParam(req: Request, index: number): string | undefined {
  const value = (req.params as Record<string, string | undefined>)[String(index)];
  return value && value.length > 0 ? value : undefined;
}

function bearerToken(req: Request): string | undefined {
  const header = firstHeaderValue(req.headers.authorization);
  if (!header) return undefined;
  const scheme = 'bearer';
  if (header.slice(0, scheme.length).toLowerCase() !== scheme) return undefined;
  let index = scheme.length;
  if (!isHttpWhitespace(header[index])) return undefined;
  while (isHttpWhitespace(header[index])) index += 1;
  const token = header.slice(index).trim();
  return token.length > 0 ? token : undefined;
}

function isHttpWhitespace(value: string | undefined): boolean {
  return value === ' ' || value === '\t';
}

type ByteRange = { start: number; end: number };

function parseRangeHeader(value: string | undefined, size: number): ByteRange | 'invalid' | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return 'invalid';
  if (size <= 0) return 'invalid';
  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return 'invalid';
  if (!startRaw) {
    const suffixLength = Number(endRaw);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return 'invalid';
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(startRaw);
  const end = endRaw ? Number(endRaw) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

function escapeHeaderValue(value: string): string {
  return value.replace(/["\\\r\n]/g, '_');
}

function parseContentLength(value: string | undefined): number | 'invalid' | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 'invalid';
  return parsed;
}

class LeaseUploadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Lease upload exceeds ${maxBytes} bytes`);
  }
}

async function writeLeaseUpload(
  req: Request,
  parentRealPath: string,
  targetRealPath: string,
  maxBytes: number,
  options: { overwrite: boolean },
): Promise<number> {
  const tempPath = path.join(parentRealPath, `.mvmt-upload-${process.pid}-${randomUUID()}.tmp`);
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new LeaseUploadTooLargeError(maxBytes));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(req, meter, createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }));
    if (options.overwrite) {
      await fsp.rename(tempPath, targetRealPath);
    } else {
      await fsp.link(tempPath, targetRealPath);
    }
    return bytes;
  } finally {
    await fsp.unlink(tempPath).catch(() => undefined);
  }
}

function isNodeErrorCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code;
}

function createDashboardSession(userId: string, username: string, admin: boolean): DashboardSession {
  return {
    id: randomUUID(),
    userId,
    username,
    expiresAt: Date.now() + DASHBOARD_SESSION_TTL_MS,
    admin,
  };
}

function dashboardSessionForRequest(
  req: Request,
  sessions: ReadonlyMap<string, DashboardSession>,
): DashboardSession | undefined {
  const cookies = parseCookieHeader(firstHeaderValue(req.headers.cookie));
  const id = cookies[DASHBOARD_SESSION_COOKIE];
  if (!id) return undefined;
  const session = sessions.get(id);
  if (!session || session.expiresAt <= Date.now()) return undefined;
  return session;
}

function dashboardSessionCookie(session: DashboardSession, baseUrl: string): string {
  const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
  const secure = baseUrl.startsWith('https://') ? '; Secure' : '';
  return `${DASHBOARD_SESSION_COOKIE}=${encodeURIComponent(session.id)}; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function clearDashboardSessionCookie(baseUrl: string): string {
  const secure = baseUrl.startsWith('https://') ? '; Secure' : '';
  return `${DASHBOARD_SESSION_COOKIE}=; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      result[key] = part.slice(index + 1).trim();
    }
  }
  return result;
}

function publicDashboardUser(user: PrivilegedUser): { id: string; username: string; createdAt: string; lastLoginAt?: string } {
  return {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt,
    ...(user.lastLoginAt ? { lastLoginAt: user.lastLoginAt } : {}),
  };
}

function dashboardLeasePaths(body: Record<string, unknown>): string[] {
  if (Array.isArray(body.paths)) {
    return body.paths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  }
  return typeof body.path === 'string' && body.path.trim().length > 0 ? [body.path] : [];
}

interface LocalDirectoryEntry {
  name: string;
  path: string;
  type: 'directory' | 'file';
}

interface LocalDirectoryListing {
  path: string;
  parent?: string;
  entries: LocalDirectoryEntry[];
}

async function listLocalDirectory(requestPath: string | undefined): Promise<LocalDirectoryListing> {
  const target = requestPath && requestPath.trim().length > 0
    ? path.resolve(expandHomePrefix(requestPath.trim()))
    : os.homedir();
  const stat = await fsp.stat(target);
  if (!stat.isDirectory()) throw new Error(`${target} is not a directory`);
  const dirents = await fsp.readdir(target, { withFileTypes: true });
  const entries: LocalDirectoryEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() && !dirent.isFile()) continue;
    entries.push({
      name: dirent.name,
      path: path.join(target, dirent.name),
      type: dirent.isDirectory() ? 'directory' : 'file',
    });
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const parent = path.dirname(target);
  return {
    path: target,
    ...(parent !== target ? { parent } : {}),
    entries,
  };
}

function expandHomePrefix(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function mountInputFromBody(
  body: Record<string, unknown>,
  existing: readonly { name: string }[],
): MountInput | string {
  const root = typeof body.root === 'string' ? body.root.trim() : '';
  if (!root) return 'root_required';
  const rawName = typeof body.name === 'string' ? body.name.trim() : '';
  const name = rawName || nextAvailableMountName(defaultMountNameFromRoot(root), existing);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return 'invalid_name';
  const mountPath = typeof body.path === 'string' && body.path.trim().length > 0 ? body.path.trim() : undefined;
  return {
    name,
    root,
    ...(mountPath ? { path: mountPath } : {}),
    writeAccess: Boolean(body.writeAccess),
    ...(typeof body.description === 'string' ? { description: body.description } : {}),
    ...(typeof body.guidance === 'string' ? { guidance: body.guidance } : {}),
    enabled: body.enabled === false ? false : true,
  };
}

function mountPatchFromBody(body: Record<string, unknown>): Partial<MountInput> | string {
  const patch: Partial<MountInput> = {};
  if (body.root !== undefined) {
    if (typeof body.root !== 'string' || body.root.trim().length === 0) return 'invalid_root';
    patch.root = body.root.trim();
  }
  if (body.path !== undefined) {
    if (typeof body.path !== 'string' || body.path.trim().length === 0) return 'invalid_path';
    patch.path = body.path.trim();
  }
  if (body.writeAccess !== undefined) patch.writeAccess = Boolean(body.writeAccess);
  if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
  if (typeof body.description === 'string') patch.description = body.description;
  if (typeof body.guidance === 'string') patch.guidance = body.guidance;
  return patch;
}

// Use the basename only so an auto-generated mount name doesn't leak full
// local paths or usernames (`/Users/alice/code/foo` → `foo`, not
// `users-alice-code-foo`). When the basename is empty or invalid, fall back
// to "mount" and let the collision-suffix step pick a free name.
function defaultMountNameFromRoot(root: string): string {
  const last = root.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? '';
  const slug = last
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug || !/^[a-z0-9]/.test(slug)) return 'mount';
  return slug;
}

function nextAvailableMountName(base: string, existing: readonly { name: string }[]): string {
  const taken = new Set(existing.map((entry) => entry.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 10_000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

async function dashboardLeaseResources(
  mounts: readonly LocalFolderMountConfig[],
  paths: string[],
): Promise<LeaseResource[]> {
  const resources: LeaseResource[] = [];
  for (const inputPath of paths) {
    const target = await resolveDashboardFileTarget(mounts, inputPath);
    resources.push({
      path: resourcePathForDashboardPath(target.virtualPath),
      sourcePath: target.virtualPath,
      type: target.type === 'file' ? 'file' : 'folder',
    });
  }
  return uniqueDashboardLeaseResources(resources);
}

async function dashboardLeaseResourcesAreWritable(
  mounts: readonly LocalFolderMountConfig[],
  paths: string[],
): Promise<boolean> {
  for (const inputPath of paths) {
    const target = await resolveDashboardFileTarget(mounts, inputPath);
    if (!target.writeAccess) return false;
  }
  return true;
}

function leasePermissionsForDashboardMode(mode: string): readonly ('read' | 'upload')[] | undefined {
  if (mode === 'read') return ['read'];
  if (mode === 'upload') return ['upload'];
  if (mode === 'two-way' || mode === 'two_way' || mode === 'read+upload') return ['read', 'upload'];
  return undefined;
}

function resourcePathForDashboardPath(inputPath: string): string {
  const segments = normalizeDashboardPath(inputPath).split('/').filter(Boolean);
  return `/${segments.join('-') || 'resource'}`;
}

function uniqueDashboardLeaseResources(resources: LeaseResource[]): LeaseResource[] {
  const seen = new Set<string>();
  const unique: LeaseResource[] = [];
  for (const resource of resources) {
    const key = `${resource.sourcePath}:${resource.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(resource);
  }
  return unique;
}

function leasePublicUrl(baseUrl: string, id: string, token: string): string {
  const url = new URL(`/lease/${encodeURIComponent(id)}`, baseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

const DASHBOARD_PAGE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mvmt</title>
<style>
:root{
  --bg:#f5f6f8;--panel:#fff;--text:#0f172a;--text-2:#475569;--muted:#94a3b8;
  --border:#e4e7ec;--border-strong:#cbd5e1;--hover:#f1f5f9;
  --accent:#0f766e;--accent-2:#115e59;--accent-soft:#ccfbf1;
  --danger:#b91c1c;--danger-soft:#fee2e2;
  --warn:#b45309;--warn-soft:#fef3c7;
  --ok:#15803d;--ok-soft:#dcfce7;
  --info:#0369a1;--info-soft:#e0f2fe;
  --shadow:0 1px 2px rgba(15,23,42,.04),0 1px 3px rgba(15,23,42,.04);
  --shadow-lg:0 10px 25px rgba(15,23,42,.12),0 4px 10px rgba(15,23,42,.06);
  --radius:10px;--radius-sm:6px;
}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
header.top{background:#fff;border-bottom:1px solid var(--border);padding:.85rem 1.5rem;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:5}
.brand{display:flex;align-items:center;gap:.5rem;font-weight:700;font-size:1.05rem;letter-spacing:-.01em}
.brand .dot{width:.55rem;height:.55rem;border-radius:50%;background:var(--accent)}
.brand-sub{color:var(--text-2);font-weight:500;font-size:.85rem;margin-left:.35rem}
.user-strip{display:flex;align-items:center;gap:.6rem}
.user-strip .who{display:inline-flex;align-items:center;gap:.4rem;padding:.25rem .6rem;border-radius:999px;background:var(--hover);color:var(--text-2);font-size:.85rem}
main{max-width:1180px;margin:0 auto;padding:1.5rem}
h1,h2,h3,h4{margin:0;font-weight:600;letter-spacing:-.01em;color:var(--text)}
h2{font-size:1.05rem}
h3{font-size:.95rem}
h4{font-size:.9rem}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.muted{color:var(--text-2)}
.subtle{color:var(--muted);font-size:.82rem}
.hidden{display:none !important}
/* Buttons */
.btn{font:inherit;display:inline-flex;align-items:center;gap:.4rem;padding:.45rem .85rem;background:#fff;color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;font-weight:500;line-height:1.2;transition:background .12s,border-color .12s,color .12s}
.btn:hover{background:var(--hover);border-color:var(--border-strong)}
.btn:disabled{opacity:.55;cursor:not-allowed}
.btn-primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.btn-primary:hover{background:var(--accent-2);border-color:var(--accent-2)}
.btn-danger{color:var(--danger);border-color:var(--border)}
.btn-danger:hover{background:var(--danger-soft);border-color:var(--danger);color:var(--danger)}
.btn-ghost{background:transparent;border-color:transparent;color:var(--text-2)}
.btn-ghost:hover{background:var(--hover);color:var(--text)}
.btn-sm{padding:.32rem .7rem;font-size:.82rem}
.btn-icon{padding:.4rem;width:2rem;height:2rem;justify-content:center}
.btn .icon{width:1rem;height:1rem;flex:none}
/* Inputs */
input,select,textarea{font:inherit;color:var(--text);padding:.5rem .65rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:#fff;width:100%;outline:none;transition:border-color .12s,box-shadow .12s}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(15,118,110,.15)}
label{font-size:.82rem;color:var(--text-2);font-weight:500}
/* Panel / card */
.panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:1rem 1.25rem 1.1rem;margin-bottom:1rem}
.panel-head{display:flex;justify-content:space-between;align-items:center;gap:.75rem;margin-bottom:.85rem;flex-wrap:wrap}
.panel-title{display:flex;align-items:baseline;gap:.5rem}
.panel-title .count{color:var(--muted);font-size:.85rem;font-weight:500}
/* Table */
.tablewrap{border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;background:#fff}
table.t{border-collapse:collapse;width:100%}
.t th{font-size:.7rem;font-weight:600;color:var(--text-2);background:#fafbfc;text-transform:uppercase;letter-spacing:.05em;padding:.55rem .85rem;text-align:left;border-bottom:1px solid var(--border)}
.t td{padding:.6rem .85rem;border-bottom:1px solid var(--border);font-size:.88rem;vertical-align:middle;color:var(--text)}
.t tbody tr:last-child td{border-bottom:none}
.t tbody tr{transition:background .1s}
.t tbody tr:hover{background:var(--hover)}
.t tbody tr.selected{background:var(--accent-soft)}
.cell-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem;color:var(--text-2);word-break:break-all}
.cell-name{display:flex;align-items:center;gap:.5rem;min-width:0}
.cell-name .icon{color:var(--muted);flex:none}
.cell-name a{color:var(--text);font-weight:500}
.cell-name a:hover{color:var(--accent);text-decoration:none}
.cell-name .name-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.t .actions{display:flex;gap:.35rem;justify-content:flex-end;white-space:nowrap}
.t .actions .btn{padding:.3rem .65rem;font-size:.8rem}
.t .actions .btn-icon{padding:.32rem;width:1.8rem;height:1.8rem}
.cell-num{text-align:right;font-variant-numeric:tabular-nums;color:var(--text-2);font-size:.82rem}
/* Badges */
.badge{display:inline-flex;align-items:center;gap:.3rem;padding:.15rem .55rem;border-radius:999px;font-size:.7rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;line-height:1.5;border:1px solid transparent}
.badge.read{background:var(--info-soft);color:var(--info);border-color:#bae6fd}
.badge.write,.badge.upload{background:var(--warn-soft);color:var(--warn);border-color:#fde68a}
.badge.readonly{background:#f1f5f9;color:var(--text-2);border-color:#e2e8f0}
.badge.active{background:var(--ok-soft);color:var(--ok);border-color:#bbf7d0}
.badge.expired,.badge.revoked{background:var(--danger-soft);color:var(--danger);border-color:#fecaca}
.badge .dot{width:.4rem;height:.4rem;border-radius:50%;background:currentColor}
/* Breadcrumbs */
.crumbs{display:flex;gap:.3rem;align-items:center;flex-wrap:wrap;font-size:.88rem;margin-bottom:.65rem;padding:.4rem .65rem;background:var(--hover);border-radius:var(--radius-sm)}
.crumbs a{color:var(--text-2);padding:.05rem .25rem;border-radius:4px}
.crumbs a:hover{background:#fff;color:var(--text);text-decoration:none}
.crumbs .sep{color:var(--muted);font-size:.85rem}
.crumbs .current{color:var(--text);font-weight:600;padding:.05rem .25rem}
/* Empty state */
.empty{padding:1.5rem .5rem;text-align:center;color:var(--text-2);font-size:.9rem}
.empty .icon{width:2rem;height:2rem;color:var(--muted);margin:0 auto .5rem;display:block}
.empty strong{display:block;color:var(--text);font-weight:600;margin-bottom:.2rem}
/* Tabs */
.tabs{display:flex;gap:.1rem;border-bottom:1px solid var(--border);margin-bottom:.85rem}
.tab{padding:.55rem .9rem;background:transparent;color:var(--text-2);border:none;border-bottom:2px solid transparent;cursor:pointer;font-weight:500;font-size:.85rem;border-radius:0;transition:color .1s,border-color .1s}
.tab:hover{color:var(--text)}
.tab.active{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
/* Login */
.login-card{max-width:380px;margin:5rem auto 0;padding:1.75rem 1.75rem 1.5rem}
.login-card h2{margin-bottom:1rem}
.login-card form{display:flex;flex-direction:column;gap:.65rem}
/* Form rows */
.form-grid{display:grid;grid-template-columns:140px 1fr;gap:.7rem 1rem;align-items:center}
.form-grid label{align-self:center}
.form-grid .field-help{grid-column:2;color:var(--text-2);font-size:.78rem;margin-top:-.35rem}
.form-grid .perm-note{grid-column:2;color:var(--danger);font-size:.8rem}
/* Mode tiles */
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:.6rem;margin-bottom:1rem}
.tile{background:#fff;border:1.5px solid var(--border);border-radius:var(--radius-sm);padding:.85rem;text-align:left;cursor:pointer;transition:border-color .1s,background .1s;display:flex;flex-direction:column;gap:.4rem;font:inherit;color:var(--text)}
.tile:hover{border-color:var(--border-strong);background:#fafbfc}
.tile.selected{border-color:var(--accent);background:var(--accent-soft)}
.tile.disabled{opacity:.45;cursor:not-allowed;background:var(--hover)}
.tile .tile-head{display:flex;align-items:center;gap:.4rem}
.tile .icon{width:1.1rem;height:1.1rem;color:var(--accent)}
.tile .tile-title{font-weight:600;font-size:.9rem}
.tile .tile-desc{color:var(--text-2);font-size:.78rem;line-height:1.4}
/* Modal */
.modal{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:flex-start;justify-content:center;padding:3rem 1rem;z-index:50;overflow:auto;backdrop-filter:blur(2px)}
.modal-card{background:#fff;border-radius:12px;width:100%;max-width:540px;box-shadow:var(--shadow-lg);overflow:hidden;animation:pop .15s ease-out}
@keyframes pop{from{transform:translateY(8px);opacity:0}to{transform:none;opacity:1}}
.modal-head{display:flex;justify-content:space-between;align-items:center;padding:1rem 1.25rem;border-bottom:1px solid var(--border)}
.modal-body{padding:1.15rem 1.25rem}
.modal-foot{padding:.85rem 1.25rem;display:flex;gap:.5rem;justify-content:flex-end;background:var(--bg);border-top:1px solid var(--border)}
.modal-card.wide{max-width:720px}
.target-chip{display:flex;align-items:center;gap:.6rem;padding:.65rem .8rem;background:var(--hover);border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:1rem}
.target-chip .icon{flex:none;color:var(--text-2);width:1.1rem;height:1.1rem}
.target-chip .target-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem;font-weight:500;word-break:break-all;flex:1;min-width:0}
.success-state{text-align:center;padding:.5rem 0 1rem}
.success-state .check{width:3rem;height:3rem;border-radius:50%;background:var(--ok-soft);color:var(--ok);display:inline-flex;align-items:center;justify-content:center;margin-bottom:.85rem}
.success-state .check .icon{width:1.5rem;height:1.5rem}
.success-state h2{margin-bottom:.4rem}
.share-url{display:flex;align-items:center;gap:.5rem;padding:.5rem;background:var(--hover);border:1px solid var(--border);border-radius:var(--radius-sm);margin-top:1rem}
.share-url code{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem;word-break:break-all;color:var(--text);background:transparent;padding:.3rem .25rem}
.share-warning{font-size:.8rem;color:var(--warn);margin-top:.85rem;display:flex;gap:.4rem;align-items:flex-start}
.share-warning .icon{flex:none;width:1rem;height:1rem;margin-top:.1rem}
/* Toasts */
.toast-stack{position:fixed;top:1rem;right:1rem;display:flex;flex-direction:column;gap:.5rem;z-index:100;max-width:24rem}
.toast{background:#fff;border:1px solid var(--border);border-radius:var(--radius-sm);padding:.7rem .9rem;box-shadow:var(--shadow-lg);display:flex;align-items:flex-start;gap:.55rem;font-size:.85rem;animation:slide .15s ease-out}
.toast .icon{flex:none;width:1.05rem;height:1.05rem;margin-top:.05rem}
.toast.success{border-left:3px solid var(--ok)}
.toast.success .icon{color:var(--ok)}
.toast.error{border-left:3px solid var(--danger)}
.toast.error .icon{color:var(--danger)}
.toast.info{border-left:3px solid var(--info)}
.toast.info .icon{color:var(--info)}
@keyframes slide{from{transform:translateX(8px);opacity:0}to{transform:none;opacity:1}}
/* Picker rows */
.picker-list{max-height:360px;overflow:auto;border:1px solid var(--border);border-radius:var(--radius-sm)}
.picker-row{display:flex;align-items:center;gap:.55rem;padding:.5rem .75rem;border-bottom:1px solid var(--border);cursor:pointer;transition:background .1s}
.picker-row:last-child{border-bottom:none}
.picker-row:hover{background:var(--hover)}
.picker-row .icon{flex:none;color:var(--muted)}
.picker-row .name-text{flex:1;font-size:.88rem;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.picker-row.disabled{opacity:.4;cursor:not-allowed}
.picker-current-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem;color:var(--text-2);padding:.4rem .6rem;background:var(--hover);border-radius:var(--radius-sm);margin-bottom:.6rem;word-break:break-all}
/* Misc */
.divider{height:1px;background:var(--border);margin:.85rem 0}
@media (max-width:760px){
  .tiles{grid-template-columns:1fr}
  .form-grid{grid-template-columns:1fr}
  .form-grid label{margin-bottom:-.25rem}
  main{padding:1rem}
}
</style>
</head>
<body>
<header class="top">
  <div class="brand"><span class="dot"></span>mvmt<span class="brand-sub">share local folders</span></div>
  <div id="header-user" class="user-strip hidden">
    <span class="who"><svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg><span id="who"></span><span id="who-role" class="badge active hidden" style="margin-left:.4rem;">Admin</span></span>
    <button class="btn btn-ghost btn-sm" id="logout" type="button">Sign out</button>
  </div>
</header>
<main>
  <div id="toast-stack" class="toast-stack"></div>

  <section id="login" class="panel login-card hidden">
    <h2>Sign in</h2>
    <p class="muted" style="margin:.25rem 0 1rem;font-size:.88rem;">Sign in to manage shared links for this device.</p>
    <form id="login-form" autocomplete="on">
      <input id="username" name="username" autocomplete="username" placeholder="Username" required>
      <input id="password" name="password" type="password" autocomplete="current-password" placeholder="Password" required>
      <button class="btn btn-primary" type="submit" style="justify-content:center;margin-top:.25rem;">Sign in</button>
    </form>
  </section>

  <section id="app" class="hidden">
    <section class="panel">
      <div class="panel-head">
        <div class="panel-title"><h2>Sources</h2><span class="count" id="mounts-count"></span></div>
        <button class="btn btn-primary btn-sm hidden" id="add-mount" type="button"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>Add source</button>
      </div>
      <div id="mounts-empty" class="empty hidden">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
        <strong>No sources yet</strong>
        Add a folder on this device to start sharing files.
      </div>
      <div class="tablewrap hidden" id="mounts-wrap">
        <table class="t"><thead><tr><th>Name</th><th>Shared as</th><th>Local path</th><th>Permission</th><th>State</th><th></th></tr></thead><tbody id="mounts"></tbody></table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div class="panel-title"><h2>Files</h2></div>
        <button class="btn btn-ghost btn-icon" id="refresh" type="button" title="Refresh">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.4L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.4L3 16M3 21v-5h5"/></svg>
        </button>
      </div>
      <div class="crumbs" id="crumbs" data-test="crumbs"></div>
      <div id="empty-mounts" class="empty hidden">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
        <strong>Nothing to browse yet</strong>
        Add a source above and the contents will appear here.
      </div>
      <div class="tablewrap hidden" id="files-wrap">
        <table class="t"><thead><tr><th>Name</th><th>Permission</th><th>Modified</th><th></th></tr></thead><tbody id="files"></tbody></table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div class="panel-title"><h2>Shared links</h2><span class="count" id="leases-count"></span></div>
      </div>
      <div class="tabs" data-test="lease-tabs">
        <button type="button" class="tab active" data-tab="active">Active</button>
        <button type="button" class="tab" data-tab="inactive">Past</button>
      </div>
      <div id="leases-empty" class="empty hidden">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>
        <strong>No shared links</strong>
        Pick a file or folder above to share it.
      </div>
      <div class="tablewrap hidden" id="leases-wrap">
        <table class="t"><thead><tr><th>Label</th><th>Path</th><th>Permission</th><th>Status</th><th>Last used</th><th></th></tr></thead><tbody id="leases"></tbody></table>
      </div>
    </section>
  </section>

  <div id="lease-modal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-card wide">
      <div id="lease-step-config">
        <div class="modal-head">
          <h2>Share a link</h2>
          <button class="btn btn-ghost btn-icon" type="button" id="lease-modal-close" title="Close">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="modal-body">
          <div class="target-chip" id="lease-target"></div>
          <h3 style="margin-bottom:.55rem;">Permission</h3>
          <div class="tiles" id="lease-tiles">
            <button type="button" class="tile" data-mode="read">
              <div class="tile-head">
                <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>
                <span class="tile-title">Read only</span>
              </div>
              <div class="tile-desc">Recipient can browse and download. Two recipients can use it at once with no conflicts.</div>
            </button>
            <button type="button" class="tile" data-mode="upload">
              <div class="tile-head">
                <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
                <span class="tile-title">Upload only</span>
              </div>
              <div class="tile-desc">Recipient can drop new files in. No browse, no download. Collisions get auto-suffixed.</div>
            </button>
            <button type="button" class="tile" data-mode="two-way">
              <div class="tile-head">
                <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                <span class="tile-title">Read + upload</span>
              </div>
              <div class="tile-desc">Recipient can browse, download, and add new files. Existing files stay untouched.</div>
            </button>
          </div>
          <p id="mode-help" class="subtle" style="margin:-.3rem 0 1rem;">Pick how a recipient can interact with this lease.</p>
          <div class="form-grid">
            <label for="lease-label">Label</label>
            <input id="lease-label" placeholder="e.g. Tax docs for accountant" required>
            <label for="lease-expires">Expires in</label>
            <select id="lease-expires">
              <option value="1h">1 hour</option>
              <option value="24h" selected>24 hours</option>
              <option value="7d">7 days</option>
              <option value="30d">30 days</option>
            </select>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" type="button" id="lease-cancel">Cancel</button>
          <button class="btn btn-primary" type="button" id="lease-create">Create link</button>
        </div>
      </div>
      <div id="lease-step-success" class="hidden">
        <div class="modal-body">
          <div class="success-state">
            <span class="check">
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>
            </span>
            <h2>Link ready to share</h2>
            <p class="muted" style="margin:.25rem 0 0;">Anyone with this URL can use the lease until it expires or is revoked.</p>
          </div>
          <div class="share-url" data-test="created-card">
            <code id="created-url"></code>
            <button class="btn btn-primary btn-sm" type="button" id="copy-url">
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Copy
            </button>
          </div>
          <p class="share-warning">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
            This is the only time this URL is shown. We save it in your browser so you can copy it again later — if you clear browser data, you'll need to rotate the link.
          </p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-primary" type="button" id="lease-done">Done</button>
        </div>
      </div>
    </div>
  </div>

  <div id="mount-modal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-card">
      <div class="modal-head">
        <h2 id="mount-modal-title">Add source</h2>
        <button class="btn btn-ghost btn-icon" type="button" id="mount-modal-close" title="Close">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-grid">
          <label for="mount-root">Local path</label>
          <div style="display:flex;gap:.4rem;">
            <input id="mount-root" placeholder="/Users/you/Documents" style="flex:1;">
            <button type="button" class="btn" id="open-picker">Browse…</button>
          </div>
          <label for="mount-name">Name</label>
          <input id="mount-name" placeholder="auto">
          <label for="mount-path">Shared as</label>
          <input id="mount-path" placeholder="/documents">
          <label for="mount-description">Description</label>
          <input id="mount-description" placeholder="optional">
          <label>Permission</label>
          <label style="display:flex;align-items:center;gap:.4rem;font-size:.88rem;color:var(--text);"><input id="mount-write" type="checkbox" style="width:auto;"> Allow recipients to upload &amp; modify</label>
          <label id="mount-enabled-label">State</label>
          <label id="mount-enabled-field" style="display:flex;align-items:center;gap:.4rem;font-size:.88rem;color:var(--text);"><input id="mount-enabled" type="checkbox" checked style="width:auto;"> Enabled</label>
        </div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn" id="mount-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="mount-save">Save source</button>
      </div>
    </div>
  </div>

  <div id="picker-modal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-card">
      <div class="modal-head">
        <h2>Pick a folder or file</h2>
        <button class="btn btn-ghost btn-icon" type="button" id="picker-close" title="Close">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <p class="subtle" style="margin:0 0 .5rem;">Click a folder to open it. Click a file to select it. Use "Select this folder" to mount the current directory itself.</p>
        <div class="picker-current-path" id="picker-current-path"></div>
        <div class="picker-list" id="picker-list"></div>
        <p class="subtle" id="picker-status" style="margin:.5rem 0 0;"></p>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn" id="picker-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="picker-select">Select this folder</button>
      </div>
    </div>
  </div>
</main>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var ICONS = {
    folder: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    file: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    copy: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    link: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
    trash: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
    edit: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
    check: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>',
    alert: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
    share: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98"/></svg>',
    refresh: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M3 12a9 9 0 0 1 15.5-6.4L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.4L3 16M3 21v-5h5"/></svg>',
    up: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  };

  var state = {
    currentPath: '/',
    selectedEntry: null,
    leases: [],
    mounts: [],
    canManageMounts: false,
    activeTab: 'active',
    editingMount: null,
    pickerCurrentPath: null,
    leaseMode: null,
  };

  // ---------- core helpers ----------
  async function api(url, options) {
    var opts = options || {};
    var response = await fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    var body = null;
    try { body = await response.json(); } catch (_) { /* no body */ }
    if (!response.ok) {
      var err = new Error((body && body.error) || ('request_failed_' + response.status));
      err.status = response.status;
      err.detail = body && body.detail;
      throw err;
    }
    return body || {};
  }

  function toast(message, kind, ttlMs) {
    var stack = $('toast-stack');
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || 'info');
    var iconHtml = kind === 'error' ? ICONS.alert : kind === 'success' ? ICONS.check : ICONS.alert;
    el.innerHTML = iconHtml + '<span></span>';
    el.querySelector('span').textContent = message;
    stack.appendChild(el);
    var ms = ttlMs || (kind === 'error' ? 6000 : 3500);
    setTimeout(function () {
      el.style.transition = 'opacity .2s';
      el.style.opacity = '0';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
    }, ms);
  }

  function showError(error) {
    var msg = (error && error.message) ? error.message : String(error);
    toast(humanizeError(msg), 'error');
  }

  function humanizeError(msg) {
    switch (msg) {
      case 'invalid_credentials': return 'Wrong username or password.';
      case 'dashboard_login_required': return 'Please sign in.';
      case 'label_required': return 'Add a label first.';
      case 'path_required': return 'Pick a file or folder.';
      case 'invalid_mode': return 'Pick a permission.';
      case 'mode_requires_folder': return 'Upload modes only work on folders.';
      case 'mount_read_only': return 'Source is read-only — enable write to allow uploads.';
      case 'mount_management_disabled': return 'Mount management is disabled on this server.';
      case 'admin_required': return 'Admin access required for that action.';
      case 'lease_not_found': return 'Lease not found.';
      case 'lease_revoked': return 'Lease was revoked.';
      default: return msg;
    }
  }

  async function copyToClipboard(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    var tmp = document.createElement('textarea');
    tmp.value = text;
    tmp.setAttribute('readonly', '');
    tmp.style.position = 'absolute';
    tmp.style.left = '-9999px';
    document.body.appendChild(tmp);
    tmp.select();
    try { document.execCommand('copy'); } finally { document.body.removeChild(tmp); }
  }

  function formatDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return iso; }
  }

  function relativeTime(iso) {
    if (!iso) return '';
    var ms = Date.now() - new Date(iso).getTime();
    if (isNaN(ms)) return iso;
    var abs = Math.abs(ms);
    var future = ms < 0;
    var min = 60_000, hr = 3_600_000, day = 86_400_000;
    var phrase;
    if (abs < min) phrase = 'just now';
    else if (abs < hr) phrase = Math.round(abs / min) + 'm';
    else if (abs < day) phrase = Math.round(abs / hr) + 'h';
    else if (abs < day * 30) phrase = Math.round(abs / day) + 'd';
    else phrase = formatDate(iso);
    if (phrase === 'just now') return phrase;
    return future ? 'in ' + phrase : phrase + ' ago';
  }

  function setIcon(el, key) {
    el.innerHTML = ICONS[key] || '';
  }

  // ---------- app shell ----------
  function showApp(signedIn) {
    $('login').classList.toggle('hidden', signedIn);
    $('app').classList.toggle('hidden', !signedIn);
    $('header-user').classList.toggle('hidden', !signedIn);
    if (!signedIn) {
      state.currentPath = '/';
      state.selectedEntry = null;
      state.leases = [];
      state.mounts = [];
      $('files').replaceChildren();
      $('leases').replaceChildren();
      $('mounts').replaceChildren();
      $('crumbs').replaceChildren();
    }
  }

  function pathSegments(input) {
    var parts = input.split('/').filter(Boolean);
    var segs = [{ name: 'All sources', path: '/' }];
    var cur = '';
    for (var i = 0; i < parts.length; i += 1) {
      cur += '/' + parts[i];
      segs.push({ name: parts[i], path: cur });
    }
    return segs;
  }

  function renderCrumbs() {
    var segs = pathSegments(state.currentPath);
    var nodes = [];
    for (var i = 0; i < segs.length; i += 1) {
      var seg = segs[i];
      var last = i === segs.length - 1;
      var node;
      if (last) { node = document.createElement('span'); node.className = 'current'; }
      else {
        node = document.createElement('a');
        node.href = '#';
        (function (target) { node.addEventListener('click', function (event) { event.preventDefault(); loadFiles(target).catch(showError); }); })(seg.path);
      }
      node.textContent = seg.name;
      nodes.push(node);
      if (!last) { var sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '/'; nodes.push(sep); }
    }
    $('crumbs').replaceChildren.apply($('crumbs'), nodes);
  }

  // ---------- files ----------
  function renderFileRow(entry) {
    var row = document.createElement('tr');
    row.setAttribute('data-path', entry.path);

    var nameCell = document.createElement('td');
    var nameWrap = document.createElement('div');
    nameWrap.className = 'cell-name';
    var iconSpan = document.createElement('span');
    iconSpan.innerHTML = entry.type === 'directory' ? ICONS.folder : ICONS.file;
    var nameLink = document.createElement('a');
    nameLink.href = '#';
    nameLink.className = 'name-text';
    nameLink.title = entry.path;
    nameLink.textContent = entry.name;
    nameLink.addEventListener('click', function (event) {
      event.preventDefault();
      if (entry.type === 'directory') loadFiles(entry.path).catch(showError);
      else openLeaseModal(entry);
    });
    nameWrap.append(iconSpan, nameLink);
    nameCell.append(nameWrap);

    var permCell = document.createElement('td');
    var permBadge = document.createElement('span');
    permBadge.className = 'badge ' + (entry.writeAccess ? 'write' : 'readonly');
    permBadge.textContent = entry.writeAccess ? 'Writable' : 'Read-only';
    permCell.append(permBadge);

    var modCell = document.createElement('td');
    modCell.className = 'cell-num';
    if (entry.mtimeMs) { modCell.title = formatDate(new Date(entry.mtimeMs).toISOString()); modCell.textContent = relativeTime(new Date(entry.mtimeMs).toISOString()); }

    var actionCell = document.createElement('td');
    var actions = document.createElement('div');
    actions.className = 'actions';
    if (entry.type === 'directory') {
      var openBtn = document.createElement('button');
      openBtn.className = 'btn btn-ghost btn-sm';
      openBtn.type = 'button';
      openBtn.textContent = 'Open';
      openBtn.addEventListener('click', function () { loadFiles(entry.path).catch(showError); });
      actions.append(openBtn);
    }
    var shareBtn = document.createElement('button');
    shareBtn.className = 'btn btn-sm';
    shareBtn.type = 'button';
    shareBtn.innerHTML = ICONS.share + '<span>Share</span>';
    shareBtn.addEventListener('click', function () { openLeaseModal(entry); });
    actions.append(shareBtn);
    actionCell.append(actions);

    row.append(nameCell, permCell, modCell, actionCell);
    return row;
  }

  async function loadFiles(targetPath) {
    var requested = targetPath || state.currentPath;
    var listing;
    try {
      listing = await api('/dashboard/api/files?path=' + encodeURIComponent(requested));
    } catch (err) {
      if (err && err.status === 404 && requested !== '/') {
        toast('Path is unavailable. Returned to top.', 'error');
        return loadFiles('/');
      }
      throw err;
    }
    state.currentPath = listing.path || requested;
    renderCrumbs();
    var entries = listing.entries || [];
    var hasEntries = entries.length > 0;
    var atRoot = state.currentPath === '/';
    $('empty-mounts').classList.toggle('hidden', hasEntries || !atRoot);
    $('files-wrap').classList.toggle('hidden', !hasEntries);
    if (!hasEntries) { $('files').replaceChildren(); return; }
    var rows = [];
    for (var i = 0; i < entries.length; i += 1) rows.push(renderFileRow(entries[i]));
    $('files').replaceChildren.apply($('files'), rows);
  }

  // ---------- leases ----------
  var LEASE_URLS_KEY = 'mvmt_lease_urls_v1';
  function readLeaseUrls() { try { return JSON.parse(window.localStorage.getItem(LEASE_URLS_KEY) || '{}'); } catch (_) { return {}; } }
  function writeLeaseUrls(value) { try { window.localStorage.setItem(LEASE_URLS_KEY, JSON.stringify(value)); } catch (_) { /* ignore */ } }
  function getStoredLeaseUrl(id) { return readLeaseUrls()[id] || null; }
  function storeLeaseUrl(id, url) { var m = readLeaseUrls(); m[id] = url; writeLeaseUrls(m); }
  function forgetLeaseUrl(id) { var m = readLeaseUrls(); delete m[id]; writeLeaseUrls(m); }

  function leaseStatus(lease) {
    if (lease.revokedAt) return { state: 'revoked', label: 'Revoked' };
    if (lease.expiresAt && new Date(lease.expiresAt).getTime() <= Date.now()) return { state: 'expired', label: 'Expired' };
    return { state: 'active', label: lease.expiresAt ? 'Expires in ' + relativeTime(lease.expiresAt).replace('in ', '').replace(' ago', '') : 'No expiry' };
  }

  function permissionLabel(perms) {
    var p = perms || ['read'];
    var hasRead = p.indexOf('read') !== -1;
    var hasUpload = p.indexOf('upload') !== -1;
    var hasWrite = p.indexOf('write') !== -1;
    if (hasWrite) return 'Read + write';
    if (hasRead && hasUpload) return 'Read + upload';
    if (hasUpload) return 'Upload only';
    return 'Read only';
  }

  function renderLeaseRow(lease) {
    var s = leaseStatus(lease);
    var row = document.createElement('tr');

    var labelCell = document.createElement('td');
    labelCell.textContent = lease.label || '(unlabeled)';
    labelCell.style.fontWeight = '500';

    var pathCell = document.createElement('td');
    pathCell.className = 'cell-path';
    var paths = (lease.resources || []).map(function (r) { return r.path; });
    pathCell.textContent = paths.join(', ') || lease.path || '';
    pathCell.title = pathCell.textContent;

    var permCell = document.createElement('td');
    var permBadge = document.createElement('span');
    var hasUpload = (lease.permissions || []).indexOf('upload') !== -1;
    var hasWrite = (lease.permissions || []).indexOf('write') !== -1;
    permBadge.className = 'badge ' + (hasWrite || hasUpload ? 'write' : 'read');
    permBadge.textContent = permissionLabel(lease.permissions);
    permCell.append(permBadge);

    var statusCell = document.createElement('td');
    var statusBadge = document.createElement('span');
    statusBadge.className = 'badge ' + s.state;
    statusBadge.textContent = s.label;
    statusBadge.title = lease.expiresAt ? formatDate(lease.expiresAt) : '';
    statusCell.append(statusBadge);

    var usedCell = document.createElement('td');
    usedCell.className = 'cell-num';
    if (lease.lastUsedAt) { usedCell.textContent = relativeTime(lease.lastUsedAt); usedCell.title = formatDate(lease.lastUsedAt); }
    else { usedCell.textContent = '—'; }

    var actionCell = document.createElement('td');
    var actions = document.createElement('div');
    actions.className = 'actions';
    if (s.state === 'active') {
      var copyBtn = document.createElement('button');
      copyBtn.className = 'btn btn-sm';
      copyBtn.type = 'button';
      var knownUrl = getStoredLeaseUrl(lease.id);
      copyBtn.innerHTML = (knownUrl ? ICONS.copy : ICONS.link) + '<span>' + (knownUrl ? 'Copy link' : 'New link') + '</span>';
      copyBtn.title = knownUrl ? 'Copy the saved URL' : 'No URL saved on this device. Generate a fresh URL (invalidates any previous one).';
      (function (id) {
        copyBtn.addEventListener('click', async function () {
          try {
            var url = getStoredLeaseUrl(id);
            if (!url) {
              if (!confirm('No URL is saved on this device. Generate a fresh URL? Any previously-shared URL for this lease becomes invalid.')) return;
              var rotated = await api('/dashboard/api/leases/' + encodeURIComponent(id) + '/rotate', { method: 'POST', body: '{}' });
              url = rotated.lease.url;
              storeLeaseUrl(id, url);
            }
            await copyToClipboard(url);
            toast('Link copied to clipboard.', 'success');
            renderLeases();
          } catch (err) { showError(err); }
        });
      })(lease.id);
      actions.append(copyBtn);

      var revoke = document.createElement('button');
      revoke.className = 'btn btn-danger btn-sm btn-icon';
      revoke.type = 'button';
      revoke.title = 'Revoke';
      revoke.innerHTML = ICONS.trash;
      (function (id) {
        revoke.addEventListener('click', async function () {
          if (!confirm('Revoke this link? Anyone holding the URL will lose access immediately.')) return;
          try {
            await api('/dashboard/api/leases/' + encodeURIComponent(id) + '/revoke', { method: 'POST', body: '{}' });
            forgetLeaseUrl(id);
            await loadLeases();
            toast('Link revoked.', 'success');
          } catch (err) { showError(err); }
        });
      })(lease.id);
      actions.append(revoke);
    }
    actionCell.append(actions);

    row.append(labelCell, pathCell, permCell, statusCell, usedCell, actionCell);
    return row;
  }

  function renderLeases() {
    var items = [];
    for (var i = 0; i < state.leases.length; i += 1) {
      var lease = state.leases[i];
      var st = leaseStatus(lease).state;
      if (state.activeTab === 'active' ? st === 'active' : st !== 'active') items.push(lease);
    }
    $('leases-count').textContent = items.length ? '(' + items.length + ')' : '';
    var hasItems = items.length > 0;
    $('leases-empty').classList.toggle('hidden', hasItems);
    $('leases-wrap').classList.toggle('hidden', !hasItems);
    if (!hasItems) { $('leases').replaceChildren(); return; }
    var rows = [];
    for (var j = 0; j < items.length; j += 1) rows.push(renderLeaseRow(items[j]));
    $('leases').replaceChildren.apply($('leases'), rows);
  }

  async function loadLeases() {
    var payload = await api('/dashboard/api/leases');
    state.leases = payload.leases || [];
    renderLeases();
  }

  // ---------- lease modal ----------
  function openLeaseModal(entry) {
    state.selectedEntry = entry;
    state.leaseMode = null;
    $('lease-step-config').classList.remove('hidden');
    $('lease-step-success').classList.add('hidden');
    var target = $('lease-target');
    target.innerHTML = '<span>' + (entry.type === 'directory' ? ICONS.folder : ICONS.file) + '</span><div class="target-path">' + escapeHtml(entry.path) + '</div><span class="badge ' + (entry.writeAccess ? 'write' : 'readonly') + '">' + (entry.type === 'directory' ? 'Folder' : 'File') + ' · ' + (entry.writeAccess ? 'writable' : 'read-only') + '</span>';
    $('lease-label').value = entry.name || entry.path;
    $('lease-expires').value = '24h';
    setupTiles(entry);
    $('lease-modal').classList.remove('hidden');
    setTimeout(function () { $('lease-label').focus(); $('lease-label').select(); }, 0);
  }

  function closeLeaseModal() {
    $('lease-modal').classList.add('hidden');
    state.selectedEntry = null;
    state.leaseMode = null;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; });
  }

  function setupTiles(entry) {
    var tiles = document.querySelectorAll('#lease-tiles .tile');
    var help = $('mode-help');
    for (var i = 0; i < tiles.length; i += 1) {
      var tile = tiles[i];
      var mode = tile.getAttribute('data-mode');
      var disabled = false;
      var reason = '';
      if (mode !== 'read' && entry.type === 'file') { disabled = true; reason = 'Upload modes only work on folders.'; }
      if (mode !== 'read' && !entry.writeAccess) { disabled = true; reason = 'Source is read-only — toggle write access on the source to allow uploads.'; }
      tile.classList.toggle('disabled', disabled);
      tile.classList.remove('selected');
      tile.disabled = disabled;
      tile.dataset.disabledReason = reason;
    }
    // default-select first enabled tile
    state.leaseMode = null;
    help.textContent = 'Pick how a recipient can interact with this lease.';
    for (var j = 0; j < tiles.length; j += 1) {
      if (!tiles[j].disabled) { selectTile(tiles[j]); break; }
    }
  }

  function selectTile(tile) {
    if (tile.disabled) return;
    var tiles = document.querySelectorAll('#lease-tiles .tile');
    for (var i = 0; i < tiles.length; i += 1) tiles[i].classList.toggle('selected', tiles[i] === tile);
    state.leaseMode = tile.getAttribute('data-mode');
    var modeNotes = {
      'read': 'Recipients can view and download. No uploads.',
      'upload': 'Recipients can drop files into the folder. Existing files are not visible or modifiable.',
      'two-way': 'Recipients can view, download, and add new files. Existing files are never overwritten.',
    };
    $('mode-help').textContent = modeNotes[state.leaseMode] || '';
  }

  async function submitLease() {
    if (!state.selectedEntry) return;
    if (!state.leaseMode) { toast('Pick a permission.', 'error'); return; }
    if (!$('lease-label').value.trim()) { toast('Add a label first.', 'error'); $('lease-label').focus(); return; }
    var btn = $('lease-create');
    btn.disabled = true;
    try {
      var payload = await api('/dashboard/api/leases', {
        method: 'POST',
        body: JSON.stringify({
          path: state.selectedEntry.path,
          label: $('lease-label').value.trim(),
          mode: state.leaseMode,
          expires: $('lease-expires').value,
        }),
      });
      storeLeaseUrl(payload.lease.id, payload.lease.url);
      $('created-url').textContent = payload.lease.url;
      $('lease-step-config').classList.add('hidden');
      $('lease-step-success').classList.remove('hidden');
      await loadLeases();
    } catch (err) { showError(err); }
    finally { btn.disabled = false; }
  }

  // ---------- mounts ----------
  function renderMountRow(mount) {
    var row = document.createElement('tr');
    var nameCell = document.createElement('td');
    var nameWrap = document.createElement('div');
    nameWrap.className = 'cell-name';
    var iconSpan = document.createElement('span');
    iconSpan.innerHTML = ICONS.folder;
    var nameText = document.createElement('span');
    nameText.className = 'name-text';
    nameText.title = mount.name;
    nameText.textContent = mount.name;
    nameText.style.fontWeight = '500';
    nameWrap.append(iconSpan, nameText);
    nameCell.append(nameWrap);

    var pathCell = document.createElement('td');
    pathCell.className = 'cell-path';
    pathCell.textContent = mount.path;
    pathCell.title = mount.path;

    var rootCell = document.createElement('td');
    rootCell.className = 'cell-path';
    rootCell.textContent = mount.root;
    rootCell.title = mount.root;

    var permCell = document.createElement('td');
    var permBadge = document.createElement('span');
    permBadge.className = 'badge ' + (mount.writeAccess ? 'write' : 'readonly');
    permBadge.textContent = mount.writeAccess ? 'Writable' : 'Read-only';
    permCell.append(permBadge);

    var stateCell = document.createElement('td');
    var stateBadge = document.createElement('span');
    var enabled = mount.enabled !== false;
    stateBadge.className = 'badge ' + (enabled ? 'active' : 'readonly');
    stateBadge.textContent = enabled ? 'Enabled' : 'Disabled';
    stateCell.append(stateBadge);

    var actionCell = document.createElement('td');
    var actions = document.createElement('div');
    actions.className = 'actions';
    if (state.canManageMounts) {
      var editBtn = document.createElement('button');
      editBtn.className = 'btn btn-ghost btn-icon';
      editBtn.type = 'button';
      editBtn.title = 'Edit';
      editBtn.innerHTML = ICONS.edit;
      editBtn.addEventListener('click', function () { openMountModal(mount); });
      var removeBtn = document.createElement('button');
      removeBtn.className = 'btn btn-danger btn-icon';
      removeBtn.type = 'button';
      removeBtn.title = 'Remove';
      removeBtn.innerHTML = ICONS.trash;
      (function (target) {
        removeBtn.addEventListener('click', async function () {
          if (!confirm('Remove source "' + target.name + '"? Existing links that reference it become unusable.')) return;
          try {
            await api('/dashboard/api/mounts/' + encodeURIComponent(target.name), { method: 'DELETE', body: '{}' });
            await reloadMounts();
            await loadFiles('/');
            toast('Source removed.', 'success');
          } catch (err) { showError(err); }
        });
      })(mount);
      actions.append(editBtn, removeBtn);
    } else {
      var locked = document.createElement('span');
      locked.className = 'subtle';
      locked.textContent = 'CLI only';
      actions.append(locked);
    }
    actionCell.append(actions);
    row.append(nameCell, pathCell, rootCell, permCell, stateCell, actionCell);
    return row;
  }

  function renderMounts() {
    $('mounts-count').textContent = state.mounts.length ? '(' + state.mounts.length + ')' : '';
    var hasMounts = state.mounts.length > 0;
    $('mounts-empty').classList.toggle('hidden', hasMounts);
    $('mounts-wrap').classList.toggle('hidden', !hasMounts);
    if (!hasMounts) { $('mounts').replaceChildren(); return; }
    var rows = [];
    for (var i = 0; i < state.mounts.length; i += 1) rows.push(renderMountRow(state.mounts[i]));
    $('mounts').replaceChildren.apply($('mounts'), rows);
  }

  async function reloadMounts() {
    var payload = await api('/dashboard/api/mounts');
    state.mounts = payload.mounts || [];
    state.canManageMounts = !!payload.canManage;
    $('add-mount').classList.toggle('hidden', !state.canManageMounts);
    renderMounts();
  }

  function openMountModal(existing) {
    state.editingMount = existing || null;
    $('mount-modal-title').textContent = existing ? 'Edit source: ' + existing.name : 'Add source';
    $('mount-root').value = existing ? (existing.root || '') : '';
    $('mount-name').value = existing ? (existing.name || '') : '';
    $('mount-name').disabled = !!existing;
    $('mount-path').value = existing ? (existing.path || '') : '';
    $('mount-description').value = existing ? (existing.description || '') : '';
    $('mount-write').checked = existing ? !!existing.writeAccess : false;
    $('mount-enabled').checked = existing ? existing.enabled !== false : true;
    $('mount-enabled-label').classList.toggle('hidden', !existing);
    $('mount-enabled-field').classList.toggle('hidden', !existing);
    $('mount-modal').classList.remove('hidden');
    setTimeout(function () { $('mount-root').focus(); }, 0);
  }

  function closeMountModal() { $('mount-modal').classList.add('hidden'); state.editingMount = null; }

  async function saveMount() {
    var body = { root: $('mount-root').value.trim(), writeAccess: $('mount-write').checked };
    if ($('mount-path').value.trim()) body.path = $('mount-path').value.trim();
    if ($('mount-description').value.trim()) body.description = $('mount-description').value.trim();
    var url = '/dashboard/api/mounts'; var method = 'POST';
    if (state.editingMount) {
      url = '/dashboard/api/mounts/' + encodeURIComponent(state.editingMount.name);
      method = 'PATCH';
      body.enabled = $('mount-enabled').checked;
    } else if ($('mount-name').value.trim()) body.name = $('mount-name').value.trim();
    var save = $('mount-save');
    save.disabled = true;
    try {
      await api(url, { method: method, body: JSON.stringify(body) });
      closeMountModal();
      await reloadMounts();
      await loadFiles(state.currentPath);
      toast(state.editingMount ? 'Source updated.' : 'Source added.', 'success');
    } catch (err) { showError(err); }
    finally { save.disabled = false; }
  }

  // ---------- picker ----------
  async function openPicker(startPath) {
    $('picker-status').textContent = '';
    $('picker-modal').classList.remove('hidden');
    await loadPicker(startPath || $('mount-root').value.trim() || null);
  }
  function closePicker() { $('picker-modal').classList.add('hidden'); }

  async function loadPicker(targetPath) {
    try {
      var qs = targetPath ? '?path=' + encodeURIComponent(targetPath) : '';
      var listing = await api('/dashboard/api/browse' + qs);
      state.pickerCurrentPath = listing.path;
      $('picker-current-path').textContent = listing.path;
      var rows = [];
      if (listing.parent) {
        rows.push(makePickerRow({ name: '.. (parent)', path: listing.parent, type: 'directory' }, true));
      }
      var entries = listing.entries || [];
      for (var i = 0; i < entries.length; i += 1) rows.push(makePickerRow(entries[i]));
      $('picker-list').replaceChildren.apply($('picker-list'), rows);
      $('picker-status').textContent = entries.length === 0 ? 'Empty directory.' : '';
    } catch (err) {
      $('picker-status').textContent = (err && err.message) ? humanizeError(err.message) : 'Unable to open path.';
    }
  }

  function makePickerRow(entry, isParent) {
    var row = document.createElement('div');
    row.className = 'picker-row';
    var iconSpan = document.createElement('span');
    iconSpan.innerHTML = entry.type === 'directory' ? ICONS.folder : ICONS.file;
    var name = document.createElement('span');
    name.className = 'name-text';
    name.textContent = entry.name;
    var pick = document.createElement('button');
    pick.className = 'btn btn-ghost btn-sm';
    pick.type = 'button';
    pick.textContent = isParent ? 'Open' : (entry.type === 'directory' ? 'Open' : 'Select');
    (function (p, type) {
      pick.addEventListener('click', function (e) {
        e.stopPropagation();
        if (type === 'directory' && !isParent) {
          loadPicker(p);
        } else if (type === 'directory' && isParent) {
          loadPicker(p);
        } else {
          $('mount-root').value = p;
          closePicker();
        }
      });
    })(entry.path, entry.type);
    if (entry.type === 'directory') {
      (function (p) { row.addEventListener('click', function () { loadPicker(p); }); })(entry.path);
    } else {
      (function (p) { row.addEventListener('click', function () { $('mount-root').value = p; closePicker(); }); })(entry.path);
    }
    row.append(iconSpan, name, pick);
    return row;
  }

  // ---------- refresh / boot ----------
  async function refresh() {
    await reloadMounts();
    await loadFiles(state.currentPath);
    await loadLeases();
  }

  // ---------- wiring ----------
  $('login-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    var submit = event.target.querySelector('button[type=submit]');
    if (submit) submit.disabled = true;
    try {
      var resp = await api('/dashboard/api/login', {
        method: 'POST',
        body: JSON.stringify({ username: $('username').value, password: $('password').value }),
      });
      $('who').textContent = (resp.user && resp.user.username) || '';
      $('who-role').classList.toggle('hidden', !(resp.user && resp.user.admin));
      $('password').value = '';
      showApp(true);
      await refresh();
    } catch (err) { showError(err); }
    finally { if (submit) submit.disabled = false; }
  });

  $('logout').addEventListener('click', async function () {
    try { await api('/dashboard/api/logout', { method: 'POST', body: '{}' }); } catch (_) { /* ignore */ }
    $('who').textContent = '';
    showApp(false);
    toast('Signed out.', 'info');
  });

  $('refresh').addEventListener('click', function () { refresh().catch(showError); });

  var tabButtons = document.querySelectorAll('.tab');
  for (var t = 0; t < tabButtons.length; t += 1) {
    (function (btn) {
      btn.addEventListener('click', function () {
        state.activeTab = btn.getAttribute('data-tab');
        for (var k = 0; k < tabButtons.length; k += 1) tabButtons[k].classList.toggle('active', tabButtons[k] === btn);
        renderLeases();
      });
    })(tabButtons[t]);
  }

  $('add-mount').addEventListener('click', function () { openMountModal(null); });
  $('mount-modal-close').addEventListener('click', closeMountModal);
  $('mount-cancel').addEventListener('click', closeMountModal);
  $('mount-save').addEventListener('click', function () { saveMount().catch(showError); });
  $('mount-modal').addEventListener('click', function (event) { if (event.target === $('mount-modal')) closeMountModal(); });

  $('open-picker').addEventListener('click', function () { openPicker(null).catch(showError); });
  $('picker-close').addEventListener('click', closePicker);
  $('picker-cancel').addEventListener('click', closePicker);
  $('picker-select').addEventListener('click', function () {
    if (state.pickerCurrentPath) { $('mount-root').value = state.pickerCurrentPath; closePicker(); }
  });
  $('picker-modal').addEventListener('click', function (event) { if (event.target === $('picker-modal')) closePicker(); });

  document.addEventListener('click', function (event) {
    var tile = event.target.closest('#lease-tiles .tile');
    if (tile) selectTile(tile);
  });
  $('lease-modal-close').addEventListener('click', closeLeaseModal);
  $('lease-cancel').addEventListener('click', closeLeaseModal);
  $('lease-done').addEventListener('click', closeLeaseModal);
  $('lease-create').addEventListener('click', function () { submitLease().catch(showError); });
  $('copy-url').addEventListener('click', async function () {
    try { await copyToClipboard($('created-url').textContent || ''); toast('Link copied to clipboard.', 'success'); }
    catch (err) { showError(err); }
  });
  $('lease-modal').addEventListener('click', function (event) { if (event.target === $('lease-modal')) closeLeaseModal(); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      if (!$('lease-modal').classList.contains('hidden')) closeLeaseModal();
      else if (!$('mount-modal').classList.contains('hidden')) closeMountModal();
      else if (!$('picker-modal').classList.contains('hidden')) closePicker();
    }
  });

  // boot
  api('/dashboard/api/me')
    .then(async function (resp) {
      $('who').textContent = (resp.user && resp.user.username) || '';
      $('who-role').classList.toggle('hidden', !(resp.user && resp.user.admin));
      showApp(true);
      await refresh();
    })
    .catch(function () { showApp(false); $('login').classList.remove('hidden'); });
})();
</script>
</body>
</html>`;

const LEASE_BROWSER_PAGE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mvmt folder lease</title>
  <style>
  body{font-family:ui-sans-serif,system-ui,sans-serif;margin:2rem;max-width:960px;color:#0f172a}
  table{border-collapse:collapse;width:100%}
  td,th{border-bottom:1px solid #ddd;padding:.5rem;text-align:left}
  a{color:#0f766e}
  .meta,.status,.hint{color:#666}
  .upload{border:1px dashed #94a3b8;border-radius:8px;padding:1rem;margin:1rem 0;background:#f8fafc}
  .upload.drag{border-color:#0f766e;background:#ecfdf5}
  .hidden{display:none}
  input{margin-top:.5rem}
  </style>
</head>
<body>
<h1 id="title">Folder lease</h1>
  <p class="meta" id="meta"></p>
  <p id="parent"></p>
  <p class="status" id="status"></p>
  <div class="upload hidden" id="upload">
    <strong>Upload to this folder</strong>
    <p class="hint">Choose files or drop them here. Existing filenames are saved with a suffix.</p>
    <input id="upload-files" type="file" multiple>
  </div>
  <table><thead><tr><th>Name</th><th>Type</th><th>Bytes</th></tr></thead><tbody id="entries"></tbody></table>
  <script>
const pathParts = location.pathname.split('/').filter(Boolean);
const leaseId = decodeURIComponent(pathParts[1] || '');
const params = new URLSearchParams(location.search);
const token = params.get('token') || params.get('t') || '';
const requestedPath = params.get('path') || '';
const title = document.getElementById('title');
const meta = document.getElementById('meta');
  const parent = document.getElementById('parent');
  const status = document.getElementById('status');
  const entries = document.getElementById('entries');
  const upload = document.getElementById('upload');
  const uploadInput = document.getElementById('upload-files');
  let currentListingPath = '/';

function pageUrl(nextPath) {
  const url = new URL('/lease/' + encodeURIComponent(leaseId), location.origin);
  if (nextPath && nextPath !== '/') url.searchParams.set('path', nextPath);
  if (token) url.searchParams.set('token', token);
  return url.pathname + url.search;
}

  function fileUrl(entryPath) {
  const encodedPath = entryPath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const url = new URL('/lease/' + encodeURIComponent(leaseId) + '/files/' + encodedPath, location.origin);
  if (token) url.searchParams.set('token', token);
  return url.pathname + url.search;
}

function parentPath(inputPath) {
  const parts = inputPath.split('/').filter(Boolean);
  parts.pop();
  return parts.length === 0 ? '/' : '/' + parts.join('/');
}

async function loadListing() {
  const url = new URL('/lease/' + encodeURIComponent(leaseId) + '/files', location.origin);
  if (requestedPath) url.searchParams.set('path', requestedPath);
  if (token) url.searchParams.set('token', token);
  const response = await fetch(url);
  if (!response.ok) {
    status.textContent = response.status === 401 ? 'Invalid or missing lease token.' : 'Folder is unavailable.';
    return;
  }

  function uploadUrl(fileName) {
    const parts = currentListingPath.split('/').filter(Boolean);
    parts.push(fileName);
    const encodedPath = parts.map(encodeURIComponent).join('/');
    const url = new URL('/lease/' + encodeURIComponent(leaseId) + '/files/' + encodedPath, location.origin);
    if (token) url.searchParams.set('token', token);
    return url.pathname + url.search;
  }
	  const listing = await response.json();
	  currentListingPath = listing.path || '/';
	  title.textContent = listing.label || 'Folder lease';
	  meta.textContent = (listing.path || '/') + (listing.expiresAt ? ' - expires ' + listing.expiresAt : '');
	  upload.classList.toggle('hidden', !listing.canUpload);
	  if (listing.path && listing.path !== '/') {
    const link = document.createElement('a');
    link.href = pageUrl(parentPath(listing.path));
    link.textContent = '..';
    parent.replaceChildren(link);
  }
  entries.replaceChildren(...listing.entries.map((entry) => {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    const link = document.createElement('a');
    link.href = entry.type === 'directory' ? pageUrl(entry.path) : fileUrl(entry.path);
    link.textContent = entry.name;
    nameCell.append(link);
    const typeCell = document.createElement('td');
    typeCell.textContent = entry.type;
    const sizeCell = document.createElement('td');
    sizeCell.textContent = entry.type === 'directory' ? '' : String(entry.size);
    row.append(nameCell, typeCell, sizeCell);
    return row;
	  }));
	}

	async function uploadFiles(fileList) {
	  const files = Array.from(fileList || []);
	  if (files.length === 0) return;
	  for (const file of files) {
	    status.textContent = 'Uploading ' + file.name + '...';
	    const response = await fetch(uploadUrl(file.name), { method: 'PUT', body: file });
	    if (!response.ok) {
	      status.textContent = 'Upload failed: ' + file.name;
	      return;
	    }
	  }
	  uploadInput.value = '';
	  status.textContent = 'Upload complete.';
	  await loadListing();
	}

	uploadInput.addEventListener('change', () => uploadFiles(uploadInput.files));
	upload.addEventListener('dragover', (event) => {
	  event.preventDefault();
	  upload.classList.add('drag');
	});
	upload.addEventListener('dragleave', () => {
	  upload.classList.remove('drag');
	});
	upload.addEventListener('drop', (event) => {
	  event.preventDefault();
	  upload.classList.remove('drag');
	  uploadFiles(event.dataTransfer.files);
	});

loadListing().catch(() => {
  status.textContent = 'Folder is unavailable.';
});
</script>
</body>
</html>`;

const LEASE_UPLOAD_PAGE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mvmt upload lease</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;margin:2rem;max-width:720px}
.drop{border:2px dashed #bbb;border-radius:8px;padding:2rem;text-align:center}
.meta,.status{color:#666}
button{padding:.55rem .8rem}
</style>
</head>
<body>
<h1>Upload files</h1>
<p class="meta">Upload-only lease</p>
<div class="drop">
  <input id="files" type="file" multiple>
  <p class="status" id="status">Choose files or drop them here.</p>
</div>
<script>
const pathParts = location.pathname.split('/').filter(Boolean);
const leaseId = decodeURIComponent(pathParts[1] || '');
const params = new URLSearchParams(location.search);
const token = params.get('token') || params.get('t') || '';
const drop = document.querySelector('.drop');
const input = document.getElementById('files');
const status = document.getElementById('status');
function uploadPath(name) {
  return '/lease/' + encodeURIComponent(leaseId) + '/files/' + encodeURIComponent(name) + '?token=' + encodeURIComponent(token);
}
async function uploadFiles(files) {
  for (const file of files) {
    status.textContent = 'Uploading ' + file.name + '...';
    const response = await fetch(uploadPath(file.name), { method: 'PUT', body: file });
    if (!response.ok) {
      status.textContent = 'Upload failed: ' + file.name;
      return;
    }
  }
  status.textContent = 'Upload complete.';
  input.value = '';
}
input.addEventListener('change', () => uploadFiles(input.files));
drop.addEventListener('dragover', (event) => {
  event.preventDefault();
});
drop.addEventListener('drop', (event) => {
  event.preventDefault();
  uploadFiles(event.dataTransfer.files);
});
</script>
</body>
</html>`;

function requestClientHint(req: Request, oauthClientId?: string): string | undefined {
  const values = [
    oauthClientId,
    firstHeaderValue(req.headers['user-agent']),
  ].filter((value): value is string => Boolean(value));
  return values.length > 0 ? values.join(' ') : undefined;
}

type AuthorizeApproval =
  | { ok: true; mvmtClientId?: string; mvmtClientCredentialVersion?: number }
  | { ok: false; phase: string; message: string };

function resolveAuthorizeApproval(
  body: Record<string, unknown>,
  clients: readonly ClientConfig[],
  tokenPath: string | undefined,
  clientHint?: string,
): AuthorizeApproval {
  const apiTokenRaw = stringField(body.api_token);
  if (apiTokenRaw) {
    const client = findApiTokenClient(apiTokenRaw, clients, clientHint);
    if (client) {
      return {
        ok: true,
        mvmtClientId: client.id,
        mvmtClientCredentialVersion: clientCredentialVersion(client),
      };
    }
    return {
      ok: false,
      phase: 'deny_invalid_api_token',
      message: 'Invalid API token. Try again.',
    };
  }

  const hasPolicy = clients.length > 0;
  if (hasPolicy) {
    return {
      ok: false,
      phase: 'deny_missing_api_token',
      message: 'Enter a scoped API token. Create one with mvmt token add.',
    };
  }

  const sessionTokenRaw = stringField(body.session_token);
  if (sessionTokenRaw && validateSessionToken(`Bearer ${sessionTokenRaw}`, tokenPath)) {
    return { ok: true };
  }
  return {
    ok: false,
    phase: 'deny_invalid_session_token',
    message: 'Invalid API token. Try again.',
  };
}

function findApiTokenClient(token: string, clients: readonly ClientConfig[], clientHint?: string): ClientConfig | undefined {
  for (const client of clients) {
    if (client.auth.type !== 'token') continue;
    if (isExpired(client.expiresAt)) continue;
    if (!clientBindingMatches(client.clientBinding, clientHint)) continue;
    if (verifyApiToken(token, client.auth.tokenHash)) return client;
  }
  return undefined;
}

function oauthGrantMatchesCurrentClient(token: AccessToken, clients: readonly ClientConfig[], clientHint?: string): boolean {
  if (!token.mvmtClientId) return true;
  const client = clients.find((entry) => entry.id === token.mvmtClientId && entry.auth.type === 'token');
  return Boolean(
    client
      && !isExpired(client.expiresAt)
      && clientCredentialVersion(client) === (token.mvmtClientCredentialVersion ?? 1)
      && clientBindingMatches(client.clientBinding, clientHint),
  );
}

// Used in request logs for redirect/resource URIs. We log the host only
// (not the full path) because full redirect URLs can include
// client-supplied identifiers that belong in an audit trail but not in
// a general request log.
function safeHost(uri: string): string {
  try {
    return new URL(uri).host || '(unknown)';
  } catch {
    return '(invalid)';
  }
}

function formatAuthorizeLogDetail(input: {
  phase: string;
  requestId: string;
  redirectUri: string;
  resource?: string;
  resourceDefaulted?: boolean;
  state?: string;
  authorizedClientId?: string;
}): string {
  const authorizedClient = input.authorizedClientId ? ` authorized_client=${input.authorizedClientId}` : '';
  return `${input.phase} rid=${input.requestId} redirect_host=${safeHost(input.redirectUri)} resource_host=${input.resource ? safeHost(input.resource) : '(none)'} resource_defaulted=${input.resourceDefaulted ? 'true' : 'false'} state_hash=${hashForLog(input.state)}${authorizedClient}`;
}

function hashForLog(value: string | undefined): string {
  if (!value) return '(none)';
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function buildOriginCheck(extraAllowed: string[]): (req: Request) => boolean {
  const allowed = new Set<string>(extraAllowed.map((origin) => origin.toLowerCase()));

  return (req) => {
    const rawOrigin = req.headers.origin;
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
    if (!origin) return true;

    if (allowed.has(origin.toLowerCase())) return true;

    try {
      const parsed = new URL(origin);
      const host = parsed.hostname.toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
        return true;
      }
    } catch {
      return false;
    }
    return false;
  };
}

function originMatchesBaseUrl(req: Request, baseUrl: string): boolean {
  const origin = firstHeaderValue(req.headers.origin);
  if (!origin) return true;
  const requestOrigin = normalizedOrigin(origin);
  const baseOrigin = normalizedOrigin(baseUrl);
  return requestOrigin !== undefined && requestOrigin === baseOrigin;
}

function normalizedOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return undefined;
  }
}
