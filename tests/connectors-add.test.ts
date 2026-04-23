import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema, MvmtConfig } from '../src/config/schema.js';

const mocks = vi.hoisted(() => ({
  expandHome: vi.fn((value: string) => value),
  getConfigPath: vi.fn(),
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  getConnectorSetupDefinition: vi.fn(),
  detect: vi.fn(),
  prompt: vi.fn(),
  apply: vi.fn(),
  isConfigured: vi.fn(),
}));

vi.mock('../src/config/loader.js', () => ({
  expandHome: mocks.expandHome,
  getConfigPath: mocks.getConfigPath,
  loadConfig: mocks.loadConfig,
  saveConfig: mocks.saveConfig,
}));

vi.mock('../src/connectors/setup-registry.js', () => ({
  getConnectorSetupDefinition: mocks.getConnectorSetupDefinition,
  getSetupRegistry: vi.fn(() => []),
}));

const { addConnector } = await import('../src/cli/connectors.js');

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

describe('addConnector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.getConfigPath.mockReturnValue('/tmp/mvmt-config.yaml');
    mocks.loadConfig.mockReturnValue(baseConfig);
    mocks.isConfigured.mockReturnValue(false);
  });

  it('uses the setup registry to detect, prompt, apply, and save MemPalace config', async () => {
    const detected = { command: '/venv/bin/python', palacePath: '/Users/me/.mempalace/palace' };
    const input = { command: '/venv/bin/python', palacePath: '/Users/me/.mempalace/palace', writeAccess: false };
    const nextConfig: MvmtConfig = {
      ...baseConfig,
      proxy: [
        {
          name: 'mempalace',
          source: 'mempalace',
          transport: 'stdio',
          command: '/venv/bin/python',
          args: ['-m', 'mempalace.mcp_server', '--palace', '/Users/me/.mempalace/palace'],
          env: {},
          writeAccess: false,
          enabled: true,
        },
      ],
    };

    mocks.detect.mockResolvedValue(detected);
    mocks.prompt.mockResolvedValue(input);
    mocks.apply.mockReturnValue(nextConfig);
    mocks.getConnectorSetupDefinition.mockReturnValue({
      id: 'mempalace',
      displayName: 'MemPalace',
      isAddable: true,
      detect: mocks.detect,
      prompt: mocks.prompt,
      isConfigured: mocks.isConfigured,
      apply: mocks.apply,
    });

    await addConnector('mempalace');

    expect(mocks.detect).toHaveBeenCalledTimes(1);
    expect(mocks.prompt).toHaveBeenCalledWith(detected);
    expect(mocks.apply).toHaveBeenCalledWith(baseConfig, input);
    expect(mocks.saveConfig).toHaveBeenCalledWith('/tmp/mvmt-config.yaml', nextConfig);
    expect(() => ConfigSchema.parse(mocks.saveConfig.mock.calls[0][1])).not.toThrow();
  });
});
