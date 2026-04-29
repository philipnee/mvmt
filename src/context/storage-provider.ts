import fsp from 'fs/promises';
import path from 'path';
import { GLOBAL_SECRET_PATH_PATTERNS } from '../config/schema.js';
import { joinVirtualPath, normalizePathSeparators, RegisteredMount, toVirtualRelative } from './mount-registry.js';

export interface StorageProviderFile {
  mount: string;
  path: string;
  relativePath: string;
  content: string;
  size: number;
  mtimeMs: number;
}

export interface StorageProviderEntry {
  mount: string;
  path: string;
  relativePath: string;
  type: 'file' | 'directory';
  size: number;
  mtimeMs: number;
}

export interface StorageProvider {
  readonly mount: RegisteredMount;
  list(relativePath?: string): Promise<StorageProviderEntry[]>;
  exists(relativePath: string): Promise<boolean>;
  read(relativePath: string): Promise<StorageProviderFile>;
  write(relativePath: string, content: string): Promise<StorageProviderFile>;
  remove(relativePath: string): Promise<void>;
  walkTextFiles(): AsyncIterable<StorageProviderFile>;
}

export interface LocalFolderStorageProviderOptions {
  isTextPath(path: string): boolean;
  maxTextBytes: number;
}

export class LocalFolderStorageProvider implements StorageProvider {
  constructor(
    readonly mount: RegisteredMount,
    private readonly options: LocalFolderStorageProviderOptions,
  ) {}

  async list(relativePath = ''): Promise<StorageProviderEntry[]> {
    const target = this.resolve(relativePath);
    await this.assertRealPathWithinMount(target);
    const stat = await fsp.stat(target.realPath);
    if (!stat.isDirectory()) {
      return [{
        mount: this.mount.config.name,
        path: target.virtualPath,
        relativePath: target.relativePath,
        type: 'file',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      }];
    }

    const entries = await fsp.readdir(target.realPath, { withFileTypes: true });
    const result: StorageProviderEntry[] = [];
    for (const entry of entries) {
      const childRelative = joinRelative(target.relativePath, entry.name);
      if (this.isExcluded(childRelative)) continue;
      if (!entry.isDirectory() && !this.options.isTextPath(entry.name)) continue;
      const realPath = path.join(target.realPath, entry.name);
      if (!await this.realPathWithinMount(realPath)) continue;
      const itemStat = await fsp.stat(realPath);
      result.push({
        mount: this.mount.config.name,
        path: joinVirtualPath(this.mount.config.path, childRelative),
        relativePath: childRelative,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: itemStat.size,
        mtimeMs: itemStat.mtimeMs,
      });
    }
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await fsp.access(this.resolve(relativePath).realPath);
      return true;
    } catch {
      return false;
    }
  }

  async read(relativePath: string): Promise<StorageProviderFile> {
    const target = this.resolve(relativePath);
    this.assertTextPath(target.virtualPath);
    await this.assertRealPathWithinMount(target);
    const stat = await fsp.stat(target.realPath);
    if (!stat.isFile()) throw new Error(`${target.virtualPath} is not a file`);
    if (stat.size > this.options.maxTextBytes) throw new Error(`${target.virtualPath} is too large to read as text`);
    const content = await fsp.readFile(target.realPath, 'utf-8');
    return {
      mount: this.mount.config.name,
      path: target.virtualPath,
      relativePath: target.relativePath,
      content,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  }

  async write(relativePath: string, content: string): Promise<StorageProviderFile> {
    const target = this.resolve(relativePath);
    this.assertWritable(target);
    this.assertTextPath(target.virtualPath);
    if (Buffer.byteLength(content, 'utf-8') > this.options.maxTextBytes) {
      throw new Error(`${target.virtualPath} is too large to write as text`);
    }
    await this.assertRealPathWithinMount(target, { allowMissingLeaf: true });
    await fsp.mkdir(path.dirname(target.realPath), { recursive: true });
    await fsp.writeFile(target.realPath, content, 'utf-8');
    return this.read(relativePath);
  }

  async remove(relativePath: string): Promise<void> {
    const target = this.resolve(relativePath);
    this.assertWritable(target);
    await this.assertRealPathWithinMount(target);
    const stat = await fsp.stat(target.realPath);
    if (!stat.isFile()) throw new Error(`${target.virtualPath} is not a file`);
    await fsp.unlink(target.realPath);
  }

  async *walkTextFiles(): AsyncIterable<StorageProviderFile> {
    yield* this.walkDirectory('');
  }

  private async *walkDirectory(relativePath: string): AsyncIterable<StorageProviderFile> {
    let entries;
    try {
      entries = await fsp.readdir(this.realPath(relativePath), { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const childRelative = joinRelative(relativePath, entry.name);
      if (this.isExcluded(childRelative)) continue;
      if (entry.isDirectory()) {
        yield* this.walkDirectory(childRelative);
        continue;
      }
      if (!entry.isFile() || !this.options.isTextPath(entry.name)) continue;

      try {
        yield await this.read(childRelative);
      } catch {
        // Unsupported, unreadable, and over-size files are skipped by indexing.
      }
    }
  }

  private resolve(relativePath: string): ResolvedProviderPath {
    const normalized = toVirtualRelative(relativePath);
    if (this.isExcluded(normalized)) {
      throw new Error(`${joinVirtualPath(this.mount.config.path, normalized)} is excluded`);
    }
    const realPath = this.realPath(normalized);
    if (!isWithin(this.mount.root, realPath)) {
      throw new Error(`${joinVirtualPath(this.mount.config.path, normalized)} escapes mount root`);
    }
    if (isGloballyDeniedPath(normalized, realPath)) {
      throw new Error(`${joinVirtualPath(this.mount.config.path, normalized)} is globally denied`);
    }
    return {
      relativePath: normalized,
      realPath,
      virtualPath: normalized ? joinVirtualPath(this.mount.config.path, normalized) : this.mount.config.path,
    };
  }

  private realPath(relativePath: string): string {
    return path.resolve(this.mount.root, toVirtualRelative(relativePath));
  }

  private async assertRealPathWithinMount(
    target: ResolvedProviderPath,
    options: { allowMissingLeaf?: boolean } = {},
  ): Promise<void> {
    const rootRealPath = await fsp.realpath(this.mount.root);
    try {
      const targetRealPath = await fsp.realpath(target.realPath);
      if (!isWithin(rootRealPath, targetRealPath)) {
        throw new Error(`${target.virtualPath} escapes mount root`);
      }
      return;
    } catch (err) {
      if (!options.allowMissingLeaf || !isMissingPathError(err)) throw err;
    }

    const ancestorRealPath = await this.nearestExistingAncestorRealPath(target.realPath);
    if (!isWithin(rootRealPath, ancestorRealPath)) {
      throw new Error(`${target.virtualPath} escapes mount root`);
    }
  }

  private async realPathWithinMount(realPath: string): Promise<boolean> {
    try {
      const rootRealPath = await fsp.realpath(this.mount.root);
      const targetRealPath = await fsp.realpath(realPath);
      return isWithin(rootRealPath, targetRealPath);
    } catch {
      return false;
    }
  }

  private async nearestExistingAncestorRealPath(realPath: string): Promise<string> {
    let candidate = path.dirname(realPath);
    while (true) {
      try {
        return await fsp.realpath(candidate);
      } catch (err) {
        if (!isMissingPathError(err)) throw err;
        const parent = path.dirname(candidate);
        if (parent === candidate) throw err;
        candidate = parent;
      }
    }
  }

  private assertWritable(target: ResolvedProviderPath): void {
    if (!this.mount.config.writeAccess) {
      throw new Error(`${this.mount.config.name} is read-only`);
    }
    if (this.isProtected(target.relativePath)) {
      throw new Error(`${target.virtualPath} is protected`);
    }
  }

  private assertTextPath(inputPath: string): void {
    if (!this.options.isTextPath(inputPath)) {
      throw new Error(`${inputPath} is not a supported text file`);
    }
  }

  private isExcluded(relativePath: string): boolean {
    return matchesAny(relativePath, [...GLOBAL_SECRET_PATH_PATTERNS, ...this.mount.config.exclude]);
  }

  private isProtected(relativePath: string): boolean {
    return matchesAny(relativePath, [...GLOBAL_SECRET_PATH_PATTERNS, ...this.mount.config.protect]);
  }
}

interface ResolvedProviderPath {
  relativePath: string;
  realPath: string;
  virtualPath: string;
}

function joinRelative(base: string, leaf: string): string {
  return normalizePathSeparators([base, leaf].filter(Boolean).join('/'));
}

function matchesAny(relativePath: string, patterns: string[]): boolean {
  const normalized = toVirtualRelative(relativePath);
  return patterns.some((pattern) => {
    const normalizedPattern = toVirtualRelative(pattern);
    if (normalizedPattern.endsWith('/**')) {
      const prefix = normalizedPattern.slice(0, -3);
      return normalized === prefix || normalized.startsWith(`${prefix}/`);
    }
    return globToRegExp(pattern).test(normalized);
  });
}

function isGloballyDeniedPath(relativePath: string, realPath: string): boolean {
  return matchesAny(relativePath, [...GLOBAL_SECRET_PATH_PATTERNS]) || realPathHasSensitiveSegment(realPath);
}

const GLOBALLY_DENIED_SEGMENTS = new Set(['.mvmt', '.ssh', '.gnupg', '.aws', '.kube', '.docker']);
const GLOBALLY_DENIED_SEGMENT_PATHS = [
  ['.config', 'gh'],
  ['.config', 'gcloud'],
  ['.config', 'azure'],
];

function realPathHasSensitiveSegment(realPath: string): boolean {
  const segments = normalizePathSeparators(realPath).split('/').filter(Boolean);
  if (segments.some((segment) => GLOBALLY_DENIED_SEGMENTS.has(segment))) return true;
  return GLOBALLY_DENIED_SEGMENT_PATHS.some((denied) => containsSegmentSequence(segments, denied));
}

function containsSegmentSequence(segments: string[], needle: string[]): boolean {
  for (let start = 0; start <= segments.length - needle.length; start += 1) {
    if (needle.every((segment, offset) => segments[start + offset] === segment)) return true;
  }
  return false;
}

function globToRegExp(pattern: string): RegExp {
  const normalized = toVirtualRelative(pattern);
  const escaped = escapeRegExp(normalized)
    .replace(/\\\*\\\*/g, '.*')
    .replace(/\\\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isMissingPathError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}
