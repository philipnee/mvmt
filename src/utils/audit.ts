import fs from 'fs';
import os from 'os';
import path from 'path';

export const AUDIT_LOG_PATH = path.join(os.homedir(), '.mvmt', 'audit.log');

export interface AuditEntry {
  ts: string;
  connectorId: string;
  tool: string;
  clientId?: string;
  argKeys: string[];
  argPreview: string;
  redactions?: Array<{
    pluginId: string;
    mode: 'warn' | 'redact' | 'block';
    pattern: string;
    count: number;
    truncated?: boolean;
  }>;
  isError: boolean;
  deniedReason?: string;
  durationMs: number;
}

export interface AuditLogger {
  record(entry: AuditEntry): void;
}

export function createAuditLogger(logPath: string = AUDIT_LOG_PATH): AuditLogger {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, '', { mode: 0o600 });
  }
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(logPath, 0o600);
    } catch {
      // Best-effort permission hardening.
    }
  }

  return {
    record(entry: AuditEntry): void {
      try {
        fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
      } catch {
        // Never let audit logging break a tool call.
      }
    },
  };
}

export function summarizeArgs(args: Record<string, unknown>): { argKeys: string[]; argPreview: string } {
  const argKeys = Object.keys(args);
  let preview: string;
  try {
    preview = JSON.stringify(args);
  } catch {
    preview = '[unserializable]';
  }
  if (preview.length > 512) preview = `${preview.slice(0, 509)}...`;
  return { argKeys, argPreview: preview };
}
