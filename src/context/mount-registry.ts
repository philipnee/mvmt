import path from 'path';
import { expandHome } from '../config/loader.js';
import { LocalFolderMountConfig } from '../config/schema.js';

export interface RegisteredMount {
  config: LocalFolderMountConfig;
  root: string;
}

export interface ResolvedMountPath {
  mount: RegisteredMount;
  relativePath: string;
  realPath: string;
  virtualPath: string;
}

export class MountRegistry {
  private readonly registered: RegisteredMount[];

  constructor(mounts: LocalFolderMountConfig[]) {
    this.registered = mounts
      .filter((mount) => mount.enabled !== false)
      .map((mount) => ({
        config: mount,
        root: path.resolve(expandHome(mount.root)),
      }))
      .sort((a, b) => b.config.path.length - a.config.path.length);
  }

  mounts(): RegisteredMount[] {
    return this.registered.map((mount) => ({ ...mount }));
  }

  mountNames(): string[] {
    return this.registered.map((mount) => mount.config.name);
  }

  writableMountNames(): string[] {
    return this.registered
      .filter((mount) => mount.config.writeAccess)
      .map((mount) => mount.config.name);
  }

  mountNameForPath(inputPath: string): string | undefined {
    return this.findMount(normalizeVirtualPath(inputPath))?.config.name;
  }

  resolve(inputPath: string): ResolvedMountPath {
    const normalized = normalizeVirtualPath(inputPath);
    const mount = this.findMount(normalized);
    if (!mount) throw new Error(`unknown mount for path: ${normalized}`);
    const relativePath = toVirtualRelative(normalized.slice(mount.config.path.length));
    const realPath = path.resolve(mount.root, relativePath);
    if (!isWithin(mount.root, realPath)) throw new Error(`${normalized} escapes mount root`);
    return {
      mount,
      relativePath,
      realPath,
      virtualPath: relativePath ? joinVirtualPath(mount.config.path, relativePath) : mount.config.path,
    };
  }

  private findMount(normalizedPath: string): RegisteredMount | undefined {
    return this.registered.find((candidate) => pathMatchesMount(normalizedPath, candidate.config.path));
  }
}

export function normalizeVirtualPath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed || trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+/, '').replace(/\\/g, '/')}`;
}

export function toVirtualRelative(inputPath: string): string {
  return inputPath.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
}

export function joinVirtualPath(mountPath: string, relativePath: string): string {
  return [mountPath.replace(/\/+$/, ''), toVirtualRelative(relativePath)].filter(Boolean).join('/');
}

function pathMatchesMount(inputPath: string, mountPath: string): boolean {
  return inputPath === mountPath || inputPath.startsWith(`${mountPath.replace(/\/+$/, '')}/`);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
