import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { ObsidianConnector, extractTags } from '../src/connectors/obsidian.js';
import { CallToolResult } from '../src/connectors/types.js';

describe('extractTags', () => {
  it('extracts inline tags and YAML frontmatter tags', () => {
    const tags = extractTags('---\ntags: [todo, urgent]\n---\nBody #todo #project/alpha');

    expect(tags).toEqual(expect.arrayContaining(['todo', 'urgent', 'project/alpha']));
    expect(tags.filter((tag) => tag === 'todo')).toHaveLength(1);
  });

  it('extracts YAML block tags', () => {
    const tags = extractTags('---\ntags:\n  - project\n  - review\n---\nBody text');

    expect(tags).toEqual(expect.arrayContaining(['project', 'review']));
  });
});

describe('ObsidianConnector', () => {
  it('lists, searches, reads, and aggregates note tags', async () => {
    const vaultPath = await createVault();
    const connector = new ObsidianConnector({ path: vaultPath, writeAccess: true });
    await connector.initialize();

    await expect(connector.listTools()).resolves.toHaveLength(5);

    expect(parseTextResult(await connector.callTool('list_notes', {}))).toMatchObject({
      noteCount: 2,
      notes: expect.arrayContaining([
        { path: 'daily/2025-01-15.md', tags: expect.arrayContaining(['daily']) },
        { path: 'projects/my-project.md', tags: expect.arrayContaining(['project']) },
      ]),
    });

    expect(parseTextResult(await connector.callTool('search_notes', { query: 'launch' }))).toMatchObject({
      query: 'launch',
      totalNotes: 2,
      results: [{ path: 'projects/my-project.md', snippet: expect.stringContaining('launch') }],
    });

    expect(parseTextResult(await connector.callTool('read_note', { notePath: 'projects/my-project' }))).toMatchObject({
      path: 'projects/my-project.md',
      tags: expect.arrayContaining(['project']),
      content: expect.stringContaining('launch checklist'),
    });

    expect(parseTextResult(await connector.callTool('list_tags', {}))).toMatchObject({
      totalTags: 2,
      tags: expect.arrayContaining([
        { tag: 'daily', count: 1 },
        { tag: 'project', count: 1 },
      ]),
    });
  });

  it('blocks note path traversal', async () => {
    const vaultPath = await createVault();
    const connector = new ObsidianConnector({ path: vaultPath });
    await connector.initialize();

    await expect(connector.callTool('read_note', { notePath: '../outside' })).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('Access denied') }],
    });
  });

  it('appends to the local daily note when write access is enabled', async () => {
    const vaultPath = await createVault();
    const connector = new ObsidianConnector({ path: vaultPath, writeAccess: true });
    await connector.initialize();

    const result = parseTextResult(await connector.callTool('append_to_daily', { content: 'Captured thought' }));

    expect(result).toMatchObject({ appended: 'Captured thought' });
    const dailyNote = (result as { dailyNote: string }).dailyNote;
    await expect(fs.readFile(path.join(vaultPath, dailyNote), 'utf-8')).resolves.toContain('Captured thought');
  });

  it('hides and blocks append_to_daily when write access is disabled', async () => {
    const vaultPath = await createVault();
    const connector = new ObsidianConnector({ path: vaultPath });
    await connector.initialize();

    const tools = await connector.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain('append_to_daily');

    await expect(connector.callTool('append_to_daily', { content: 'nope' })).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('write access is disabled') }],
    });
  });

  it('blocks append_to_daily when daily is a symlink outside the vault', async () => {
    const vaultPath = await createVault();
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-outside-'));

    await fs.rm(path.join(vaultPath, 'daily'), { recursive: true });
    await fs.symlink(outsideDir, path.join(vaultPath, 'daily'));

    const connector = new ObsidianConnector({ path: vaultPath, writeAccess: true });
    await connector.initialize();

    const result = await connector.callTool('append_to_daily', { content: 'escape attempt' });
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('Access denied') }],
    });

    // Verify nothing was written outside the vault
    const files = await fs.readdir(outsideDir);
    expect(files).toHaveLength(0);
  });

  it('blocks append_to_daily when daily is a symlink inside the vault', async () => {
    const vaultPath = await createVault();
    const realDaily = path.join(vaultPath, 'real-daily');
    await fs.mkdir(realDaily);
    await fs.rm(path.join(vaultPath, 'daily'), { recursive: true });
    await fs.symlink(realDaily, path.join(vaultPath, 'daily'));

    const connector = new ObsidianConnector({ path: vaultPath, writeAccess: true });
    await connector.initialize();

    const result = await connector.callTool('append_to_daily', { content: 'symlink parent' });
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('Access denied') }],
    });

    const files = await fs.readdir(realDaily);
    expect(files).toHaveLength(0);
  });

  it('blocks append_to_daily when the daily note is a symlink outside the vault', async () => {
    const vaultPath = await createVault();
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-outside-'));
    const outsideFile = path.join(outsideDir, 'outside.md');
    await fs.writeFile(outsideFile, 'original', 'utf-8');

    const dailyNote = path.join(vaultPath, 'daily', todayFileName());
    await fs.rm(dailyNote, { force: true });
    await fs.symlink(outsideFile, dailyNote);

    const connector = new ObsidianConnector({ path: vaultPath, writeAccess: true });
    await connector.initialize();

    const result = await connector.callTool('append_to_daily', { content: 'symlink target' });
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('Access denied') }],
    });

    await expect(fs.readFile(outsideFile, 'utf-8')).resolves.toBe('original');
  });

  it('rejects non-vault directories', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-not-vault-'));
    const connector = new ObsidianConnector({ path: dir });

    await expect(connector.initialize()).rejects.toThrow('Not a valid Obsidian vault');
  });
});

async function createVault(): Promise<string> {
  const vaultPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-vault-'));
  await fs.mkdir(path.join(vaultPath, '.obsidian'));
  await fs.mkdir(path.join(vaultPath, 'daily'), { recursive: true });
  await fs.mkdir(path.join(vaultPath, 'projects'), { recursive: true });
  await fs.writeFile(path.join(vaultPath, 'daily', '2025-01-15.md'), 'Daily note #daily', 'utf-8');
  await fs.writeFile(
    path.join(vaultPath, 'projects', 'my-project.md'),
    '---\ntags:\n  - project\n---\nlaunch checklist',
    'utf-8',
  );
  return vaultPath;
}

function parseTextResult(result: CallToolResult): unknown {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('Expected text result');
  return JSON.parse(first.text);
}

function todayFileName(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}.md`;
}
