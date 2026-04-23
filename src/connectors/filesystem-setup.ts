import { confirm, input } from '@inquirer/prompts';
import fs from 'fs/promises';
import { MvmtConfig, ProxyConfig } from '../config/schema.js';
import type { ConnectorSetupDefinition } from './setup-registry.js';
import { resolveSetupPath } from './setup-paths.js';

export interface FilesystemConfigInput {
  paths: string[];
  writeAccess: boolean;
}

export function createFilesystemProxyConfig(filesystem: FilesystemConfigInput): ProxyConfig {
  return {
    name: 'filesystem',
    source: 'manual',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', ...filesystem.paths],
    env: {},
    writeAccess: filesystem.writeAccess,
    enabled: true,
  };
}

export async function promptForFilesystemFolders(): Promise<FilesystemConfigInput> {
  const wantFilesystem = await confirm({
    message: 'Expose specific local folders through mvmt?',
    default: false,
  });
  if (!wantFilesystem) return { paths: [], writeAccess: false };

  const folders = new Set<string>();

  while (true) {
    const folder = await input({
      message: folders.size === 0 ? 'Folder path to allow:' : 'Another folder path to allow:',
      validate: async (value) => {
        if (!value.trim()) return 'Enter a folder path';
        const resolved = resolveSetupPath(value.trim());
        try {
          const stat = await fs.stat(resolved);
          return stat.isDirectory() ? true : 'Path must be a directory';
        } catch {
          return 'Directory does not exist';
        }
      },
    });

    folders.add(resolveSetupPath(folder.trim()));

    const addAnother = await confirm({
      message: 'Allow another folder?',
      default: false,
    });
    if (!addAnother) break;
  }

  const paths = [...folders].sort((a, b) => a.localeCompare(b));
  const writeAccess = await confirm({
    message: 'Allow filesystem write tools for these folders? Read-only is recommended.',
    default: false,
  });

  return { paths, writeAccess };
}

export const filesystemSetupDefinition = {
  id: 'filesystem',
  displayName: 'Filesystem',
  isAddable: false,
  async detect(): Promise<null> {
    return null;
  },
  async prompt(): Promise<FilesystemConfigInput | undefined> {
    const filesystem = await promptForFilesystemFolders();
    return filesystem.paths.length > 0 ? filesystem : undefined;
  },
  isConfigured(config: MvmtConfig): boolean {
    return config.proxy.some((proxy) => sameProxyName(proxy.name, 'filesystem') && proxy.enabled !== false);
  },
  apply(config: MvmtConfig, input: FilesystemConfigInput): MvmtConfig {
    return upsertProxyConfig(config, createFilesystemProxyConfig(input));
  },
} satisfies ConnectorSetupDefinition<null, FilesystemConfigInput, 'filesystem'>;

function upsertProxyConfig(config: MvmtConfig, proxyConfig: ProxyConfig): MvmtConfig {
  const proxy = config.proxy.filter((entry) => !sameProxyName(entry.name, proxyConfig.name));
  proxy.push(proxyConfig);
  return { ...config, proxy };
}

function sameProxyName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
