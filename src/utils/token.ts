import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const TOKEN_PATH = path.join(os.homedir(), '.mvmt', '.session-token');

export function generateSessionToken(tokenPath = TOKEN_PATH): string {
  const token = crypto.randomBytes(32).toString('base64url');

  writeSessionToken(token, tokenPath);
  return token;
}

export function readSessionToken(tokenPath = TOKEN_PATH): string | undefined {
  try {
    const token = fs.readFileSync(tokenPath, 'utf-8').trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export function validateSessionToken(authHeader: string | undefined, tokenPath = TOKEN_PATH): boolean {
  const expectedToken = readSessionToken(tokenPath);
  if (!expectedToken) return false;
  return validateToken(authHeader, expectedToken);
}

function writeSessionToken(token: string, tokenPath: string): void {
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  if (process.platform !== 'win32') {
    fs.chmodSync(tokenPath, 0o600);
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
