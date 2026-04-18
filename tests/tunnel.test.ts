import { describe, expect, it } from 'vitest';
import {
  extractPublicUrl,
  formatMcpPublicUrl,
  renderTunnelCommand,
  startTunnel,
} from '../src/utils/tunnel.js';

describe('tunnel utilities', () => {
  it('renders port placeholders in tunnel commands', () => {
    expect(renderTunnelCommand('cloudflared tunnel --url http://127.0.0.1:{port}', 4142)).toBe(
      'cloudflared tunnel --url http://127.0.0.1:4142',
    );
  });

  it('extracts public HTTPS URLs from tunnel output', () => {
    expect(extractPublicUrl('Ready at https://quiet-river.trycloudflare.com')).toBe(
      'https://quiet-river.trycloudflare.com',
    );
    expect(extractPublicUrl('your url is: https://demo.loca.lt.')).toBe('https://demo.loca.lt');
  });

  it('ignores unrelated HTTPS URLs before tunnel URLs', () => {
    expect(
      extractPublicUrl(
        'RSA key details at https://openssh.com/pq.html\nconnect to https://abc123.lhr.life',
      ),
    ).toBe('https://abc123.lhr.life');
    expect(extractPublicUrl('RSA key details at https://openssh.com/pq.html')).toBeUndefined();
  });

  it('never treats localhost.run subdomains as tunnel URLs (admin portal, not a tunnel)', () => {
    // localhost.run hands out admin.localhost.run to unauthenticated sessions
    // for account/email verification — it is not the tunnel URL.
    expect(extractPublicUrl('To set up custom domains go to https://admin.localhost.run/')).toBeUndefined();
    expect(
      extractPublicUrl(
        'To set up custom domains go to https://admin.localhost.run/\nrandom.lhr.life tunneled with tls, https://random.lhr.life',
      ),
    ).toBe('https://random.lhr.life');
  });

  it('rejects bare tunnel provider hostnames (no subdomain)', () => {
    expect(extractPublicUrl('See https://localhost.run/docs for details')).toBeUndefined();
    expect(extractPublicUrl('Visit https://trycloudflare.com for info')).toBeUndefined();
  });

  it('extracts known public hosts without an explicit scheme', () => {
    expect(extractPublicUrl('tunneled with abc123.lhr.life')).toBe('https://abc123.lhr.life');
    expect(extractPublicUrl('pinggy url random.a.pinggy.io')).toBe('https://random.a.pinggy.io');
  });

  it('formats an MCP URL from the public tunnel base URL', () => {
    expect(formatMcpPublicUrl('https://quiet-river.trycloudflare.com/')).toBe(
      'https://quiet-river.trycloudflare.com/mcp',
    );
  });

  it('starts a tunnel command and resolves when a public URL appears', async () => {
    const lines: string[] = [];
    const tunnel = await startTunnel(
      nodeCommand("console.log('ready https://demo.trycloudflare.com'); setInterval(() => {}, 1000);"),
      4141,
      { timeoutMs: 500, onOutput: (line) => lines.push(line) },
    );

    expect(tunnel.url).toBe('https://demo.trycloudflare.com');
    expect(lines.join('\n')).toContain('demo.trycloudflare.com');
    await tunnel.stop();
  });

  it('keeps a running tunnel process when no URL is detected before timeout', async () => {
    const tunnel = await startTunnel(
      nodeCommand("console.log('still starting'); setInterval(() => {}, 1000);"),
      4141,
      { timeoutMs: 20 },
    );

    expect(tunnel.url).toBeUndefined();
    await tunnel.stop();
  });

  it('rejects when the tunnel command exits before printing a public URL', async () => {
    await expect(startTunnel(nodeCommand("console.error('no tunnel'); process.exit(2);"), 4141, { timeoutMs: 500 }))
      .rejects
      .toThrow('Tunnel command exited before a public URL was detected');
  });
});

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}
