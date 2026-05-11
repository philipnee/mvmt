import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addPrivilegedUserCommand,
  listPrivilegedUsersCommand,
} from '../src/cli/users.js';
import {
  createPrivilegedUser,
  defaultPrivilegedUsersPath,
  listPrivilegedUsers,
  recordPrivilegedUserLogin,
  verifyPrivilegedUserPassword,
} from '../src/dashboard/users.js';

describe('privileged dashboard users', () => {
  let tmp: string;
  let usersPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-privileged-users-'));
    usersPath = path.join(tmp, '.privileged-users.json');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('creates, verifies, and records privileged user logins', () => {
    const user = createPrivilegedUser(usersPath, {
      username: 'Sarah',
      password: 'correct horse battery staple',
    });

    expect(user.passwordHash).not.toBe('correct horse battery staple');
    expect(verifyPrivilegedUserPassword(usersPath, 'sarah', 'correct horse battery staple')).toMatchObject({
      id: user.id,
      username: 'Sarah',
    });
    expect(verifyPrivilegedUserPassword(usersPath, 'Sarah', 'wrong password')).toBeUndefined();

    recordPrivilegedUserLogin(usersPath, user.id);

    const stored = listPrivilegedUsers(usersPath);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.lastLoginAt).toBeTruthy();
  });

  it('rejects duplicate usernames and short passwords', () => {
    createPrivilegedUser(usersPath, { username: 'sarah', password: 'long enough' });

    expect(() => createPrivilegedUser(usersPath, {
      username: 'SARAH',
      password: 'another long password',
    })).toThrow('Privileged user already exists');
    expect(() => createPrivilegedUser(usersPath, {
      username: 'ben',
      password: 'short',
    })).toThrow('Password must be at least 8 characters');
    expect(() => createPrivilegedUser(usersPath, {
      username: '../ben',
      password: 'long enough',
    })).toThrow('Username must be 1-64 characters');
  });

  it('derives the store path beside custom session token files', () => {
    expect(defaultPrivilegedUsersPath(path.join(tmp, '.session-token'))).toBe(usersPath);
  });

  it('prints JSON from CLI helpers without prompting when password is provided', async () => {
    await addPrivilegedUserCommand('sarah', {
      usersPath,
      password: 'correct horse battery staple',
      json: true,
    });
    await listPrivilegedUsersCommand({ usersPath, json: true });

    const output = logSpy.mock.calls.map((call) => call.join(' '));
    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({
      user: { username: 'sarah' },
    });
    expect(JSON.parse(output[1] ?? '{}')).toMatchObject({
      users: [expect.objectContaining({ username: 'sarah', disabled: false })],
    });
  });

  it('prints a readable empty state for CLI listing', async () => {
    await listPrivilegedUsersCommand({ usersPath });

    expect(logSpy.mock.calls.flat().join('\n')).toContain('Privileged users');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('none');
  });

  it('prints readable CLI create and list output', async () => {
    await addPrivilegedUserCommand('ben', {
      usersPath,
      password: 'correct horse battery staple',
    });
    await listPrivilegedUsersCommand({ usersPath });

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Privileged user created');
    expect(output).toContain('Username: ben');
    expect(output).toContain('ben');
    expect(output).toContain('active');
  });

  it('requires a username in the CLI helper', async () => {
    await expect(addPrivilegedUserCommand(undefined, {
      usersPath,
      password: 'correct horse battery staple',
    })).rejects.toThrow('Username is required');
  });
});
