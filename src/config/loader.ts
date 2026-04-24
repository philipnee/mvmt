import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import yaml from 'yaml';
import { ConfigSchema, MvmtConfig } from './schema.js';

export async function saveConfig(configPath: string, config: MvmtConfig): Promise<void> {
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  // mode on writeFile guards the create path; chmod guards overwrite,
  // where writeFile's mode is ignored because the file already exists.
  await fsp.writeFile(configPath, yaml.stringify(config), { encoding: 'utf-8', mode: 0o600 });
  if (process.platform !== 'win32') {
    await fsp.chmod(configPath, 0o600);
  }
}

export function getConfigPath(): string {
  return path.join(os.homedir(), '.mvmt', 'config.yaml');
}

export function parseConfig(rawConfig: unknown): MvmtConfig {
  const result = ConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid config:\n${details}`);
  }
  return result.data;
}

export function resolveConfigPath(overridePath?: string): string {
  return overridePath ? expandHome(overridePath) : getConfigPath();
}

export function configExists(overridePath?: string): boolean {
  return fs.existsSync(resolveConfigPath(overridePath));
}

export function readConfig(configPath: string): MvmtConfig {
  const raw = fs.readFileSync(configPath, 'utf-8');
  return parseConfig(yaml.parse(raw));
}

export function loadConfig(overridePath?: string): MvmtConfig {
  const configPath = resolveConfigPath(overridePath);

  if (!fs.existsSync(configPath)) {
    console.error(`Config not found at ${configPath}`);
    console.error('Run `mvmt config setup` to create a config, or `mvmt serve` to set up and start mvmt.');
    process.exit(1);
  }

  try {
    return readConfig(configPath);
  } catch (err) {
    if (err instanceof Error) {
      console.error(err.message);
    } else {
      console.error('Invalid config.');
    }
    process.exit(1);
  }
}

export function expandHome(inputPath: string): string {
  if (inputPath === '~') return os.homedir();
  if (inputPath.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}
