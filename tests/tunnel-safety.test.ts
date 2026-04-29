import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config/loader.js';
import { tunnelExposureError } from '../src/cli/tunnel-safety.js';
import { applyTunnelConfig, printTunnelSavedButDisabled } from '../src/cli/tunnel.js';

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe('applyTunnelConfig', () => {
  it('saves tunnel details without enabling unsafe tunnel access', () => {
    const config = parseConfig({ version: 1 });
    const tunnel = {
      provider: 'custom' as const,
      command: 'cloudflared tunnel --config ~/.cloudflared/mvmt.yml run',
      url: 'https://mvmt.example.com',
    };

    const applied = applyTunnelConfig(config, tunnel, {});

    expect(applied.enabled).toBe(false);
    expect(applied.safetyError).toContain('requires clients[]');
    expect(applied.config.server.access).toBe('local');
    expect(applied.config.server.tunnel).toEqual(tunnel);
  });

  it('enables tunnel access when scoped clients are configured', () => {
    const config = parseConfig({
      version: 1,
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
    const tunnel = {
      provider: 'custom' as const,
      command: 'cloudflared tunnel --config ~/.cloudflared/mvmt.yml run',
      url: 'https://mvmt.example.com',
    };

    const applied = applyTunnelConfig(config, tunnel, {});

    expect(applied.enabled).toBe(true);
    expect(applied.safetyError).toBeUndefined();
    expect(applied.config.server.access).toBe('tunnel');
    expect(applied.config.server.tunnel).toEqual(tunnel);
  });

  it('prints concrete next steps when tunnel settings are saved but disabled', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    printTunnelSavedButDisabled('Tunnel access requires clients[].');

    const lines = output.mock.calls.map((call) => String(call[0])).join('\n');
    expect(lines).toContain('mvmt is still local-only');
    expect(lines).toContain('MVMT_ALLOW_LEGACY_TUNNEL=1 mvmt serve -i');
    expect(lines).toContain('add clients[] permissions');
  });
});
