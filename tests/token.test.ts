import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateSessionToken,
  readSessionToken,
  TOKEN_PATH,
  validateSessionToken,
  validateToken,
} from '../src/utils/token.js';
import { rotateToken, showToken } from '../src/cli/token.js';

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('session token utilities', () => {
  it('generates a token, writes it to disk, and validates bearer headers', () => {
    const token = generateSessionToken();

    expect(token).toHaveLength(43);
    expect(fs.readFileSync(TOKEN_PATH, 'utf-8')).toBe(token);
    expect(readSessionToken()).toBe(token);
    expect(validateToken(`Bearer ${token}`, token)).toBe(true);
    expect(validateSessionToken(`Bearer ${token}`)).toBe(true);
    expect(validateToken(undefined, token)).toBe(false);
    expect(validateToken(`Token ${token}`, token)).toBe(false);
    expect(validateToken('Bearer wrong', token)).toBe(false);
    expect(validateSessionToken('Bearer wrong')).toBe(false);
  });
});

describe('token CLI helpers', () => {
  it('shows the current token without rotating it', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const token = generateSessionToken();

    await showToken();

    expect(output).toHaveBeenCalledWith(token);
    expect(readSessionToken()).toBe(token);
  });

  it('rotates and prints a new token', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const oldToken = generateSessionToken();

    await rotateToken();

    const newToken = readSessionToken();
    expect(newToken).toHaveLength(43);
    expect(newToken).not.toBe(oldToken);
    expect(output).toHaveBeenCalledWith(newToken);
  });
});
