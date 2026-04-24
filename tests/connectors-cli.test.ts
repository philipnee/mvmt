import { describe, expect, it } from 'vitest';
import { getConnectorSetupStatuses } from '../src/cli/connectors.js';
import { MvmtConfig } from '../src/config/schema.js';
import { upsertProxyConfig } from '../src/connectors/setup-utils.js';

const baseConfig: MvmtConfig = {
  version: 1,
  server: {
    port: 4141,
    allowedOrigins: [],
    access: 'local',
  },
  proxy: [],
  plugins: [],
};

describe('connector setup helpers', () => {
  it('reports unconfigured local connector setups', () => {
    const statuses = getConnectorSetupStatuses(baseConfig);

    expect(statuses.map((status) => [status.name, status.configured, status.addable])).toEqual([
      ['filesystem', false, false],
      ['obsidian', false, false],
      ['mempalace', false, true],
    ]);
  });

  it('reports configured local connector setups', () => {
    const statuses = getConnectorSetupStatuses({
      ...baseConfig,
      proxy: [
        {
          name: 'filesystem',
          transport: 'stdio',
          command: 'npx',
          args: [],
          env: {},
          enabled: true,
        },
        {
          name: 'mempalace',
          transport: 'stdio',
          command: '/venv/bin/python',
          args: ['-m', 'mempalace.mcp_server'],
          env: {},
          writeAccess: false,
          enabled: true,
        },
      ],
      obsidian: {
        path: '/vault',
        enabled: true,
        writeAccess: false,
      },
    });

    expect(statuses.map((status) => [status.name, status.configured])).toEqual([
      ['filesystem', true],
      ['obsidian', true],
      ['mempalace', true],
    ]);
  });

  it('upserts proxy config by connector name', () => {
    const config = upsertProxyConfig(
      {
        ...baseConfig,
        proxy: [
          {
            name: 'MemPalace',
            transport: 'stdio',
            command: '/old/python',
            args: [],
            env: {},
            writeAccess: false,
            enabled: true,
          },
        ],
      },
      {
        name: 'mempalace',
        transport: 'stdio',
        command: '/new/python',
        args: ['-m', 'mempalace.mcp_server'],
        env: {},
        writeAccess: true,
        enabled: true,
      },
    );

    expect(config.proxy).toEqual([
      {
        name: 'mempalace',
        transport: 'stdio',
        command: '/new/python',
        args: ['-m', 'mempalace.mcp_server'],
        env: {},
        writeAccess: true,
        enabled: true,
      },
    ]);
  });
});
