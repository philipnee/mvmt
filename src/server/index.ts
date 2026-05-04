import { createHash, randomUUID } from 'crypto';
import { Server as HttpServer } from 'node:http';
import express, { Request, Response } from 'express';
import type { AccessToken } from './oauth.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ToolRouter } from './router.js';
import { log } from '../utils/logger.js';
import { defaultClientsPath, defaultSigningKeyPath, ensureSessionToken, ensureSigningKey, readSigningKey, TOKEN_PATH, validateSessionToken } from '../utils/token.js';
import { verifyApiToken } from '../utils/api-token-hash.js';
import { isExpired } from '../utils/token-ttl.js';
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
import { ClientConfig } from '../config/schema.js';
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

type McpSession = {
  transport: StreamableHTTPServerTransport;
  server: Server;
  clientIdentity?: ClientIdentity;
  lastActivity: number;
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

export function createMcpServer(router: ToolRouter, clientIdentity?: ClientIdentity): Server {
  const server = new Server(
    { name: 'mvmt', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: MVMT_SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: router.getAllTools(clientIdentity).map((tool) => ({
      name: tool.namespacedName,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object'; properties?: Record<string, object>; required?: string[] },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await router.callTool(request.params.name, request.params.arguments ?? {}, clientIdentity);
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
  // Create the signing key file on first boot, then re-read it on every
  // HMAC op. This way internal session-token rotation (which rewrites the file)
  // invalidates outstanding OAuth access tokens immediately, without
  // requiring a server restart.
  ensureSigningKey(signingKeyPath);
  const clientsPath = defaultClientsPath(tokenPath ?? TOKEN_PATH);
  const oauth = new OAuthStore({
    signingKey: () => readSigningKey(signingKeyPath) ?? ensureSigningKey(signingKeyPath),
    clientsPath,
  });
  const oauthCleanup = setInterval(() => oauth.cleanup(), 60 * 1000);
  oauthCleanup.unref();

  const sessions = new Map<string, McpSession>();
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    const staleTimeoutMs = 30 * 60 * 1000;

    for (const [id, session] of sessions) {
      if (now - session.lastActivity > staleTimeoutMs) {
        session.transport.close().catch(() => undefined);
        sessions.delete(id);
      }
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
    const identity = resolveClientIdentity({
      authHeader,
      clients: resolveClients(options.clients),
      oauthAccessToken,
      validateSession: (header) => validateSessionToken(header, tokenPath),
      allowLegacyDefault: resolveAllowLegacyDefaultClient(options.allowLegacyDefaultClient),
      clientHint: requestClientHint(req, oauthAccessToken?.clientId),
    });
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
        logHttpRequest(requestLog, req, 400, 'oauth.token', err.code, requestClientId);
        res.status(400).json({ error: err.code, error_description: err.message });
        return;
      }
      log.warn(`Token exchange failed: ${err instanceof Error ? err.message : 'unknown'}`);
      logHttpRequest(requestLog, req, 500, 'oauth.token', 'server_error', requestClientId);
      res.status(500).json({ error: 'server_error' });
    }
  });

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
    if (!sameClientIdentity(session.clientIdentity, readClientIdentity(req))) {
      res.status(403).json({ error: 'mcp_session_client_mismatch' });
      return;
    }
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
  const clientIdentity = readClientIdentity(req);
  const server = createMcpServer(router, clientIdentity);

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
    sessions.set(transport.sessionId, { transport, server, clientIdentity, lastActivity: Date.now() });
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
