import { confirm, input } from '@inquirer/prompts';
import fs from 'fs/promises';
import path from 'path';
import { LocalFolderMountConfig, MvmtConfig } from '../config/schema.js';
import type { ConnectorSetupDefinition } from './setup-registry.js';
import { resolveSetupPath } from './setup-paths.js';

export interface FilesystemConfigInput {
  paths: string[];
  writeAccess: boolean;
}

export function createFilesystemMountConfigs(filesystem: FilesystemConfigInput): LocalFolderMountConfig[] {
  const seen = new Map<string, number>();
  return filesystem.paths.map((root) => {
    const baseName = sanitizeMountName(path.basename(root) || 'folder');
    const count = seen.get(baseName) ?? 0;
    seen.set(baseName, count + 1);
    const name = count === 0 ? baseName : `${baseName}-${count + 1}`;
    return {
      name,
      type: 'local_folder',
      path: `/${name}`,
      root,
      description: '',
      guidance: '',
      exclude: ['.git/**', 'node_modules/**', '.claude/**'],
      protect: ['.env', '.env.*', '.claude/**'],
      writeAccess: filesystem.writeAccess,
      enabled: true,
    };
  });
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
    return config.mounts.some((mount) => mount.enabled !== false);
  },
  apply(config: MvmtConfig, input: FilesystemConfigInput): MvmtConfig {
    const mounts = createFilesystemMountConfigs(input);
    const replacedNames = new Set(mounts.map((mount) => mount.name));
    const replacedPaths = new Set(mounts.map((mount) => mount.path));
    return {
      ...config,
      mounts: [
        ...config.mounts.filter((mount) => !replacedNames.has(mount.name) && !replacedPaths.has(mount.path)),
        ...mounts,
      ],
    };
  },
} satisfies ConnectorSetupDefinition<null, FilesystemConfigInput, 'filesystem'>;

function sanitizeMountName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'folder';
}
