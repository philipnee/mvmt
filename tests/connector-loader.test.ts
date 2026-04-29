import { describe, expect, it, vi, beforeEach } from 'vitest';
import { initializeConnectors, formatConnectorError } from '../src/cli/connector-loader.js';
import * as factory from '../src/connectors/factory.js';

vi.mock('../src/connectors/factory.js', () => ({
  createProxyConnector: vi.fn(),
}));

describe('connector-loader', () => {
  let logger: any;

  beforeEach(() => {
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    vi.clearAllMocks();
  });

  describe('formatConnectorError', () => {
    it('returns raw message for normal errors', () => {
      expect(formatConnectorError(new Error('raw error'))).toBe('raw error');
    });

    it('extracts validation paths from JSON error arrays', () => {
      const jsonError = JSON.stringify([
        { path: ['tools', 0, 'name'], message: 'invalid' },
        { path: ['capabilities'], message: 'missing' }
      ]);
      expect(formatConnectorError(new Error(jsonError))).toContain('upstream server returned invalid MCP schema at tools.0.name, capabilities');
    });
  });

  describe('initializeConnectors', () => {
    it('skips undefined proxy connectors', async () => {
      vi.mocked(factory.createProxyConnector).mockReturnValue(undefined);
      const config = { proxy: [{ name: 'test', enabled: true }] } as any;
      
      const loaded = await initializeConnectors(config, false, logger);
      expect(loaded).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('has no command or url'));
    });

    it('logs warning and continues when one connector fails', async () => {
      const failConnector = {
        initialize: vi.fn().mockRejectedValue(new Error('init failed')),
        id: 'fail',
      };
      const okConnector = {
        initialize: vi.fn().mockResolvedValue(undefined),
        listTools: vi.fn().mockResolvedValue([{ name: 'tool1' }]),
        id: 'ok',
      };

      vi.mocked(factory.createProxyConnector)
        .mockReturnValueOnce(failConnector as any)
        .mockReturnValueOnce(okConnector as any);

      const config = { 
        proxy: [
          { name: 'fail', enabled: true },
          { name: 'ok', enabled: true }
        ] 
      } as any;

      const loaded = await initializeConnectors(config, false, logger);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].toolCount).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('failed to start: init failed'));
    });
  });
});
