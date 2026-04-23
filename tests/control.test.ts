import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ControlAuthError, startJsonControlServer, streamJsonControl } from '../src/utils/control.js';

describe('control streaming', () => {
  it('rejects stream startup on control-token auth failures instead of hanging', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvmt-control-test-'));
    const socketPath = path.join(tmp, 'control.sock');
    const server = await startJsonControlServer(
      socketPath,
      () => undefined,
      { verifyToken: () => false },
    );

    try {
      await expect(
        streamJsonControl(socketPath, { type: 'tunnel.logs.stream' }, () => undefined, 'bad-token'),
      ).rejects.toBeInstanceOf(ControlAuthError);
    } finally {
      await server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
