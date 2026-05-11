import { createHash, randomUUID } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import fsp from 'fs/promises';
import { Server as HttpServer } from 'node:http';
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
    const session = createDashboardSession(user.id, user.username);
    dashboardSessions.set(session.id, session);
    res.setHeader('Set-Cookie', dashboardSessionCookie(session, baseUrlFor(req)));
    logHttpRequest(requestLog, req, 200, 'dashboard.login', 'ok', user.username);
    res.json({ user: publicDashboardUser(user) });
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
    res.json({ user: { username: session.username }, localOwner: false });
  });

  app.get('/dashboard/api/mounts', dashboardOriginMiddleware, dashboardAuthMiddleware, (req, res) => {
    const mounts = resolveLeaseMounts(options.leaseMounts).filter((mount) => mount.enabled !== false);
    logHttpRequest(requestLog, req, 200, 'dashboard.mounts');
    res.json({
      mounts: mounts.map((mount) => ({
        name: mount.name,
        path: mount.path,
        description: mount.description,
        writeAccess: Boolean(mount.writeAccess),
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
    if (mode !== 'read' && mode !== 'write') {
      res.status(400).json({ error: 'invalid_mode' });
      return;
    }
    try {
      const resources = await dashboardLeaseResources(resolveLeaseMounts(options.leaseMounts), paths, mode);
      const ttl = parseTokenTtl(typeof body.expires === 'string' ? body.expires : DEFAULT_DASHBOARD_LEASE_TTL);
      const permissions = mode === 'write' ? ['read', 'write'] as const : ['read'] as const;
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
      res.status(200).json(listing);
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
    if (!leaseAllows(lease, 'upload') && !allowOverwrite) {
      logHttpRequest(requestLog, req, 403, 'lease.request', 'permission_denied', lease.id);
      res.status(403).json({ error: 'lease_permission_denied' });
      return;
    }

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
      target = await resolveLeaseUploadTarget(resolveLeaseMounts(options.leaseMounts), lease, requestPath, { allowOverwrite });
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
      logHttpRequest(requestLog, req, status, 'lease.upload', target.leaseRelativePath, lease.id);
      res.status(status).json({ path: target.leaseRelativePath ? `/${target.leaseRelativePath}` : '/', bytes });
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
  requestLog({
    ts: new Date().toISOString(),
    kind,
    method: req.method,
    path: req.path,
    status,
    ...(detail ? { detail } : {}),
    ...(clientId ? { clientId } : {}),
  });
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

function createDashboardSession(userId: string, username: string): DashboardSession {
  return {
    id: randomUUID(),
    userId,
    username,
    expiresAt: Date.now() + DASHBOARD_SESSION_TTL_MS,
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

async function dashboardLeaseResources(
  mounts: readonly LocalFolderMountConfig[],
  paths: string[],
  mode: 'read' | 'write',
): Promise<LeaseResource[]> {
  const resources: LeaseResource[] = [];
  for (const inputPath of paths) {
    const target = await resolveDashboardFileTarget(mounts, inputPath);
    if (mode === 'write' && !target.writeAccess) {
      throw new Error(`${target.virtualPath} is read-only`);
    }
    resources.push({
      path: resourcePathForDashboardPath(target.virtualPath),
      sourcePath: target.virtualPath,
      type: target.type === 'file' ? 'file' : 'folder',
    });
  }
  return uniqueDashboardLeaseResources(resources);
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
<title>mvmt dashboard</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;margin:2rem;max-width:1100px}
button,input,select{font:inherit;padding:.45rem .55rem}
table{border-collapse:collapse;width:100%;margin-top:1rem}
td,th{border-bottom:1px solid #ddd;padding:.5rem;text-align:left}
a{color:#0f766e}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.panel{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0}
.muted,.status{color:#666}
.hidden{display:none}
</style>
</head>
<body>
<h1>mvmt dashboard</h1>
<p class="status" id="status"></p>
<section id="login" class="panel">
  <h2>Login</h2>
  <form id="login-form" class="row">
    <input id="username" name="username" autocomplete="username" placeholder="username">
    <input id="password" name="password" type="password" autocomplete="current-password" placeholder="password">
    <button type="submit">Login</button>
  </form>
</section>
<section id="app" class="hidden">
  <div class="row">
    <button id="refresh">Refresh</button>
    <button id="logout">Logout</button>
  </div>
  <section class="panel">
    <h2>Files</h2>
    <p class="muted" id="current-path">/</p>
    <table><thead><tr><th>Name</th><th>Type</th><th>Write</th><th>Share</th></tr></thead><tbody id="files"></tbody></table>
  </section>
  <section class="panel">
    <h2>Create lease</h2>
    <form id="lease-form" class="row">
      <input id="lease-path" name="path" placeholder="/path">
      <input id="lease-label" name="label" placeholder="label">
      <select id="lease-mode" name="mode">
        <option value="read">read</option>
        <option value="write">write</option>
      </select>
      <input id="lease-expires" name="expires" placeholder="24h">
      <button type="submit">Create</button>
    </form>
    <p class="status" id="lease-url"></p>
  </section>
  <section class="panel">
    <h2>Leases</h2>
    <table><thead><tr><th>Label</th><th>Paths</th><th>Expires</th><th></th></tr></thead><tbody id="leases"></tbody></table>
  </section>
</section>
<script>
const statusEl = document.getElementById('status');
const loginSection = document.getElementById('login');
const appSection = document.getElementById('app');
const filesEl = document.getElementById('files');
const leasesEl = document.getElementById('leases');
const currentPathEl = document.getElementById('current-path');
const leaseUrlEl = document.getElementById('lease-url');
let currentPath = '/';

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'request failed');
  return response.json();
}

function showApp(show) {
  loginSection.classList.toggle('hidden', show);
  appSection.classList.toggle('hidden', !show);
}

async function loadFiles(path = currentPath) {
  currentPath = path;
  const listing = await api('/dashboard/api/files?path=' + encodeURIComponent(path));
  currentPathEl.textContent = listing.path;
  filesEl.replaceChildren(...listing.entries.map((entry) => {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = entry.name;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      if (entry.type === 'directory') loadFiles(entry.path).catch(showError);
      else document.getElementById('lease-path').value = entry.path;
    });
    name.append(link);
    const type = document.createElement('td');
    type.textContent = entry.type;
    const write = document.createElement('td');
    write.textContent = entry.writeAccess ? 'yes' : 'no';
    const share = document.createElement('td');
    const button = document.createElement('button');
    button.textContent = 'Use';
    button.addEventListener('click', () => {
      document.getElementById('lease-path').value = entry.path;
      document.getElementById('lease-label').value = entry.name;
    });
    share.append(button);
    row.append(name, type, write, share);
    return row;
  }));
}

async function loadLeases() {
  const payload = await api('/dashboard/api/leases');
  leasesEl.replaceChildren(...payload.leases.map((lease) => {
    const row = document.createElement('tr');
    const label = document.createElement('td');
    label.textContent = lease.label;
    const paths = document.createElement('td');
    paths.textContent = (lease.resources || []).map((resource) => resource.path).join(', ');
    const expires = document.createElement('td');
    expires.textContent = lease.revokedAt ? 'revoked' : (lease.expiresAt || 'never');
    const action = document.createElement('td');
    if (!lease.revokedAt) {
      const revoke = document.createElement('button');
      revoke.textContent = 'Revoke';
      revoke.addEventListener('click', async () => {
        await api('/dashboard/api/leases/' + encodeURIComponent(lease.id) + '/revoke', { method: 'POST', body: '{}' });
        await loadLeases();
      });
      action.append(revoke);
    }
    row.append(label, paths, expires, action);
    return row;
  }));
}

async function refresh() {
  await loadFiles(currentPath);
  await loadLeases();
}

function showError(error) {
  statusEl.textContent = error.message || String(error);
}

document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/dashboard/api/login', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      }),
    });
    showApp(true);
    await refresh();
  } catch (error) {
    showError(error);
  }
});

document.getElementById('lease-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = await api('/dashboard/api/leases', {
      method: 'POST',
      body: JSON.stringify({
        path: document.getElementById('lease-path').value,
        label: document.getElementById('lease-label').value,
        mode: document.getElementById('lease-mode').value,
        expires: document.getElementById('lease-expires').value || '24h',
      }),
    });
    leaseUrlEl.textContent = payload.lease.url;
    await loadLeases();
  } catch (error) {
    showError(error);
  }
});

document.getElementById('refresh').addEventListener('click', () => refresh().catch(showError));
document.getElementById('logout').addEventListener('click', async () => {
  await api('/dashboard/api/logout', { method: 'POST', body: '{}' });
  showApp(false);
});

api('/dashboard/api/me')
  .then(async () => {
    showApp(true);
    await refresh();
  })
  .catch(() => showApp(false));
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
body{font-family:ui-sans-serif,system-ui,sans-serif;margin:2rem;max-width:960px}
table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #ddd;padding:.5rem;text-align:left}
a{color:#0f766e}
.meta,.status{color:#666}
</style>
</head>
<body>
<h1 id="title">Folder lease</h1>
<p class="meta" id="meta"></p>
<p id="parent"></p>
<p class="status" id="status"></p>
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
  const listing = await response.json();
  title.textContent = listing.label || 'Folder lease';
  meta.textContent = (listing.path || '/') + (listing.expiresAt ? ' - expires ' + listing.expiresAt : '');
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
