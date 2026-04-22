import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createTemporaryFilesystemConfig, readFilesystemPaths } from '../src/cli/config.js';

describe('createTemporaryFilesystemConfig', () => {
  it('creates a temporary read-only filesystem config without touching saved config', async () => {
    const result = await createTemporaryFilesystemConfig({
      paths: ['~/Documents', '/tmp/demo'],
      port: 4142,
    });

    try {
      expect(result.config.server).toMatchObject({
        port: 4142,
        access: 'local',
      });
      expect(result.config.proxy).toHaveLength(1);
      expect(result.config.proxy[0]).toMatchObject({
        name: 'filesystem',
        writeAccess: false,
      });
      expect(readFilesystemPaths(result.config.proxy[0])).toEqual([
        path.join(os.homedir(), 'Documents'),
        '/tmp/demo',
      ]);

      const raw = await fs.readFile(result.configPath, 'utf-8');
      expect(raw).toContain('@modelcontextprotocol/server-filesystem');
    } finally {
      await result.cleanup();
    }
  });

  it('deduplicates paths after home expansion and resolution', async () => {
    const result = await createTemporaryFilesystemConfig({
      paths: ['~/Documents', path.join(os.homedir(), 'Documents')],
    });

    try {
      expect(readFilesystemPaths(result.config.proxy[0])).toEqual([
        path.join(os.homedir(), 'Documents'),
      ]);
    } finally {
      await result.cleanup();
    }
  });

  it('removes the temporary config directory on cleanup', async () => {
    const result = await createTemporaryFilesystemConfig({
      paths: ['/tmp/demo'],
    });

    const tempDir = path.dirname(result.configPath);
    await result.cleanup();
    await expect(fs.access(tempDir)).rejects.toThrow();
  });
});
