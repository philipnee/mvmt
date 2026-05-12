import { afterEach, describe, expect, it } from 'vitest';
import { resolveRelayClientOptions } from '../src/utils/relay-client.js';

const RELAY_ENV = ['MVMT_RELAY_URL', 'MVMT_RELAY_WORKSPACE', 'MVMT_RELAY_TOKEN'] as const;
const originalEnv = Object.fromEntries(RELAY_ENV.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of RELAY_ENV) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('relay client options', () => {
  it('stays disabled when no relay config is present', () => {
    for (const key of RELAY_ENV) delete process.env[key];

    expect(resolveRelayClientOptions({ localPort: 4141 })).toBeUndefined();
  });

  it('requires complete relay config once any relay field is set', () => {
    for (const key of RELAY_ENV) delete process.env[key];
    process.env.MVMT_RELAY_URL = 'ws://127.0.0.1:8080/connect';

    expect(() => resolveRelayClientOptions({ localPort: 4141 }))
      .toThrow('Relay mode requires a relay URL, workspace slug, and agent token.');
  });

  it('reads saved relay tunnel config', () => {
    for (const key of RELAY_ENV) delete process.env[key];

    expect(resolveRelayClientOptions({
      localPort: 4141,
      tunnel: {
        provider: 'relay',
        relayUrl: 'ws://127.0.0.1:8080/connect',
        workspaceSlug: 'demo',
        agentToken: 'agent-secret',
      },
    })).toMatchObject({
      relayUrl: 'ws://127.0.0.1:8080/connect',
      workspaceSlug: 'demo',
      agentToken: 'agent-secret',
      localPort: 4141,
    });
  });

  it('prefers explicit CLI options over environment variables', () => {
    process.env.MVMT_RELAY_URL = 'ws://env/connect';
    process.env.MVMT_RELAY_WORKSPACE = 'env';
    process.env.MVMT_RELAY_TOKEN = 'env-token';

    expect(resolveRelayClientOptions({
      relayUrl: 'ws://cli/connect',
      workspaceSlug: 'cli',
      agentToken: 'cli-token',
      localPort: 4207,
    })).toMatchObject({
      relayUrl: 'ws://cli/connect',
      workspaceSlug: 'cli',
      agentToken: 'cli-token',
      localPort: 4207,
    });
  });
});
