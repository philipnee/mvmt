import { describe, expect, it } from 'vitest';
import { PatternRedactorPlugin } from '../src/plugins/pattern-redactor.js';
import { CallToolResult } from '../src/connectors/types.js';

const context = {
  connectorId: 'obsidian',
  toolName: 'obsidian__read_note',
  originalName: 'read_note',
  args: {},
};

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function combinedText(result: CallToolResult): string {
  return result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

describe('PatternRedactorPlugin', () => {
  it('redacts the curated default API key and token patterns', async () => {
    const plugin = new PatternRedactorPlugin({
      name: 'pattern-redactor',
      enabled: true,
      mode: 'redact',
      maxBytes: 1024 * 1024,
    });
    const original = [
      'OpenAI sk-abcdefghijklmnopqrstuvwxyz123456',
      'Anthropic sk-ant-abcdefghijklmnopqrstuvwxyz123456',
      'AWS AKIAIOSFODNN7EXAMPLE',
      'GitHub classic ghp_abcdefghijklmnopqrstuvwxyz1234567890ABCD',
      'GitHub fine-grained github_pat_abcdefghijklmnopqrstuvwxyz1234567890ABCD',
      'Slack xoxb-123456789012-abcdefghijklmnop',
      'JWT eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghijklmnop.abcdefghijklmnop',
    ].join('\n');

    const output = await plugin.process({ ...context, result: textResult(original) });
    const text = combinedText(output.result);

    expect(text).toContain('[REDACTED:OPENAI_KEY]');
    expect(text).toContain('[REDACTED:ANTHROPIC_KEY]');
    expect(text).toContain('[REDACTED:AWS_ACCESS_KEY]');
    expect(text).toContain('[REDACTED:GITHUB_TOKEN]');
    expect(text).toContain('[REDACTED:SLACK_TOKEN]');
    expect(text).toContain('[REDACTED:JWT]');
    expect(text).toContain('mvmt pattern-redactor: redacted');
    expect(output.auditEvents).toEqual([
      {
        pluginId: 'pattern-redactor',
        mode: 'redact',
        truncated: false,
        matches: [
          { pattern: 'anthropic-keys', count: 1 },
          { pattern: 'aws-access-keys', count: 1 },
          { pattern: 'github-tokens', count: 2 },
          { pattern: 'jwt-looking-strings', count: 1 },
          { pattern: 'openai-keys', count: 1 },
          { pattern: 'slack-tokens', count: 1 },
        ],
      },
    ]);
  });

  it('supports user-defined regex patterns', async () => {
    const plugin = new PatternRedactorPlugin({
      name: 'pattern-redactor',
      enabled: true,
      mode: 'redact',
      maxBytes: 1024 * 1024,
      patterns: [
        {
          name: 'emails',
          regex: '\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b',
          flags: 'gi',
          replacement: '[REDACTED:EMAIL]',
          enabled: true,
        },
      ],
    });

    const output = await plugin.process({
      ...context,
      result: textResult('contact philip@example.com'),
    });

    expect(combinedText(output.result)).toContain('contact [REDACTED:EMAIL]');
    expect(output.auditEvents?.[0].matches).toEqual([{ pattern: 'emails', count: 1 }]);
  });

  it('warns without changing the original content', async () => {
    const plugin = new PatternRedactorPlugin({
      name: 'pattern-redactor',
      enabled: true,
      mode: 'warn',
      maxBytes: 1024 * 1024,
      patterns: [
        {
          name: 'emails',
          regex: '\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b',
          flags: 'gi',
          replacement: '[REDACTED:EMAIL]',
          enabled: true,
        },
      ],
    });

    const output = await plugin.process({
      ...context,
      result: textResult('contact philip@example.com'),
    });

    const text = combinedText(output.result);
    expect(text).toContain('contact philip@example.com');
    expect(text).toContain('matched but output was not changed');
    expect(output.auditEvents?.[0]).toMatchObject({ mode: 'warn' });
  });

  it('blocks the whole result without returning the matched value', async () => {
    const plugin = new PatternRedactorPlugin({
      name: 'pattern-redactor',
      enabled: true,
      mode: 'block',
      maxBytes: 1024 * 1024,
      patterns: [
        {
          name: 'emails',
          regex: '\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b',
          flags: 'gi',
          replacement: '[REDACTED:EMAIL]',
          enabled: true,
        },
      ],
    });

    const output = await plugin.process({
      ...context,
      result: textResult('contact philip@example.com'),
    });

    expect(output.result.isError).toBe(true);
    const text = combinedText(output.result);
    expect(text).toContain('Blocked by mvmt pattern-redactor');
    expect(text).not.toContain('philip@example.com');
    expect(output.auditEvents?.[0]).toMatchObject({ mode: 'block' });
  });

  it('ignores disabled patterns', async () => {
    const plugin = new PatternRedactorPlugin({
      name: 'pattern-redactor',
      enabled: true,
      mode: 'redact',
      maxBytes: 1024 * 1024,
      patterns: [
        {
          name: 'emails',
          regex: '\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b',
          flags: 'gi',
          replacement: '[REDACTED:EMAIL]',
          enabled: false,
        },
      ],
    });

    const output = await plugin.process({
      ...context,
      result: textResult('email philip@example.com'),
    });

    expect(combinedText(output.result)).toContain('philip@example.com');
    expect(output.auditEvents).toEqual([]);
  });

  it('leaves image content untouched', async () => {
    const plugin = new PatternRedactorPlugin({
      name: 'pattern-redactor',
      enabled: true,
      mode: 'redact',
      maxBytes: 1024 * 1024,
      patterns: [
        {
          name: 'emails',
          regex: '\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b',
          flags: 'gi',
          replacement: '[REDACTED:EMAIL]',
          enabled: true,
        },
      ],
    });

    const output = await plugin.process({
      ...context,
      result: {
        content: [
          { type: 'image', data: 'philip@example.com', mimeType: 'image/png' },
          { type: 'text', text: 'philip@example.com' },
        ],
      },
    });

    expect(output.result.content[0]).toEqual({
      type: 'image',
      data: 'philip@example.com',
      mimeType: 'image/png',
    });
    expect(combinedText(output.result)).toContain('[REDACTED:EMAIL]');
  });

  it('caps scanning by maxBytes and reports partial scans', async () => {
    const plugin = new PatternRedactorPlugin({
      name: 'pattern-redactor',
      enabled: true,
      mode: 'redact',
      maxBytes: 1024,
      patterns: [
        {
          name: 'emails',
          regex: '\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b',
          flags: 'gi',
          replacement: '[REDACTED:EMAIL]',
          enabled: true,
        },
      ],
    });

    const output = await plugin.process({
      ...context,
      result: textResult(`${'a'.repeat(1024)} philip@example.com`),
    });

    const text = combinedText(output.result);
    expect(text).toContain('philip@example.com');
    expect(text).toContain('only the first 1024 bytes');
  });
});

