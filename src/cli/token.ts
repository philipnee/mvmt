import { generateSessionToken, readSessionToken, TOKEN_PATH } from '../utils/token.js';

export async function showToken(): Promise<void> {
  const token = readSessionToken();
  if (!token) {
    console.error(`No session token found at ${TOKEN_PATH}.`);
    console.error('Run `mvmt start` or `mvmt token rotate` first.');
    process.exitCode = 1;
    return;
  }

  console.log(token);
}

export async function rotateToken(): Promise<void> {
  const token = generateSessionToken();
  console.log(token);
  console.error(`Rotated session token at ${TOKEN_PATH}. Update any HTTP MCP clients that store the old token.`);
}
