import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'yaml';
import { ConfigSchema, MvmtConfig } from './schema.js';

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

export function loadConfig(overridePath?: string): MvmtConfig {
  const configPath = overridePath ? expandHome(overridePath) : getConfigPath();

  if (!fs.existsSync(configPath)) {
    console.error(`Config not found at ${configPath}`);
    console.error('Run `mvmt init` to set up mvmt.');
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return parseConfig(yaml.parse(raw));
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
