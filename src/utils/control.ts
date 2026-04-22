import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { getConfigPath } from '../config/loader.js';

export class ControlUnavailableError extends Error {}

export interface JsonControlConnection {
  send(message: unknown): void;
  close(): void;
  onClose(listener: () => void): void;
}

export interface JsonControlServer {
  close(): Promise<void>;
}

export function getControlSocketPath(configPath = getConfigPath()): string {
  const hash = crypto.createHash('sha256').update(configPath).digest('hex').slice(0, 12);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\mvmt-${hash}`;
  }
  return path.join(os.homedir(), '.mvmt', `control-${hash}.sock`);
}

export async function startJsonControlServer(
  socketPath: string,
  onMessage: (message: any, connection: JsonControlConnection) => void | Promise<void>,
): Promise<JsonControlServer> {
  if (process.platform !== 'win32') {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    try {
      fs.unlinkSync(socketPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  const server = net.createServer((socket) => {
    socket.setEncoding('utf-8');
    let buffer = '';
    const closeListeners = new Set<() => void>();

    const connection: JsonControlConnection = {
      send(message) {
        socket.write(`${JSON.stringify(message)}\n`);
      },
      close() {
        socket.end();
      },
      onClose(listener) {
        closeListeners.add(listener);
      },
    };

    socket.on('data', async (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
        try {
          const message = JSON.parse(line);
          await onMessage(message, connection);
        } catch (err) {
          connection.send({
            ok: false,
            error: err instanceof Error ? err.message : 'Invalid control request',
          });
          connection.close();
        }
      }
    });

    socket.on('close', () => {
      for (const listener of closeListeners) listener();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      if (process.platform !== 'win32') {
        try {
          fs.unlinkSync(socketPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
    },
  };
}

export async function sendJsonControlRequest<T>(
  socketPath: string,
  message: unknown,
): Promise<T> {
  const response = await new Promise<any>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf-8');
    let buffer = '';

    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        reject(new ControlUnavailableError('mvmt is not running for this config.'));
        return;
      }
      reject(err);
    });

    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
        resolve(JSON.parse(line));
        socket.end();
        return;
      }
    });

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(message)}\n`);
    });
  });

  if (!response?.ok) {
    throw new Error(response?.error ?? 'Control request failed');
  }
  return response.result as T;
}

export async function streamJsonControl(
  socketPath: string,
  message: unknown,
  onMessage: (message: any) => void,
): Promise<() => void> {
  const socket = net.createConnection(socketPath);
  socket.setEncoding('utf-8');
  let buffer = '';

  await new Promise<void>((resolve, reject) => {
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        reject(new ControlUnavailableError('mvmt is not running for this config.'));
        return;
      }
      reject(err);
    });

    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
        onMessage(JSON.parse(line));
      }
    });

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(message)}\n`);
      resolve();
    });
  });

  return () => {
    socket.end();
  };
}
