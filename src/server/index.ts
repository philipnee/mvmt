import { randomUUID } from 'crypto';
import { Server as HttpServer } from 'node:http';
import express, { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ToolRouter } from './router.js';
import { log } from '../utils/logger.js';
import { generateSessionToken, validateSessionToken } from '../utils/token.js';
import {
  CodeChallengeMethod,
  OAuthError,
  OAuthStore,
  getBaseUrl,
  renderAuthorizePage,
} from './oauth.js';

type McpSession = {
  transport: StreamableHTTPServerTransport;
  server: Server;
  lastActivity: number;
};

export interface HttpServerOptions {
  port: number;
  allowedOrigins?: string[];
}

export interface StartedHttpServer {
  port: number;
  close(): Promise<void>;
}

export function createMcpServer(router: ToolRouter): Server {
  const server = new Server(
    { name: 'mvmt', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: router.getAllTools().map((tool) => ({
      name: tool.namespacedName,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object'; properties?: Record<string, object>; required?: string[] },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await router.callTool(request.params.name, request.params.arguments ?? {});
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
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  generateSessionToken();
  const oauth = new OAuthStore();
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

  const originCheck = buildOriginCheck(options.allowedOrigins ?? []);

  const authMiddleware: express.RequestHandler = (req, res, next) => {
    if (!originCheck(req)) {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }
    if (
      oauth.validateAccessToken(req.headers.authorization) ||
      validateSessionToken(req.headers.authorization)
    ) {
      next();
      return;
    }

    const baseUrl = getBaseUrl(req);
    res.setHeader(
      'WWW-Authenticate',
      `Bearer realm="mvmt", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
    );
    res.status(401).json({ error: 'Invalid or missing bearer token' });
  };

  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const baseUrl = getBaseUrl(req);
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      // S256 is strongly preferred. plain is kept for compatibility with
      // simple MCP/OAuth clients during the v0 tunnel flow.
      code_challenge_methods_supported: ['S256', 'plain'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    });
  });

  const protectedResourceMetadata = (req: Request, res: Response) => {
    const baseUrl = getBaseUrl(req);
    res.json({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
    });
  };
  app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata);

  app.post('/register', (req, res) => {
    const requested = (req.body ?? {}) as Record<string, unknown>;
    const clientId =
      typeof requested.client_id === 'string' && requested.client_id.length > 0
        ? (requested.client_id as string)
        : `mvmt-${Date.now().toString(36)}`;
    res.status(201).json({
      client_id: clientId,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      redirect_uris: Array.isArray(requested.redirect_uris) ? requested.redirect_uris : [],
    });
  });

  app.get('/authorize', (req, res) => {
    const params = parseAuthorizeParams(req.query);
    if ('error' in params) {
      res.status(400).type('text/plain').send(params.error);
      return;
    }
    res.type('text/html').send(renderAuthorizePage(params));
  });

  app.post('/authorize', (req, res) => {
    const params = parseAuthorizeParams(req.body ?? {});
    if ('error' in params) {
      res.status(400).type('text/plain').send(params.error);
      return;
    }

    const sessionTokenRaw = typeof req.body?.session_token === 'string' ? req.body.session_token : '';
    if (!validateSessionToken(`Bearer ${sessionTokenRaw}`)) {
      res
        .status(401)
        .type('text/html')
        .send(renderAuthorizePage({ ...params, error: 'Invalid session token. Try again.' }));
      return;
    }

    const authCode = oauth.issueCode({
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      scope: params.scope,
    });

    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set('code', authCode.code);
    if (params.state) redirect.searchParams.set('state', params.state);
    res.redirect(302, redirect.toString());
  });

  app.post('/token', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const grantType = typeof body.grant_type === 'string' ? body.grant_type : undefined;
    if (grantType !== 'authorization_code') {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }

    const code = typeof body.code === 'string' ? body.code : undefined;
    const clientId = typeof body.client_id === 'string' ? body.client_id : undefined;
    const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : undefined;
    const codeVerifier = typeof body.code_verifier === 'string' ? body.code_verifier : undefined;

    if (!code || !clientId || !redirectUri || !codeVerifier) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    try {
      const accessToken = oauth.consumeCode({ code, clientId, redirectUri, codeVerifier });
      res.json({
        access_token: accessToken.token,
        token_type: 'Bearer',
        expires_in: oauth.tokenTtlSeconds,
        scope: accessToken.scope,
      });
    } catch (err) {
      if (err instanceof OAuthError) {
        res.status(400).json({ error: err.code, error_description: err.message });
        return;
      }
      log.warn(`Token exchange failed: ${err instanceof Error ? err.message : 'unknown'}`);
      res.status(500).json({ error: 'server_error' });
    }
  });

  app.post('/mcp', authMiddleware, async (req, res) => {
    await handleMcpRequest(req, res, router, sessions);
  });

  app.get('/mcp', authMiddleware, async (req, res) => {
    await handleMcpRequest(req, res, router, sessions);
  });

  app.delete('/mcp', authMiddleware, async (req, res) => {
    const sessionId = getSessionId(req);
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const session = sessions.get(sessionId)!;
    await session.transport.close();
    sessions.delete(sessionId);
    res.status(200).json({ ok: true });
  });

  app.get('/health', authMiddleware, (_req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      tools: router.getAllTools().length,
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
    session.lastActivity = Date.now();
    if (isStandaloneSseRequest(req)) {
      session.transport.closeStandaloneSSEStream();
    }
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  const server = createMcpServer(router);

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
    sessions.set(transport.sessionId, { transport, server, lastActivity: Date.now() });
  }
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
  state?: string;
  scope?: string;
  codeChallenge: string;
  codeChallengeMethod: CodeChallengeMethod;
};

function parseAuthorizeParams(source: Record<string, unknown>): AuthorizeParams | { error: string } {
  const responseType = stringField(source.response_type);
  const clientId = stringField(source.client_id);
  const redirectUri = stringField(source.redirect_uri);
  const codeChallenge = stringField(source.code_challenge);
  // S256 is strongly preferred. Defaulting to plain is compatibility behavior
  // for simple clients that omit code_challenge_method.
  const codeChallengeMethodRaw = stringField(source.code_challenge_method) ?? 'plain';

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

  if (codeChallengeMethodRaw !== 'S256' && codeChallengeMethodRaw !== 'plain') {
    return { error: 'Unsupported code_challenge_method' };
  }

  return {
    responseType,
    clientId,
    redirectUri,
    state: stringField(source.state),
    scope: stringField(source.scope),
    codeChallenge,
    codeChallengeMethod: codeChallengeMethodRaw,
  };
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
