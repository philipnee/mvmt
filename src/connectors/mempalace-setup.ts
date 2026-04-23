import { confirm, input } from '@inquirer/prompts';
import { constants as fsConstants } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ProxyConfig } from '../config/schema.js';
import { normalizeExecutableInput, pathExists, resolveSetupPath } from './setup-paths.js';

export interface DetectedMemPalace {
  executable?: string;
  command?: string;
  palacePath?: string;
}

export interface MemPalaceConfigInput {
  command: string;
  palacePath: string;
  writeAccess: boolean;
}

export function createMemPalaceProxyConfig(memPalace: MemPalaceConfigInput): ProxyConfig {
  return {
    name: 'mempalace',
    source: 'mempalace',
    transport: 'stdio',
    command: memPalace.command,
    args: ['-m', 'mempalace.mcp_server', '--palace', memPalace.palacePath],
    env: {},
    writeAccess: memPalace.writeAccess,
    enabled: true,
  };
}

export async function detectMemPalace(): Promise<DetectedMemPalace> {
  const executable = await findExecutableOnPath('mempalace');
  const command = executable ? await readShebangCommand(executable) : undefined;
  const palacePath = await detectMemPalacePalacePath();

  return {
    ...(executable ? { executable } : {}),
    ...(command ? { command } : {}),
    ...(palacePath ? { palacePath } : {}),
  };
}

export async function findExecutableOnPath(
  executableName: string,
  pathValue = process.env.PATH || '',
): Promise<string | undefined> {
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, executableName);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Not executable or not present.
    }
  }
  return undefined;
}

export async function readShebangCommand(filePath: string): Promise<string | undefined> {
  let firstLine: string;
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    firstLine = raw.split(/\r?\n/, 1)[0];
  } catch {
    return undefined;
  }

  if (!firstLine.startsWith('#!')) return undefined;
  const parts = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
  const command = parts[0];
  if (!command || command.endsWith('/env') || command === 'env') return undefined;
  if (!path.isAbsolute(command)) return undefined;
  return (await pathExists(command)) ? command : undefined;
}

export async function promptForMemPalaceSetup(
  detected: DetectedMemPalace,
): Promise<MemPalaceConfigInput | undefined> {
  const wantMemPalace = await confirm({
    message: 'Enable the MemPalace connector?',
    default: Boolean(detected.command && detected.palacePath),
  });
  if (!wantMemPalace) return undefined;
  return promptForMemPalace(detected);
}

export async function promptForMemPalace(detected: DetectedMemPalace): Promise<MemPalaceConfigInput> {
  const commandAnswer = await input({
    message: 'MemPalace MCP Python executable:',
    default: detected.command || 'python',
    validate: async (value) => {
      const command = normalizeExecutableInput(value);
      if (!command) return 'Enter a Python executable that can import mempalace';
      if (path.isAbsolute(command) && !(await pathExists(command))) return 'Executable does not exist';
      return true;
    },
  });

  const palaceAnswer = await input({
    message: 'Path to MemPalace palace:',
    default: detected.palacePath || path.join(os.homedir(), '.mempalace', 'palace'),
    validate: async (value) => {
      if (!value.trim()) return 'Enter a palace path';
      const resolved = resolveSetupPath(value.trim());
      try {
        const stat = await fs.stat(resolved);
        return stat.isDirectory() ? true : 'Path must be a directory';
      } catch {
        return 'Directory does not exist';
      }
    },
  });

  const writeAccess = await confirm({
    message: 'Allow MemPalace write tools? This lets AI clients add, update, and delete memories. Read-only is recommended.',
    default: false,
  });

  return {
    command: normalizeExecutableInput(commandAnswer),
    palacePath: resolveSetupPath(palaceAnswer.trim()),
    writeAccess,
  };
}

async function detectMemPalacePalacePath(): Promise<string | undefined> {
  const configPath = path.join(os.homedir(), '.mempalace', 'config.json');
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as { palace_path?: unknown };
    if (typeof parsed.palace_path === 'string' && parsed.palace_path.trim()) {
      return resolveSetupPath(parsed.palace_path.trim());
    }
  } catch {
    // Config is optional.
  }

  const defaultPath = path.join(os.homedir(), '.mempalace', 'palace');
  if (await pathExists(defaultPath)) return defaultPath;
  return undefined;
}
