import { describe, expect, it } from 'vitest';
import {
  addSourceToConfig,
  editSourceInConfig,
  removeSourceFromConfig,
} from '../src/cli/sources.js';
import { parseConfig } from '../src/config/loader.js';

describe('source config helpers', () => {
  it('adds folder sources with default protection', () => {
    const config = parseConfig({ version: 1 });
    const next = addSourceToConfig(config, {
      id: 'workspace',
      path: '~/code/mvmt',
      writeAccess: true,
    });

    expect(next.sources).toEqual([
      expect.objectContaining({
        id: 'workspace',
        type: 'folder',
        path: expect.stringContaining('/code/mvmt'),
        exclude: ['.git/**', 'node_modules/**', '.claude/**'],
        protect: ['.env', '.env.*', '.claude/**'],
        writeAccess: true,
        enabled: true,
      }),
    ]);
  });

  it('edits source path, write access, patterns, and enabled state', () => {
    const config = addSourceToConfig(parseConfig({ version: 1 }), {
      id: 'workspace',
      path: '/old',
      writeAccess: false,
    });

    const next = editSourceInConfig(config, 'workspace', {
      path: '/new',
      writeAccess: true,
      exclude: ['dist/**'],
      protect: ['secrets/**'],
      enabled: false,
    });

    expect(next.sources[0]).toMatchObject({
      id: 'workspace',
      path: '/new',
      writeAccess: true,
      exclude: ['dist/**'],
      protect: ['secrets/**'],
      enabled: false,
    });
  });

  it('removes unreferenced sources', () => {
    const config = addSourceToConfig(parseConfig({ version: 1 }), {
      id: 'workspace',
      path: '/workspace',
      writeAccess: false,
    });

    expect(removeSourceFromConfig(config, 'workspace').sources).toEqual([]);
  });

  it('rejects duplicate source ids and referenced removals', () => {
    const config = addSourceToConfig(parseConfig({ version: 1 }), {
      id: 'workspace',
      path: '/workspace',
      writeAccess: false,
    });

    expect(() => addSourceToConfig(config, {
      id: 'workspace',
      path: '/other',
      writeAccess: false,
    })).toThrow('Source already exists');

    const referenced = parseConfig({
      version: 1,
      sources: [{ id: 'workspace', type: 'folder', path: '/workspace' }],
      clients: [
        {
          id: 'codex',
          name: 'Codex',
          auth: { type: 'token', tokenHash: 'a'.repeat(64) },
          permissions: [{ sourceId: 'workspace', actions: ['read'] }],
        },
      ],
    });

    expect(() => removeSourceFromConfig(referenced, 'workspace')).toThrow('referenced by client codex');
  });
});
