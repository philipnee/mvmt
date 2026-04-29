import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/loader.js';
import { TextContextIndex } from '../src/context/text-index.js';

const itUnlessWindows = process.platform === 'win32' ? it.skip : it;

describe('TextContextIndex', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-text-index-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('indexes supported text files and skips binary-looking extensions', async () => {
    await fs.writeFile(path.join(tmp, 'note.md'), 'alpha project note', 'utf-8');
    await fs.writeFile(path.join(tmp, 'todo.txt'), 'beta alpha task', 'utf-8');
    await fs.writeFile(path.join(tmp, 'photo.jpg'), 'alpha in a fake image', 'utf-8');
    await fs.mkdir(path.join(tmp, '.git'));
    await fs.writeFile(path.join(tmp, '.git', 'config'), 'alpha git metadata', 'utf-8');

    const index = createIndex(tmp);
    const stats = await index.rebuild();

    expect(stats.files).toBe(2);
    const results = await index.search('alpha', ['workspace'], 10);
    expect(results.map((result) => result.path).sort()).toEqual([
      '/workspace/note.md',
      '/workspace/todo.txt',
    ]);
    await expect(index.list('/workspace')).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: '/workspace/.git' })]),
    );
  });

  it('lists and reads virtual paths without exposing host paths', async () => {
    await fs.mkdir(path.join(tmp, 'docs'));
    await fs.writeFile(path.join(tmp, 'docs', 'guide.md'), 'setup guide', 'utf-8');

    const index = createIndex(tmp);
    await index.rebuild();

    await expect(index.list('/')).resolves.toEqual([
      expect.objectContaining({
        path: '/workspace',
        type: 'directory',
        mount: 'workspace',
        description: 'Workspace mount',
        guidance: 'Use for tests.',
        write_access: true,
      }),
    ]);
    await expect(index.list('/workspace/docs')).resolves.toEqual([
      expect.objectContaining({ path: '/workspace/docs/guide.md', type: 'file' }),
    ]);
    await expect(index.read('/workspace/docs/guide.md')).resolves.toMatchObject({
      mount: 'workspace',
      path: '/workspace/docs/guide.md',
      content: 'setup guide',
    });
    await expect(index.read('/workspace/../secret.md')).rejects.toThrow(/escapes mount root|unknown mount/);
  });

  it('enforces write access, protected paths, and expected hashes', async () => {
    await fs.mkdir(path.join(tmp, 'protected'));
    await fs.writeFile(path.join(tmp, 'draft.md'), 'old', 'utf-8');

    const index = createIndex(tmp);
    const initial = await index.read('/workspace/draft.md');

    await expect(index.write('/workspace/draft.md', 'new', 'wrong')).rejects.toThrow('hash mismatch');
    await expect(index.write('/workspace/protected/secret.md', 'secret')).rejects.toThrow('protected');

    const written = await index.write('/workspace/draft.md', 'new', initial.hash);
    expect(written.content).toBe('new');

    await expect(index.remove('/workspace/draft.md')).resolves.toMatchObject({
      mount: 'workspace',
      path: '/workspace/draft.md',
      removed: true,
    });
    await expect(index.read('/workspace/draft.md')).rejects.toThrow();
  });

  it('rejects writes to read-only mounts', async () => {
    const config = parseConfig({
      version: 1,
      mounts: [{ name: 'workspace', type: 'local_folder', path: '/workspace', root: tmp, writeAccess: false }],
    });
    const index = new TextContextIndex({
      mounts: config.mounts,
      indexPath: path.join(tmp, 'index.json'),
    });

    await expect(index.write('/workspace/new.md', 'content')).rejects.toThrow('read-only');
  });

  itUnlessWindows('does not index or read symlink escapes', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-text-index-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'secret.md'), 'outside secret', 'utf-8');
      await fs.symlink(path.join(outside, 'secret.md'), path.join(tmp, 'linked-secret.md'));
      await fs.symlink(outside, path.join(tmp, 'linked-dir'));

      const index = createIndex(tmp);
      const stats = await index.rebuild();

      expect(stats.files).toBe(0);
      await expect(index.search('secret', ['workspace'], 10)).resolves.toEqual([]);
      await expect(index.read('/workspace/linked-secret.md')).rejects.toThrow('escapes mount root');
      await expect(index.write('/workspace/linked-dir/new.md', 'new')).rejects.toThrow('escapes mount root');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('returns no search results when the snapshot has not been built yet', async () => {
    const index = createIndex(tmp);

    await expect(index.search('missing')).resolves.toEqual([]);
  });

  it('fails clearly when the snapshot is corrupt', async () => {
    await fs.writeFile(path.join(tmp, 'index.json'), '{not-json', 'utf-8');
    const index = createIndex(tmp);

    await expect(index.search('alpha')).rejects.toThrow(/failed to read text index snapshot/);
  });

  it('writes a complete snapshot without leaving temp files behind', async () => {
    await fs.writeFile(path.join(tmp, 'note.md'), 'alpha project note', 'utf-8');
    const index = createIndex(tmp);

    await index.rebuild();

    const entries = await fs.readdir(tmp);
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    const snapshot = JSON.parse(await fs.readFile(path.join(tmp, 'index.json'), 'utf-8'));
    expect(snapshot).toMatchObject({ version: 1 });
    expect(snapshot.files).toHaveLength(1);
  });
});

function createIndex(root: string): TextContextIndex {
  const config = parseConfig({
    version: 1,
    mounts: [
      {
        name: 'workspace',
        type: 'local_folder',
        path: '/workspace',
        root,
        description: 'Workspace mount',
        guidance: 'Use for tests.',
        exclude: ['.git/**', 'node_modules/**'],
        protect: ['protected/**'],
        writeAccess: true,
      },
    ],
  });
  return new TextContextIndex({
    mounts: config.mounts,
    indexPath: path.join(root, 'index.json'),
  });
}
