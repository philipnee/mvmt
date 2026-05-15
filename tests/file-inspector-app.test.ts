import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { inspectMountedPath } from '../src/apps/file-inspector/index.js';

describe('file-inspector app stub', () => {
  it('inspects mounted filesystem paths through the mount registry', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-file-inspector-'));
    try {
      await fs.writeFile(path.join(tmp, 'note.txt'), 'hello', 'utf-8');

      await expect(inspectMountedPath([
        {
          name: 'docs',
          type: 'local_folder',
          root: tmp,
          path: '/docs',
          enabled: true,
          writeAccess: true,
          exclude: [],
          protect: [],
        },
      ], '/docs/note.txt')).resolves.toMatchObject({
        appId: 'file-inspector',
        mount: 'docs',
        path: '/docs/note.txt',
        type: 'file',
        size: 5,
        writeAccess: true,
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('honors mount exclude rules', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-file-inspector-'));
    try {
      await fs.writeFile(path.join(tmp, 'secret.txt'), 'hidden', 'utf-8');

      await expect(inspectMountedPath([
        {
          name: 'docs',
          type: 'local_folder',
          root: tmp,
          path: '/docs',
          enabled: true,
          writeAccess: false,
          exclude: ['secret.txt'],
          protect: [],
        },
      ], '/docs/secret.txt')).rejects.toThrow('/docs/secret.txt is excluded');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

