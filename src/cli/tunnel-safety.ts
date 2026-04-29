import { MvmtConfig } from '../config/schema.js';

export const LEGACY_TUNNEL_OVERRIDE_ENV = 'MVMT_ALLOW_LEGACY_TUNNEL';

export function tunnelExposureError(config: MvmtConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (config.server.access !== 'tunnel') return undefined;
  if ((config.clients?.length ?? 0) > 0) return undefined;
  if (legacyTunnelOverrideEnabled(env)) return undefined;
  return [
    'Tunnel access requires clients[] so remote MCP requests resolve to named, scoped clients.',
    `Set ${LEGACY_TUNNEL_OVERRIDE_ENV}=1 only for a temporary unsafe legacy tunnel.`,
  ].join(' ');
}

export function legacyTunnelOverrideEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[LEGACY_TUNNEL_OVERRIDE_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}
