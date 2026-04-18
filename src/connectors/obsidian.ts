import fs from 'fs/promises';
import path from 'path';
import { ObsidianConfig } from '../config/schema.js';
import { CallToolResult, Connector, ToolDefinition } from './types.js';

export class ObsidianConnector implements Connector {
  readonly id = 'obsidian';
  readonly displayName = 'obsidian';
  private vaultPath = '';
  private vaultRealPath = '';
  private readonly writeAccess: boolean;

  constructor(private readonly config: Pick<ObsidianConfig, 'path'> & { writeAccess?: boolean }) {
    this.writeAccess = config.writeAccess === true;
  }

  async initialize(): Promise<void> {
    this.vaultPath = path.resolve(this.config.path);

    try {
      await fs.access(path.join(this.vaultPath, '.obsidian'));
    } catch {
      throw new Error(`Not a valid Obsidian vault: ${this.vaultPath} (no .obsidian directory)`);
    }

    try {
      this.vaultRealPath = await fs.realpath(this.vaultPath);
    } catch {
      this.vaultRealPath = this.vaultPath;
    }
  }

  async listTools(): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = [
      {
        name: 'search_notes',
        description: 'Search notes in the Obsidian vault by keyword and return matching note paths with preview snippets.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search keyword or phrase' },
            maxResults: { type: 'number', description: 'Max results to return. Default: 10' },
          },
          required: ['query'],
        },
      },
      {
        name: 'read_note',
        description: 'Read the full contents of a note by path relative to the vault root. The .md extension is optional.',
        inputSchema: {
          type: 'object',
          properties: {
            notePath: { type: 'string', description: 'Path to the note relative to the vault root' },
          },
          required: ['notePath'],
        },
      },
      {
        name: 'list_notes',
        description: 'List notes in the vault or in a specific folder, including tags for each note.',
        inputSchema: {
          type: 'object',
          properties: {
            folder: { type: 'string', description: 'Optional subfolder to list' },
          },
        },
      },
      {
        name: 'list_tags',
        description: 'List all tags used across the vault with note counts.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];

    if (this.writeAccess) {
      tools.push({
        name: 'append_to_daily',
        description: "Append text to today's daily note, creating daily/YYYY-MM-DD.md when needed.",
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Text to append' },
          },
          required: ['content'],
        },
      });
    }

    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      let result: unknown;
      switch (name) {
        case 'search_notes':
          result = await this.searchNotes(requireString(args.query, 'query'), normalizeMaxResults(args.maxResults));
          break;
        case 'read_note':
          result = await this.readNote(requireString(args.notePath, 'notePath'));
          break;
        case 'list_notes':
          result = await this.listNotes(optionalString(args.folder, 'folder'));
          break;
        case 'list_tags':
          result = await this.listTags();
          break;
        case 'append_to_daily':
          if (!this.writeAccess) {
            throw new Error(
              'Obsidian write access is disabled. Set obsidian.writeAccess: true in ~/.mvmt/config.yaml to enable append_to_daily.',
            );
          }
          result = await this.appendToDaily(requireString(args.content, 'content'));
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
          },
        ],
        isError: true,
      };
    }
  }

  async shutdown(): Promise<void> {
    // No process or watcher to clean up.
  }

  private async searchNotes(query: string, maxResults: number) {
    const notes = await this.getAllNotes();
    const queryLower = query.toLowerCase();
    const results: Array<{ path: string; snippet: string }> = [];

    for (const notePath of notes) {
      if (results.length >= maxResults) break;

      let content: string;
      try {
        content = await this.readVaultFile(notePath);
      } catch {
        continue;
      }

      const contentLower = content.toLowerCase();
      const idx = contentLower.indexOf(queryLower);
      if (idx === -1 && !notePath.toLowerCase().includes(queryLower)) continue;

      const snippet =
        idx === -1
          ? trimSnippet(content, 0, Math.min(content.length, 160), 160)
          : trimSnippet(content, Math.max(0, idx - 80), Math.min(content.length, idx + query.length + 80), content.length);

      results.push({ path: notePath, snippet });
    }

    return { query, totalNotes: notes.length, results };
  }

  private async readNote(notePath: string) {
    const normalizedPath = notePath.endsWith('.md') ? notePath : `${notePath}.md`;
    this.resolveVaultPath(normalizedPath);

    try {
      const content = await this.readVaultFile(normalizedPath);
      return { path: normalizedPath, tags: extractTags(content), content };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Access denied')) throw err;
      throw new Error(`Note not found: ${normalizedPath}`);
    }
  }

  private async listNotes(folder?: string) {
    const notes = await this.getAllNotes(folder);
    const results: Array<{ path: string; tags: string[] }> = [];

    for (const notePath of notes) {
      try {
        const content = await this.readVaultFile(notePath);
        results.push({ path: notePath, tags: extractTags(content) });
      } catch {
        results.push({ path: notePath, tags: [] });
      }
    }

    return { folder: folder || '/', noteCount: results.length, notes: results };
  }

  private async listTags() {
    const notes = await this.getAllNotes();
    const tagCounts = new Map<string, number>();

    for (const notePath of notes) {
      try {
        const content = await this.readVaultFile(notePath);
        for (const tag of extractTags(content)) {
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        }
      } catch {
        continue;
      }
    }

    const tags = [...tagCounts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

    return { totalTags: tags.length, tags };
  }

  private async appendToDaily(content: string) {
    const today = formatLocalDate(new Date());
    const relativePath = path.join('daily', `${today}.md`);
    const writePath = await this.resolveWritePath(relativePath);

    let existing = '';
    try {
      existing = await fs.readFile(writePath, 'utf-8');
    } catch (err) {
      if (!isNodeError(err, 'ENOENT')) throw err;
      // The daily note will be created below.
    }

    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : '';
    await fs.writeFile(writePath, `${existing}${separator}${content}`, 'utf-8');

    return { dailyNote: relativePath.replaceAll(path.sep, '/'), appended: content };
  }

  private async getAllNotes(folder?: string): Promise<string[]> {
    const startDir = folder ? this.resolveVaultPath(folder) : this.vaultPath;
    const notes: string[] = [];

    await this.walkNotes(startDir, notes);

    return notes.sort((a, b) => a.localeCompare(b));
  }

  private async walkNotes(dir: string, notes: string[]): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        await this.walkNotes(fullPath, notes);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        notes.push(path.relative(this.vaultPath, fullPath).replaceAll(path.sep, '/'));
      }
    }
  }

  private async resolveWritePath(relativePath: string): Promise<string> {
    const resolved = this.resolveVaultPath(relativePath);
    const parentDir = path.dirname(resolved);

    await fs.mkdir(parentDir, { recursive: true });
    await this.assertNoSymlinkPathSegments(parentDir);

    const parentStat = await fs.lstat(parentDir);
    if (parentStat.isSymbolicLink()) {
      throw new Error('Access denied: write target includes a symlinked directory');
    }
    if (!parentStat.isDirectory()) {
      throw new Error('Access denied: write target parent is not a directory');
    }

    const realParent = await fs.realpath(parentDir);
    const vaultReal = this.vaultRealPath || this.vaultPath;
    const rel = path.relative(vaultReal, realParent);
    if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
      throw new Error('Access denied: write target resolves outside the vault');
    }

    const target = path.join(realParent, path.basename(resolved));
    try {
      const targetStat = await fs.lstat(target);
      if (targetStat.isSymbolicLink()) {
        throw new Error('Access denied: write target is a symlink');
      }
      if (!targetStat.isFile()) {
        throw new Error('Access denied: write target is not a file');
      }
    } catch (err) {
      if (!isNodeError(err, 'ENOENT')) throw err;
    }

    return target;
  }

  private async assertNoSymlinkPathSegments(targetDir: string): Promise<void> {
    const relative = path.relative(this.vaultPath, targetDir);
    if (relative === '') return;

    let current = this.vaultPath;
    for (const segment of relative.split(path.sep)) {
      if (!segment) continue;
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error('Access denied: write target includes a symlinked directory');
      }
    }
  }

  private resolveVaultPath(relativePath: string): string {
    const resolved = path.resolve(this.vaultPath, relativePath);
    const relative = path.relative(this.vaultPath, resolved);

    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return resolved;
    }

    throw new Error('Access denied: path is outside the vault');
  }

  private async readVaultFile(relativePath: string): Promise<string> {
    const resolved = this.resolveVaultPath(relativePath);
    let realResolved: string;
    try {
      realResolved = await fs.realpath(resolved);
    } catch (err) {
      throw err instanceof Error ? err : new Error('Unable to resolve note path');
    }

    const vaultReal = this.vaultRealPath || this.vaultPath;
    const relative = path.relative(vaultReal, realResolved);
    if (relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))) {
      throw new Error('Access denied: path is outside the vault');
    }

    return fs.readFile(realResolved, 'utf-8');
  }
}

export function extractTags(content: string): string[] {
  const tags = new Set<string>();
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);

  if (fmMatch) {
    const fmBlock = fmMatch[1];

    const inlineMatch = fmBlock.match(/^tags:\s*\[([^\]]*)\]/m);
    if (inlineMatch) {
      for (const tag of inlineMatch[1].split(',')) {
        addTag(tags, tag);
      }
    }

    const blockMatch = fmBlock.match(/^tags:\s*\n((?:\s+-\s+.+\n?)*)/m);
    if (blockMatch) {
      for (const line of blockMatch[1].split('\n')) {
        const match = line.match(/^\s+-\s+(.+)/);
        if (match) addTag(tags, match[1]);
      }
    }
  }

  const body = fmMatch ? content.slice(fmMatch[0].length) : content;
  for (const match of body.matchAll(/(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)/g)) {
    tags.add(match[1]);
  }

  return [...tags];
}

function addTag(tags: Set<string>, rawTag: string): void {
  const cleaned = rawTag.trim().replace(/^["']|["']$/g, '');
  if (cleaned) tags.add(cleaned);
}

function normalizeMaxResults(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 10;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected ${name} to be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`Expected ${name} to be a string`);
  return value;
}

function trimSnippet(content: string, start: number, end: number, totalLength: number): string {
  const prefix = start > 0 ? '...' : '';
  const suffix = end < totalLength ? '...' : '';
  return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isNodeError(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === code;
}
