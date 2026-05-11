import { describe, expect, it, vi, beforeEach } from 'vitest';
import { 
  InteractiveAuditLogger, 
  formatAuditEntry, 
  formatHttpRequestEntry,
  isPromptCancelError,
  printAdvancedHelp,
  printInteractiveHelp,
  shouldShutdownOnSigint,
} from '../src/cli/interactive.js';
import { AuditLogger } from '../src/utils/audit.js';

describe('InteractiveAuditLogger', () => {
  let inner: AuditLogger;
  let logger: InteractiveAuditLogger;
  let output: string[] = [];

  beforeEach(() => {
    output = [];
    inner = { record: vi.fn() };
    logger = new InteractiveAuditLogger(inner);
    logger.setWriter((msg) => output.push(msg));
  });

  it('forwards records to inner logger', () => {
    const entry = { ts: new Date().toISOString(), connectorId: 'test', tool: 'test', argKeys: [], durationMs: 10, isError: false };
    logger.record(entry);
    expect(inner.record).toHaveBeenCalledWith(entry);
  });

  it('writes to output when live logs are enabled', () => {
    const entry = { ts: new Date().toISOString(), connectorId: 'test', tool: 'test', argKeys: [], durationMs: 10, isError: false };
    logger.record(entry);
    expect(output.length).toBe(1);
    expect(output[0]).toContain('test test');
  });

  it('suppresses output when live logs are disabled', () => {
    logger.setLiveLogs(false);
    const entry = { ts: new Date().toISOString(), connectorId: 'test', tool: 'test', argKeys: [], durationMs: 10, isError: false };
    logger.record(entry);
    expect(output.length).toBe(0);
  });

  it('records HTTP entries only to writer', () => {
    const entry = { ts: new Date().toISOString(), kind: 'test', method: 'GET', path: '/test', status: 200 };
    logger.recordHttp(entry);
    expect(output.length).toBe(1);
    expect(output[0]).toContain('GET /test');
  });
});

describe('Formatting helpers', () => {
  it('formatAuditEntry returns expected shape', () => {
    const entry = { 
      ts: '2025-01-01T12:00:00Z', 
      connectorId: 'notes',
      tool: 'read_note', 
      argKeys: ['path'], 
      durationMs: 123, 
      isError: false 
    };
    const formatted = formatAuditEntry(entry);
    expect(formatted).toContain('OK');
    expect(formatted).toContain('notes read_note');
    expect(formatted).toContain('args=path');
    expect(formatted).toContain('123ms');
  });

  it('formatHttpRequestEntry returns expected shape', () => {
    const entry = {
      ts: '2025-01-01T12:00:00Z',
      kind: 'mcp.request',
      method: 'POST',
      path: '/mcp',
      status: 200,
      clientId: 'test-client',
      detail: 'test-detail'
    };
    const formatted = formatHttpRequestEntry(entry);
    expect(formatted).toContain('200');
    expect(formatted).toContain('mcp.request POST /mcp');
    expect(formatted).toContain('client=test-client');
    expect(formatted).toContain('test-detail');
  });
});

describe('Interactive prompt control helpers', () => {
  it('requires a second Ctrl-C within the exit window', () => {
    expect(shouldShutdownOnSigint(0, 1000)).toBe(false);
    expect(shouldShutdownOnSigint(1000, 2500)).toBe(true);
    expect(shouldShutdownOnSigint(1000, 4001)).toBe(false);
  });

  it('detects Inquirer prompt cancellation errors', () => {
    const err = new Error('User force closed the prompt with SIGINT');
    err.name = 'ExitPromptError';

    expect(isPromptCancelError(err)).toBe(true);
    expect(isPromptCancelError(new Error('regular failure'))).toBe(false);
  });
});

describe('Interactive help', () => {
  it('presents leases as the primary surface', () => {
    const lines = captureConsole(() => printInteractiveHelp());

    expect(lines).toContain('  lease               list folder leases');
    expect(lines).toContain('  lease create        create a folder lease');
    expect(lines).toContain('  lease revoke        revoke a folder lease');
    expect(lines).toContain('  advanced            show mount/token/MCP commands');
    expect(lines).not.toContain('  token               list scoped API tokens');
    expect(lines).not.toContain('  mounts      list configured mounts');
    expect(lines).not.toContain('  share               list browser download links');
  });

  it('keeps implementation-level commands under advanced help', () => {
    const lines = captureConsole(() => printAdvancedHelp());

    expect(lines).toContain('  advanced mounts              list internal mounts');
    expect(lines).toContain('  advanced token               list scoped API tokens');
    expect(lines).toContain('  advanced share               list legacy file share links');
    expect(lines).toContain('  advanced connectors          list loaded MCP connectors');
  });
});

function captureConsole(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((line = '') => {
    lines.push(String(line));
  });
  try {
    fn();
    return lines.join('\n');
  } finally {
    spy.mockRestore();
  }
}
