import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TunnelController } from '../src/cli/tunnel-controller.js';
import { Logger } from '../src/utils/logger.js';
import * as tunnelUtils from '../src/utils/tunnel.js';

vi.mock('../src/utils/tunnel.js', () => ({
  missingTunnelDependency: vi.fn(),
  startTunnel: vi.fn(),
  formatMcpPublicUrl: (url: string) => url,
}));

vi.mock('../src/cli/tunnel.js', () => ({
  printMissingTunnelDependencyWarning: vi.fn(),
}));

describe('TunnelController', () => {
  let logger: Logger;
  let serverConfig: any;

  beforeEach(() => {
    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as any;
    serverConfig = { access: 'local' };
    vi.clearAllMocks();
  });

  it('returns an unconfigured snapshot by default', () => {
    const controller = new TunnelController(serverConfig, 4141, logger);
    expect(controller.snapshot()).toEqual({
      configured: false,
      running: false,
      command: undefined,
      publicUrl: undefined,
      recentLogs: [],
      lastError: undefined,
    });
  });

  it('returns configured but not running snapshot after configuration', () => {
    const controller = new TunnelController(serverConfig, 4141, logger);
    controller.configure({ provider: 'localhost-run', command: 'ssh -R 80:localhost:{port} localhost.run' });
    
    expect(controller.snapshot()).toMatchObject({
      configured: true,
      running: false,
      command: 'ssh -R 80:localhost:4141 localhost.run',
    });
  });

  it('treats saved tunnel details as configured even before access is enabled', async () => {
    serverConfig = {
      access: 'local',
      tunnel: { provider: 'localhost-run', command: 'ssh -R 80:localhost:{port} localhost.run' },
    };
    const controller = new TunnelController(serverConfig, 4141, logger);
    const mockTunnel = { url: 'https://test.localhost.run', stop: vi.fn() };
    vi.mocked(tunnelUtils.startTunnel).mockResolvedValue(mockTunnel as any);
    vi.mocked(tunnelUtils.missingTunnelDependency).mockReturnValue(undefined);

    expect(controller.snapshot().configured).toBe(true);
    await controller.start();

    expect(serverConfig.access).toBe('local');
    expect(controller.snapshot().running).toBe(false);

    await controller.start({ enable: true });

    expect(serverConfig.access).toBe('tunnel');
    expect(controller.snapshot().running).toBe(true);
  });

  it('updates snapshot fields when starting', async () => {
    const controller = new TunnelController(serverConfig, 4141, logger);
    const tunnelConfig = { provider: 'localhost-run' as const, command: 'ssh -R 80:localhost:{port} localhost.run' };
    controller.configure(tunnelConfig);

    const mockTunnel = { url: 'https://test.localhost.run', stop: vi.fn() };
    vi.mocked(tunnelUtils.startTunnel).mockResolvedValue(mockTunnel as any);
    vi.mocked(tunnelUtils.missingTunnelDependency).mockReturnValue(undefined);

    await controller.start();

    expect(controller.snapshot()).toMatchObject({
      configured: true,
      running: true,
      publicUrl: 'https://test.localhost.run',
    });
    expect(logger.info).toHaveBeenCalledWith('Tunnel URL: https://test.localhost.run');
  });

  it('captures logs and notifies subscribers', async () => {
    const controller = new TunnelController(serverConfig, 4141, logger);
    controller.configure({ provider: 'localhost-run', command: 'ssh' });

    let capturedLine = '';
    controller.subscribeLogs((line) => {
      capturedLine = line;
    });

    vi.mocked(tunnelUtils.startTunnel).mockImplementation(async (_cmd, _port, options) => {
      options?.onOutput?.('test log line');
      return { url: 'https://test.url', stop: vi.fn() } as any;
    });

    await controller.start();
    expect(capturedLine).toBe('test log line');
    expect(controller.recentLogs()).toContain('test log line');
  });

  it('stop() is a no-op when not running', async () => {
    const controller = new TunnelController(serverConfig, 4141, logger);
    await expect(controller.stop()).resolves.toBeUndefined();
  });

  it('records lastError when tunnel fails to start', async () => {
    const controller = new TunnelController(serverConfig, 4141, logger);
    controller.configure({ provider: 'localhost-run', command: 'ssh' });

    vi.mocked(tunnelUtils.startTunnel).mockRejectedValue(new Error('connection failed'));
    
    await controller.start();
    expect(controller.snapshot().lastError).toBe('connection failed');
  });
});
