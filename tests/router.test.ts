import { describe, expect, it, vi } from 'vitest';
import { Connector } from '../src/connectors/types.js';
import { ToolRouter } from '../src/server/router.js';

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
});
