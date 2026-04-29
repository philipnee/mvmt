import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/loader.js';
import { tunnelExposureError } from '../src/cli/tunnel-safety.js';

describe('tunnelExposureError', () => {
  it('requires scoped clients before enabling tunnel access', () => {
    const config = parseConfig({
      version: 1,
      server: {
        access: 'tunnel',
        tunnel: {
          provider: 'cloudflare-quick',
          command: 'cloudflared tunnel --url http://127.0.0.1:{port}',
        },
      },
    });

    expect(tunnelExposureError(config, {})).toContain('requires clients[]');
  });

  it('allows tunnel access with client policy or explicit unsafe override', () => {
    const config = parseConfig({
      version: 1,
      server: {
        access: 'tunnel',
        tunnel: {
          provider: 'cloudflare-quick',
          command: 'cloudflared tunnel --url http://127.0.0.1:{port}',
        },
      },
      mounts: [{ name: 'workspace', type: 'local_folder', path: '/workspace', root: '/tmp/workspace' }],
      clients: [
        {
          id: 'codex',
          name: 'Codex',
          auth: { type: 'token', tokenHash: 'a'.repeat(64) },
          permissions: [{ path: '/workspace/**', actions: ['search', 'read'] }],
        },
      ],
    });

    expect(tunnelExposureError(config, {})).toBeUndefined();

    const legacy = parseConfig({
      version: 1,
      server: config.server,
    });
    expect(tunnelExposureError(legacy, { MVMT_ALLOW_LEGACY_TUNNEL: '1' })).toBeUndefined();
  });
});
