import { password as passwordPrompt } from '@inquirer/prompts';
import chalk from 'chalk';
import {
  createPrivilegedUser,
  defaultPrivilegedUsersPath,
  listPrivilegedUsers,
  setPrivilegedUserAdmin,
} from '../dashboard/users.js';

export interface PrivilegedUserCommandOptions {
  json?: boolean;
  usersPath?: string;
}

export interface CreatePrivilegedUserOptions extends PrivilegedUserCommandOptions {
  password?: string;
  admin?: boolean;
}

export async function listPrivilegedUsersCommand(options: PrivilegedUserCommandOptions = {}): Promise<void> {
  const users = listPrivilegedUsers(resolveUsersPath(options)).map((user) => ({
    id: user.id,
    username: user.username,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    disabled: user.disabled ?? false,
    admin: Boolean(user.admin),
  }));

  if (options.json) {
    console.log(JSON.stringify({ users }, null, 2));
    return;
  }

  console.log(chalk.bold('Privileged users'));
  if (users.length === 0) {
    console.log(`  ${chalk.dim('none')}`);
    return;
  }
  for (const user of users) {
    const state = user.disabled ? chalk.yellow('disabled') : chalk.green('active');
    const role = user.admin ? chalk.yellow('admin') : chalk.dim('member');
    console.log(`  ${user.username.padEnd(24)} ${state}  ${role}  created ${user.createdAt}`);
  }
}

export async function addPrivilegedUserCommand(
  username: string | undefined,
  options: CreatePrivilegedUserOptions = {},
): Promise<void> {
  if (!username) throw new Error('Username is required. Example: mvmt users add sarah');
  const password = options.password ?? await passwordPrompt({
    message: `Password for ${username}`,
    mask: '*',
    validate: (value) => value.length >= 8 || 'Password must be at least 8 characters.',
  });
  const user = createPrivilegedUser(resolveUsersPath(options), { username, password, admin: options.admin });

  if (options.json) {
    console.log(JSON.stringify({ user: { id: user.id, username: user.username, createdAt: user.createdAt, admin: Boolean(user.admin) } }, null, 2));
    return;
  }

  console.log(chalk.green(user.admin ? 'Admin user created' : 'Privileged user created'));
  console.log(`  Username: ${user.username}`);
  if (user.admin) console.log(chalk.yellow('  Role: admin (can manage sources from dashboard)'));
}

export async function setPrivilegedUserAdminCommand(
  username: string | undefined,
  admin: boolean,
  options: PrivilegedUserCommandOptions = {},
): Promise<void> {
  if (!username) throw new Error(`Username is required. Example: mvmt users ${admin ? 'grant' : 'revoke'} sarah`);
  const user = setPrivilegedUserAdmin(resolveUsersPath(options), username, admin);
  if (options.json) {
    console.log(JSON.stringify({ user: { id: user.id, username: user.username, admin: Boolean(user.admin) } }, null, 2));
    return;
  }
  console.log(chalk.green(admin ? `Granted admin to ${user.username}` : `Revoked admin from ${user.username}`));
}

function resolveUsersPath(options: PrivilegedUserCommandOptions): string {
  return options.usersPath ?? defaultPrivilegedUsersPath();
}
