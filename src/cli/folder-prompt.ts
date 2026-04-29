import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { resolveSetupPath } from '../connectors/setup-paths.js';

export interface FolderPromptOptions {
  allowEmpty?: boolean;
  defaultValue?: string;
}

export async function promptForExistingFolder(
  message = 'Folder on this computer:',
  options: FolderPromptOptions = {},
): Promise<string> {
  while (true) {
    const answer = (await questionWithPathCompletion(`${message} `, completeDirectoryPath, options.defaultValue)).trim();
    if (shouldFinishFolderPrompt(answer, options)) return '';
    const valid = await validateExistingFolderPath(answer);
    if (valid === true) return answer;
    console.error(valid);
  }
}

export async function promptForExistingFile(
  message = 'File on this computer:',
  options: FolderPromptOptions = {},
): Promise<string> {
  while (true) {
    const answer = (await questionWithPathCompletion(`${message} `, completeFilePath, options.defaultValue)).trim();
    if (shouldFinishFolderPrompt(answer, options)) return '';
    const valid = await validateExistingFilePath(answer);
    if (valid === true) return answer;
    console.error(valid);
  }
}

export function shouldFinishFolderPrompt(answer: string, options: FolderPromptOptions = {}): boolean {
  return answer.trim() === '' && options.allowEmpty === true;
}

export async function validateExistingFolderPath(value: string): Promise<true | string> {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter a folder path such as ~/Documents';

  try {
    const stats = await fs.promises.stat(resolveSetupPath(trimmed));
    return stats.isDirectory() ? true : 'Mount root must be a folder, not a file';
  } catch {
    return `Folder not found: ${trimmed}`;
  }
}

export async function validateExistingFilePath(value: string): Promise<true | string> {
  const trimmed = value.trim();
  if (!trimmed) return 'Enter a file path such as ~/.cloudflared/config.yml';

  try {
    const stats = await fs.promises.stat(resolveSetupPath(trimmed));
    return stats.isFile() ? true : 'Path must be a file, not a folder';
  } catch {
    return `File not found: ${trimmed}`;
  }
}

export function completeDirectoryPath(line: string): [string[], string] {
  return completeLocalPath(line, { includeFiles: false });
}

export function completeFilePath(line: string): [string[], string] {
  return completeLocalPath(line, { includeFiles: true });
}

function completeLocalPath(line: string, options: { includeFiles: boolean }): [string[], string] {
  const { baseDir, prefix } = directorySearch(line);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [[], line];
  }

  const matches = entries
    .filter((entry) => entry.isDirectory() || options.includeFiles)
    .filter((entry) => prefix.startsWith('.') || !entry.name.startsWith('.'))
    .filter((entry) => entry.name.toLowerCase().startsWith(prefix.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => formatCompletion(path.join(baseDir, entry.name), line, entry.isDirectory()));

  return [matches, line];
}

function questionWithPathCompletion(
  message: string,
  completer: (line: string) => [string[], string],
  defaultValue?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer,
      terminal: true,
    });

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      rl.close();
      callback();
    };

    rl.once('SIGINT', () => {
      finish(() => reject(new Error('User force closed the prompt with SIGINT')));
    });
    rl.question(message, (answer) => {
      finish(() => resolve(answer || defaultValue || ''));
    });
    if (defaultValue) rl.write(defaultValue);
  });
}

function directorySearch(line: string): { baseDir: string; prefix: string } {
  if (!line) return { baseDir: os.homedir(), prefix: '' };

  const expanded = expandHomePath(line);
  if (endsWithPathSeparator(line) || isDirectorySync(expanded)) {
    return { baseDir: expanded, prefix: '' };
  }

  return {
    baseDir: path.dirname(expanded),
    prefix: path.basename(expanded),
  };
}

function formatCompletion(absolutePath: string, originalInput: string, isDirectory: boolean): string {
  const completedPath = isDirectory ? `${absolutePath}${path.sep}` : absolutePath;
  if (originalInput.startsWith('~/') || originalInput === '~') {
    return collapseHomePath(completedPath);
  }
  if (path.isAbsolute(originalInput)) {
    return completedPath;
  }

  const relative = path.relative(process.cwd(), completedPath);
  const display = relative.startsWith('..') ? relative : `.${path.sep}${relative}`;
  return isDirectory && !display.endsWith(path.sep) ? `${display}${path.sep}` : display;
}

function expandHomePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed || os.homedir());
}

function collapseHomePath(absolutePath: string): string {
  const home = os.homedir();
  if (absolutePath === home) return '~';
  if (absolutePath.startsWith(`${home}${path.sep}`)) {
    return `~/${path.relative(home, absolutePath)}`;
  }
  return absolutePath;
}

function endsWithPathSeparator(value: string): boolean {
  return value.endsWith('/') || value.endsWith(path.sep);
}

function isDirectorySync(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
