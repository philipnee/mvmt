import fsp from 'fs/promises';
import path from 'path';
import { LocalFolderMountConfig } from '../../config/schema.js';
import { MountRegistry } from '../../context/mount-registry.js';
import { isGloballyDeniedPath, matchesConfiguredOrGlobalPattern } from '../../context/path-policy.js';

export const FILE_INSPECTOR_APP_ID = 'file-inspector';

export interface FileInspectorResult {
  appId: typeof FILE_INSPECTOR_APP_ID;
  mount: string;
  path: string;
  type: 'directory' | 'file' | 'other';
  size: number;
  mtimeMs: number;
  writeAccess: boolean;
}

export async function inspectMountedPath(
  mounts: readonly LocalFolderMountConfig[],
  inputPath: string,
): Promise<FileInspectorResult> {
  const registry = new MountRegistry([...mounts]);
  const target = registry.resolve(inputPath);
  const realPath = await fsp.realpath(target.realPath);
  const rootRealPath = await fsp.realpath(target.mount.root);
  if (!isWithin(rootRealPath, realPath)) throw new Error(`${target.virtualPath} escapes mount root`);
  const policyRelativePath = target.relativePath || path.basename(realPath);
  if (
    isGloballyDeniedPath(policyRelativePath, realPath)
    || matchesConfiguredOrGlobalPattern(policyRelativePath, target.mount.config.exclude)
  ) {
    throw new Error(`${target.virtualPath} is excluded`);
  }
  const stat = await fsp.stat(realPath);
  return {
    appId: FILE_INSPECTOR_APP_ID,
    mount: target.mount.config.name,
    path: target.virtualPath,
    type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    writeAccess: target.mount.config.writeAccess,
  };
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

