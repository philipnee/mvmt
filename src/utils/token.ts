import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const TOKEN_PATH = path.join(os.homedir(), '.mvmt', '.session-token');

export function generateSessionToken(): string {
  const token = crypto.randomBytes(32).toString('base64url');

  writeSessionToken(token);
  return token;
}

export function readSessionToken(): string | undefined {
  try {
    const token = fs.readFileSync(TOKEN_PATH, 'utf-8').trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export function validateSessionToken(authHeader: string | undefined): boolean {
  const expectedToken = readSessionToken();
  if (!expectedToken) return false;
  return validateToken(authHeader, expectedToken);
}

function writeSessionToken(token: string): void {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
  if (process.platform !== 'win32') {
    fs.chmodSync(TOKEN_PATH, 0o600);
  }
}

export function validateToken(authHeader: string | undefined, expectedToken: string): boolean {
  if (!authHeader) return false;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return false;

  const provided = Buffer.from(parts[1]);
  const expected = Buffer.from(expectedToken);
  if (provided.length !== expected.length) return false;

  return crypto.timingSafeEqual(provided, expected);
}
