import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFolderLease, listFolderLeases, revokeFolderLease } from '../src/cli/lease.js';
import { readConfig } from '../src/config/loader.js';
import { listLeases } from '../src/lease/store.js';

describe('lease CLI helpers', () => {
  let tmp: string;
  let configPath: string;
  let leaseStorePath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mvmt-lease-cli-'));
    configPath = path.join(tmp, 'config.yaml');
    leaseStorePath = path.join(tmp, '.leases.json');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('creates a 24h read-only folder lease and mount for a local folder', async () => {
    const folder = path.join(tmp, 'Taxes');
    await fs.mkdir(folder);

    await createFolderLease(folder, {
      config: configPath,
      leaseStorePath,
      label: 'Sarah - tax docs',
    });

    const config = readConfig(configPath);
    expect(config.mounts).toHaveLength(1);
    expect(config.mounts[0]).toMatchObject({
      name: 'lease-taxes',
      path: '/lease-taxes',
      root: folder,
      writeAccess: false,
    });
    const leases = listLeases(leaseStorePath);
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({
      label: 'Sarah - tax docs',
      path: '/lease-taxes',
      permissions: ['read'],
      downloadCount: 0,
    });
    expect(leases[0].expiresAt).toBeTruthy();
    expect(logSpy.mock.calls.flat().join('\n')).toContain('(24h default)');
  });

  it('reuses one internal mount for multiple leases on the same folder', async () => {
    const folder = path.join(tmp, 'Downloads');
    await fs.mkdir(folder);

    await createFolderLease(folder, {
      config: configPath,
      leaseStorePath,
      label: 'Sarah downloads',
      expires: '1h',
    });
    await createFolderLease(folder, {
      config: configPath,
      leaseStorePath,
      label: 'Ben downloads',
      expires: '24h',
    });

    const config = readConfig(configPath);
    expect(config.mounts).toHaveLength(1);
    const leases = listLeases(leaseStorePath);
    expect(leases).toHaveLength(2);
    expect(new Set(leases.map((lease) => lease.path))).toEqual(new Set(['/lease-downloads']));
    expect(leases.map((lease) => lease.label)).toEqual(['Sarah downloads', 'Ben downloads']);
  });

  it('lists and revokes folder leases', async () => {
    const folder = path.join(tmp, 'photos');
    await fs.mkdir(folder);
    await createFolderLease(folder, {
      config: configPath,
      leaseStorePath,
      label: 'Family photos',
      expires: 'never',
    });
    const id = listLeases(leaseStorePath)[0].id;

    await listFolderLeases({ leaseStorePath });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Family photos');

    await revokeFolderLease(id, { leaseStorePath });
    expect(listLeases(leaseStorePath)[0].revokedAt).toBeTruthy();
  });
});
