import crypto from 'crypto';
import fsp from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LocalFolderMountConfig } from '../config/schema.js';
import {
  joinVirtualPath,
  MountRegistry,
  RegisteredMount,
  ResolvedMountPath,
  toVirtualRelative,
} from './mount-registry.js';

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.text',
  '.log',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.csv',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.css',
  '.scss',
  '.html',
  '.xml',
  '.sh',
  '.bash',
  '.zsh',
]);

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const CHUNK_SIZE = 1600;
const CHUNK_OVERLAP = 200;

export interface TextContextIndexOptions {
  mounts: LocalFolderMountConfig[];
  indexPath: string;
}

export interface TextIndexStats {
  files: number;
  chunks: number;
}

export interface TextSearchResult {
  mount: string;
  path: string;
  chunk_id: string;
  score: number;
  snippet: string;
  hash: string;
  mtime_ms: number;
}

export interface TextListEntry {
  mount: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  mtime_ms: number;
  description?: string;
  guidance?: string;
  write_access?: boolean;
}

export interface TextReadResult {
  mount: string;
  path: string;
  content: string;
  mime_type: 'text/plain';
  size: number;
  hash: string;
  mtime_ms: number;
}

interface IndexedFile {
  mount: string;
  path: string;
  hash: string;
  size: number;
  mtime_ms: number;
}

interface IndexedChunk {
  mount: string;
  path: string;
  chunk_id: string;
  text: string;
  hash: string;
  mtime_ms: number;
}

interface TextIndexSnapshot {
  version: 1;
  indexed_at: string;
  files: IndexedFile[];
  chunks: IndexedChunk[];
}

export function defaultTextIndexPath(configPath: string): string {
  return path.join(path.dirname(configPath), 'text-index.json');
}

export class TextContextIndex {
  private readonly registry: MountRegistry;

  constructor(private readonly options: TextContextIndexOptions) {
    this.registry = new MountRegistry(options.mounts);
  }

  mountNames(): string[] {
    return this.registry.mountNames();
  }

  writableMountNames(): string[] {
    return this.registry.writableMountNames();
  }

  mountNameForPath(inputPath: string): string | undefined {
    return this.registry.mountNameForPath(inputPath);
  }

  mountPathForName(name: string): string | undefined {
    return this.registry.mountPathForName(name);
  }

  async rebuild(): Promise<TextIndexStats> {
    const files: IndexedFile[] = [];
    const chunks: IndexedChunk[] = [];

    for (const mount of this.registry.mounts()) {
      await this.indexDirectory(mount, mount.root, files, chunks);
    }

    await this.writeSnapshot({ version: 1, indexed_at: new Date().toISOString(), files, chunks });
    return { files: files.length, chunks: chunks.length };
  }

  async search(query: string, mountNames?: string[], limit = 8): Promise<TextSearchResult[]> {
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const allowedMounts = new Set(mountNames ?? this.mountNames());
    const snapshot = await this.readSnapshot();
    const ranked = snapshot.chunks
      .filter((chunk) => allowedMounts.has(chunk.mount))
      .map((chunk) => ({ chunk, score: scoreText(chunk.text, terms) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.chunk.path.localeCompare(b.chunk.path))
      .slice(0, Math.max(1, Math.min(20, limit)));

    return ranked.map(({ chunk, score }) => ({
      mount: chunk.mount,
      path: chunk.path,
      chunk_id: chunk.chunk_id,
      score,
      snippet: snippetFor(chunk.text, terms),
      hash: chunk.hash,
      mtime_ms: chunk.mtime_ms,
    }));
  }

  async list(inputPath = '/'): Promise<TextListEntry[]> {
    if (inputPath === '/' || inputPath.trim() === '') {
      return this.registry.mounts().map((mount) => ({
        mount: mount.config.name,
        path: mount.config.path,
        type: 'directory',
        size: 0,
        mtime_ms: 0,
        description: mount.config.description,
        guidance: mount.config.guidance,
        write_access: mount.config.writeAccess,
      }));
    }

    const resolved = this.resolvePath(inputPath);
    const stat = await fsp.stat(resolved.realPath);
    if (!stat.isDirectory()) {
      return [{
        mount: resolved.mount.config.name,
        path: resolved.virtualPath,
        type: 'file',
        size: stat.size,
        mtime_ms: stat.mtimeMs,
      }];
    }

    const entries = await fsp.readdir(resolved.realPath, { withFileTypes: true });
    const result: TextListEntry[] = [];
    for (const entry of entries) {
      const relative = joinVirtualRelative(resolved.relativePath, entry.name);
      if (this.isExcluded(resolved.mount, relative)) continue;
      if (!entry.isDirectory() && !isTextPath(entry.name)) continue;
      const realPath = path.join(resolved.realPath, entry.name);
      const itemStat = await fsp.stat(realPath);
      result.push({
        mount: resolved.mount.config.name,
        path: joinVirtualPath(resolved.mount.config.path, relative),
        type: entry.isDirectory() ? 'directory' : 'file',
        size: itemStat.size,
        mtime_ms: itemStat.mtimeMs,
      });
    }
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(inputPath: string): Promise<TextReadResult> {
    const resolved = this.resolvePath(inputPath);
    this.assertTextPath(resolved.virtualPath);
    const stat = await fsp.stat(resolved.realPath);
    if (!stat.isFile()) throw new Error(`${resolved.virtualPath} is not a file`);
    if (stat.size > MAX_TEXT_BYTES) throw new Error(`${resolved.virtualPath} is too large to read as text`);
    const content = await fsp.readFile(resolved.realPath, 'utf-8');
    return {
      mount: resolved.mount.config.name,
      path: resolved.virtualPath,
      content,
      mime_type: 'text/plain',
      size: stat.size,
      hash: sha256(content),
      mtime_ms: stat.mtimeMs,
    };
  }

  async write(inputPath: string, content: string, expectedHash?: string): Promise<TextReadResult> {
    const resolved = this.resolvePath(inputPath);
    this.assertWritable(resolved);
    this.assertTextPath(resolved.virtualPath);
    if (expectedHash) {
      try {
        const current = await this.read(inputPath);
        if (current.hash !== expectedHash) {
          throw new Error(`hash mismatch for ${resolved.virtualPath}`);
        }
      } catch (err) {
        if ((err instanceof Error && err.message.includes('hash mismatch')) || fs.existsSync(resolved.realPath)) {
          throw err;
        }
      }
    }
    await fsp.mkdir(path.dirname(resolved.realPath), { recursive: true });
    await fsp.writeFile(resolved.realPath, content, 'utf-8');
    const read = await this.read(inputPath);
    await this.rebuild();
    return read;
  }

  async delete(inputPath: string): Promise<{ mount: string; path: string; deleted: true }> {
    const resolved = this.resolvePath(inputPath);
    this.assertWritable(resolved);
    const stat = await fsp.stat(resolved.realPath);
    if (!stat.isFile()) throw new Error(`${resolved.virtualPath} is not a file`);
    await fsp.unlink(resolved.realPath);
    await this.rebuild();
    return { mount: resolved.mount.config.name, path: resolved.virtualPath, deleted: true };
  }

  private async indexDirectory(
    mount: RegisteredMount,
    directory: string,
    files: IndexedFile[],
    chunks: IndexedChunk[],
  ): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const realPath = path.join(directory, entry.name);
      const relative = toVirtualRelative(path.relative(mount.root, realPath));
      if (this.isExcluded(mount, relative)) continue;
      if (entry.isDirectory()) {
        await this.indexDirectory(mount, realPath, files, chunks);
        continue;
      }
      if (!entry.isFile() || !isTextPath(entry.name)) continue;

      const stat = await fsp.stat(realPath);
      if (stat.size > MAX_TEXT_BYTES) continue;
      const text = await fsp.readFile(realPath, 'utf-8');
      const hash = sha256(text);
      const virtualPath = joinVirtualPath(mount.config.path, relative);
      files.push({
        mount: mount.config.name,
        path: virtualPath,
        hash,
        size: stat.size,
        mtime_ms: stat.mtimeMs,
      });
      chunks.push(...chunkText(mount.config.name, virtualPath, text, hash, stat.mtimeMs));
    }
  }

  private resolvePath(inputPath: string): ResolvedMountPath {
    const resolved = this.registry.resolve(inputPath);
    if (this.isExcluded(resolved.mount, resolved.relativePath)) throw new Error(`${resolved.virtualPath} is excluded`);
    return resolved;
  }

  private assertWritable(resolved: { mount: RegisteredMount; relativePath: string; virtualPath: string }): void {
    if (!resolved.mount.config.writeAccess) {
      throw new Error(`${resolved.mount.config.name} is read-only`);
    }
    if (this.isProtected(resolved.mount, resolved.relativePath)) {
      throw new Error(`${resolved.virtualPath} is protected`);
    }
  }

  private assertTextPath(inputPath: string): void {
    if (!isTextPath(inputPath)) {
      throw new Error(`${inputPath} is not a supported text file`);
    }
  }

  private isExcluded(mount: RegisteredMount, relativePath: string): boolean {
    return matchesAny(relativePath, mount.config.exclude);
  }

  private isProtected(mount: RegisteredMount, relativePath: string): boolean {
    return matchesAny(relativePath, mount.config.protect);
  }

  private async readSnapshot(): Promise<TextIndexSnapshot> {
    try {
      return JSON.parse(await fsp.readFile(this.options.indexPath, 'utf-8')) as TextIndexSnapshot;
    } catch {
      return { version: 1, indexed_at: new Date(0).toISOString(), files: [], chunks: [] };
    }
  }

  private async writeSnapshot(snapshot: TextIndexSnapshot): Promise<void> {
    await fsp.mkdir(path.dirname(this.options.indexPath), { recursive: true });
    await fsp.writeFile(this.options.indexPath, JSON.stringify(snapshot, null, 2), { encoding: 'utf-8', mode: 0o600 });
    if (process.platform !== 'win32') {
      await fsp.chmod(this.options.indexPath, 0o600);
    }
  }
}

function chunkText(mountName: string, virtualPath: string, text: string, hash: string, mtimeMs: number): IndexedChunk[] {
  const chunks: IndexedChunk[] = [];
  for (let offset = 0; offset < text.length; offset += CHUNK_SIZE - CHUNK_OVERLAP) {
    const chunk = text.slice(offset, offset + CHUNK_SIZE);
    if (chunk.trim().length === 0) continue;
    chunks.push({
      mount: mountName,
      path: virtualPath,
      chunk_id: `${virtualPath}#${offset}`,
      text: chunk,
      hash,
      mtime_ms: mtimeMs,
    });
  }
  return chunks;
}

function isTextPath(inputPath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(inputPath).toLowerCase());
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((term) => term.length > 1);
}

function scoreText(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  return terms.reduce((score, term) => {
    const matches = lower.match(new RegExp(escapeRegExp(term), 'g'));
    return score + (matches?.length ?? 0);
  }, 0);
}

function snippetFor(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const first = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, first - 160);
  return text.slice(start, start + 500).replace(/\s+/g, ' ').trim();
}

function joinVirtualRelative(base: string, leaf: string): string {
  return [base, leaf].filter(Boolean).join('/').replace(/\\/g, '/');
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

function globToRegExp(pattern: string): RegExp {
  const normalized = toVirtualRelative(pattern);
  const escaped = escapeRegExp(normalized)
    .replace(/\\\*\\\*/g, '.*')
    .replace(/\\\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf-8').digest('hex');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function defaultTextIndexRoot(): string {
  return path.join(os.homedir(), '.mvmt');
}
