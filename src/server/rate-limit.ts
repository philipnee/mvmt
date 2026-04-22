import type { RequestHandler } from 'express';

// Fixed-window per-IP rate limiter. Defense-in-depth against brute-force
// of bearer and session tokens, and against DoS of the auth routes when
// mvmt is exposed via a tunnel. For local 127.0.0.1 usage the limiter
// is mostly inert — a single user cannot realistically exceed the
// configured budgets — but the middleware is applied uniformly so a
// remote attacker funneled through the tunnel hits the same cap.
//
// Note: req.ip is only meaningful when express is configured to trust
// its proxy chain. We deliberately do NOT trust X-Forwarded-For here
// (it can be spoofed by a tunnel client), so every tunneled request
// shares the same bucket as the tunnel's local socket. That is
// acceptable for a single-user tool.

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

export function rateLimit(options: RateLimitOptions): RequestHandler & { dispose: () => void } {
  const hits = new Map<string, { count: number; resetAt: number }>();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt < now) hits.delete(key);
    }
  }, options.windowMs);
  cleanup.unref();

  const middleware: RequestHandler = (req, res, next) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const entry = hits.get(ip);

    if (!entry || entry.resetAt < now) {
      hits.set(ip, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    entry.count += 1;
    if (entry.count > options.max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Too Many Requests' });
      return;
    }
    next();
  };

  return Object.assign(middleware, {
    dispose: () => {
      clearInterval(cleanup);
      hits.clear();
    },
  });
}
