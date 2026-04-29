import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { Connector } from '../src/connectors/types.js';
import { parseConfig } from '../src/config/loader.js';
import { TextContextIndex } from '../src/context/text-index.js';
import { ToolRouter } from '../src/server/router.js';
import { ClientIdentity } from '../src/server/client-identity.js';

describe('ToolRouter', () => {
  it('namespaces tools and routes calls to the owning connector', async () => {
    const callTool = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, args }) }],
    }));
    const connector: Connector = {
      id: 'proxy_github',
      displayName: 'github',
      initialize: vi.fn(),
      shutdown: vi.fn(),
      listTools: vi.fn(async () => [
        {
          name: 'create_issue',
          description: 'Create an issue',
          inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
        },
      ]),
      callTool,
    };

    const router = new ToolRouter([connector]);
    await router.initialize();

    expect(router.getAllTools()).toEqual([
      {
        namespacedName: 'proxy_github__create_issue',
        originalName: 'create_issue',
        connectorId: 'proxy_github',
        sourceId: 'proxy_github',
        requiredAction: 'write',
        toolKind: 'raw',
        description: '[github] Create an issue',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
      },
    ]);

    await expect(router.callTool('proxy_github__create_issue', { title: 'Bug' })).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, args: { title: 'Bug' } }) }],
    });
    expect(callTool).toHaveBeenCalledWith('create_issue', { title: 'Bug' });
  });

  it('rejects duplicate namespaced tool names', async () => {
    const connector: Connector = {
      id: 'dup',
      displayName: 'dup',
      initialize: vi.fn(),
      shutdown: vi.fn(),
      listTools: vi.fn(async () => [
        { name: 'same', description: '', inputSchema: { type: 'object', properties: {} } },
        { name: 'same', description: '', inputSchema: { type: 'object', properties: {} } },
      ]),
      callTool: vi.fn(),
    };

    const router = new ToolRouter([connector]);
    await expect(router.initialize()).rejects.toThrow('Duplicate tool name');
  });

  it('throws for unknown tools', async () => {
    const router = new ToolRouter([]);
    await router.initialize();

    await expect(router.callTool('missing', {})).rejects.toThrow('Unknown tool: missing');
  });

  it('applies result plugins before returning connector output', async () => {
    const connector: Connector = {
      id: 'obsidian',
      displayName: 'obsidian',
      initialize: vi.fn(),
      shutdown: vi.fn(),
      listTools: vi.fn(async () => [
        { name: 'read_note', description: '', inputSchema: { type: 'object', properties: {} } },
      ]),
      callTool: vi.fn(async () => ({
        content: [{ type: 'text' as const, text: 'email philip@example.com' }],
      })),
    };

    const router = new ToolRouter(
      [connector],
      undefined,
      [
        {
          id: 'test-plugin',
          displayName: 'test plugin',
          process: vi.fn((context) => ({
            result: {
              ...context.result,
              content: [{ type: 'text' as const, text: 'scrubbed' }],
            },
          })),
        },
      ],
    );
    await router.initialize();

    await expect(router.callTool('obsidian__read_note', {})).resolves.toEqual({
      content: [{ type: 'text', text: 'scrubbed' }],
    });
  });

  it('records plugin redaction counts in the audit log', async () => {
    const audit = { record: vi.fn() };
    const connector: Connector = {
      id: 'obsidian',
      displayName: 'obsidian',
      initialize: vi.fn(),
      shutdown: vi.fn(),
      listTools: vi.fn(async () => [
        { name: 'read_note', description: '', inputSchema: { type: 'object', properties: {} } },
      ]),
      callTool: vi.fn(async () => ({
        content: [{ type: 'text' as const, text: 'sk-abcdefghijklmnopqrstuvwxyz123456' }],
      })),
    };

    const router = new ToolRouter(
      [connector],
      audit,
      [
        {
          id: 'pattern-redactor',
          displayName: 'pattern redactor',
          process: vi.fn((context) => ({
            result: context.result,
            auditEvents: [
              {
                pluginId: 'pattern-redactor',
                mode: 'redact',
                matches: [{ pattern: 'openai-keys', count: 1 }],
              },
            ],
          })),
        },
      ],
    );
    await router.initialize();

    await router.callTool('obsidian__read_note', {});

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        redactions: [
          {
            pluginId: 'pattern-redactor',
            mode: 'redact',
            pattern: 'openai-keys',
            count: 1,
          },
        ],
      }),
    );
  });

  it('filters raw tools by client source/action permissions', async () => {
    const connector: Connector = {
      id: 'proxy_filesystem',
      displayName: 'filesystem',
      initialize: vi.fn(),
      shutdown: vi.fn(),
      listTools: vi.fn(async () => [
        { name: 'search_files', description: 'Search files', inputSchema: { type: 'object', properties: {} } },
        { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: {} } },
        { name: 'write_file', description: 'Write a file', inputSchema: { type: 'object', properties: {} } },
      ]),
      callTool: vi.fn(),
    };

    const router = new ToolRouter([{ connector, sourceId: 'workspace' }]);
    await router.initialize();

    expect(router.getAllTools(client('codex', true, [{ sourceId: 'workspace', actions: ['search'] }]))).toEqual([
      expect.objectContaining({ namespacedName: 'proxy_filesystem__search_files', requiredAction: 'search' }),
    ]);
  });

  it('denies raw tools when rawToolsEnabled is false', async () => {
    const audit = { record: vi.fn() };
    const callTool = vi.fn();
    const connector: Connector = {
      id: 'obsidian',
      displayName: 'obsidian',
      initialize: vi.fn(),
      shutdown: vi.fn(),
      listTools: vi.fn(async () => [
        { name: 'read_note', description: 'Read a note', inputSchema: { type: 'object', properties: {} } },
      ]),
      callTool,
    };

    const router = new ToolRouter([connector], audit);
    await router.initialize();

    expect(router.getAllTools(client('chatgpt', false, [{ sourceId: 'obsidian', actions: ['read'] }]))).toEqual([]);
    await expect(
      router.callTool('obsidian__read_note', { notePath: 'Project' }, client('chatgpt', false, [
        { sourceId: 'obsidian', actions: ['read'] },
      ])),
    ).resolves.toMatchObject({ isError: true });
    expect(callTool).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'chatgpt',
        deniedReason: 'raw_tools_disabled',
        isError: true,
      }),
    );
  });

  it('denies raw tool calls without the required source/action permission', async () => {
    const audit = { record: vi.fn() };
    const callTool = vi.fn();
    const connector: Connector = {
      id: 'proxy_filesystem',
      displayName: 'filesystem',
      initialize: vi.fn(),
      shutdown: vi.fn(),
      listTools: vi.fn(async () => [
        { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: {} } },
      ]),
      callTool,
    };

    const router = new ToolRouter([{ connector, sourceId: 'workspace' }], audit);
    await router.initialize();

    await expect(
      router.callTool('proxy_filesystem__read_file', { path: '/tmp/a' }, client('codex', true, [
        { sourceId: 'workspace', actions: ['search'] },
      ])),
    ).resolves.toMatchObject({ isError: true });
    expect(callTool).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'codex',
        deniedReason: 'missing_permission source=workspace action=read',
        isError: true,
      }),
    );
  });

  it('records clientId for authorized raw tool calls', async () => {
    const audit = { record: vi.fn() };
    const connector: Connector = {
      id: 'obsidian',
      displayName: 'obsidian',
      initialize: vi.fn(),
      shutdown: vi.fn(),
      listTools: vi.fn(async () => [
        { name: 'read_note', description: 'Read a note', inputSchema: { type: 'object', properties: {} } },
      ]),
      callTool: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
    };

    const router = new ToolRouter([connector], audit);
    await router.initialize();

    await router.callTool('obsidian__read_note', {}, client('codex', true, [
      { sourceId: 'obsidian', actions: ['read'] },
    ]));

    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'codex', isError: false }));
  });

  it('lists semantic tools even when raw tools are disabled', async () => {
    const connector = obsidianFixtureConnector();
    const router = new ToolRouter([connector], undefined, [], {
      semanticTools: {
        searchPersonalContext: { enabled: true, sourceIds: ['obsidian'] },
        readContextItem: { enabled: true, sourceIds: ['obsidian'] },
      },
    });
    await router.initialize();

    expect(router.getAllTools(client('chatgpt', false, [
      { sourceId: 'obsidian', actions: ['search', 'read'] },
    ])).map((tool) => tool.namespacedName)).toEqual([
      'search_personal_context',
      'read_context_item',
    ]);
  });

  it('searches allowed semantic sources and returns source-attributed results', async () => {
    const connector = obsidianFixtureConnector();
    const router = new ToolRouter([connector], undefined, [], {
      semanticTools: {
        searchPersonalContext: { enabled: true, sourceIds: ['obsidian'] },
      },
    });
    await router.initialize();

    const result = await router.callTool('search_personal_context', { query: 'launch' }, client('chatgpt', false, [
      { sourceId: 'obsidian', actions: ['search'] },
    ]));
    const parsed = JSON.parse(result.content[0].type === 'text' ? result.content[0].text : '{}');

    expect(parsed).toMatchObject({
      query: 'launch',
      ranking: 'per_source_keyword_union',
      results: [
        {
          item_id: 'projects/launch.md',
          source_id: 'obsidian',
          source_type: 'obsidian',
          actions: ['read_context_item'],
        },
      ],
    });
  });

  it('reads allowed semantic context items without enabling raw tools', async () => {
    const connector = obsidianFixtureConnector();
    const router = new ToolRouter([connector], undefined, [], {
      semanticTools: {
        readContextItem: { enabled: true, sourceIds: ['obsidian'] },
      },
    });
    await router.initialize();

    const result = await router.callTool(
      'read_context_item',
      { source_id: 'obsidian', item_id: 'projects/launch.md' },
      client('chatgpt', false, [{ sourceId: 'obsidian', actions: ['read'] }]),
    );
    const parsed = JSON.parse(result.content[0].type === 'text' ? result.content[0].text : '{}');

    expect(parsed).toMatchObject({
      source_id: 'obsidian',
      item_id: 'projects/launch.md',
      mime_type: 'text/markdown',
      content: '# Launch\nShip it.',
    });
  });

  it('exposes prototype text index tools by source/action permission', async () => {
    const { index, tmp } = await createTextIndexFixture();
    try {
      const router = new ToolRouter([], undefined, [], { contextIndex: index });
      await router.initialize();

      const tools = router.getAllTools(client('codex', false, [
        { sourceId: 'workspace', actions: ['search', 'read'] },
      ]));

      expect(tools.map((tool) => tool.namespacedName)).toEqual(['search', 'list', 'read']);
      const result = await router.callTool('search', { query: 'alpha' }, client('codex', false, [
        { sourceId: 'workspace', actions: ['search', 'read'] },
      ]));
      const parsed = JSON.parse(result.content[0].type === 'text' ? result.content[0].text : '{}');
      expect(parsed.results[0]).toMatchObject({ mount: 'workspace', path: '/workspace/note.md' });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('denies prototype text index writes without write permission', async () => {
    const { index, tmp } = await createTextIndexFixture();
    const audit = { record: vi.fn() };
    try {
      const router = new ToolRouter([], audit, [], { contextIndex: index });
      await router.initialize();

      const result = await router.callTool('write', { path: '/workspace/new.md', content: 'new' }, client('chatgpt', false, [
        { sourceId: 'workspace', actions: ['search', 'read'] },
      ]));

      expect(result).toMatchObject({ isError: true });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: 'chatgpt',
          deniedReason: 'missing_permission mount=workspace action=write',
          isError: true,
        }),
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

function client(
  id: string,
  rawToolsEnabled: boolean,
  permissions: ClientIdentity['permissions'],
): ClientIdentity {
  return {
    id,
    name: id,
    source: 'token',
    rawToolsEnabled,
    permissions,
  };
}

function obsidianFixtureConnector(): Connector {
  return {
    id: 'obsidian',
    displayName: 'obsidian',
    initialize: vi.fn(),
    shutdown: vi.fn(),
    listTools: vi.fn(async () => [
      { name: 'search_notes', description: 'Search notes', inputSchema: { type: 'object', properties: {} } },
      { name: 'read_note', description: 'Read a note', inputSchema: { type: 'object', properties: {} } },
    ]),
    callTool: vi.fn(async (name: string) => {
      if (name === 'search_notes') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                results: [{ path: 'projects/launch.md', snippet: 'launch plan' }],
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ path: 'projects/launch.md', content: '# Launch\nShip it.' }),
          },
        ],
      };
    }),
  };
}

async function createTextIndexFixture(): Promise<{ index: TextContextIndex; tmp: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-router-index-'));
  const sourceRoot = path.join(tmp, 'source');
  await fs.mkdir(sourceRoot);
  await fs.writeFile(path.join(sourceRoot, 'note.md'), 'alpha note', 'utf-8');
  const config = parseConfig({
    version: 1,
    mounts: [{ name: 'workspace', type: 'local_folder', path: '/workspace', root: sourceRoot, writeAccess: true }],
  });
  const index = new TextContextIndex({
    mounts: config.mounts,
    indexPath: path.join(tmp, 'index.json'),
  });
  await index.rebuild();
  return { index, tmp };
}
