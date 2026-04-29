import { MvmtConfig, resolveProxySourceId } from '../config/schema.js';
import { Connector } from '../connectors/types.js';
import { createProxyConnector } from '../connectors/factory.js';
import { Logger } from '../utils/logger.js';

export type LoadedConnector = {
  connector: Connector;
  sourceId: string;
  toolCount: number;
};

export async function initializeConnectors(
  config: MvmtConfig,
  stdioMode: boolean,
  logger: Logger,
): Promise<LoadedConnector[]> {
  const loaded: LoadedConnector[] = [];

  for (const proxyConfig of config.proxy) {
    if (!proxyConfig.enabled) continue;

    const connector = createProxyConnector(proxyConfig);
    if (!connector) {
      emit(`Proxy connector "${proxyConfig.name}" has no command or url. Skipping.`, stdioMode, logger, 'warn');
      continue;
    }

    try {
      await connector.initialize();
      const toolCount = (await connector.listTools()).length;
      loaded.push({ connector, sourceId: resolveProxySourceId(proxyConfig), toolCount });
      emit(`Loaded proxy:${proxyConfig.name} (${toolCount} tools)`, stdioMode, logger);
    } catch (err) {
      emit(
        `Proxy connector "${proxyConfig.name}" failed to start: ${formatConnectorError(err)}`,
        stdioMode,
        logger,
        'warn',
      );
      emit('Skipping proxy. Other connectors are still available.', stdioMode, logger, 'warn');
    }
  }

  return loaded;
}

export function formatConnectorError(err: unknown): string {
  const message = err instanceof Error ? err.message : 'Unknown error';

  try {
    const parsed = JSON.parse(message) as unknown;
    if (Array.isArray(parsed)) {
      const paths = parsed
        .map((issue) => {
          if (!issue || typeof issue !== 'object' || !Array.isArray((issue as { path?: unknown }).path)) {
            return undefined;
          }
          return (issue as { path: Array<string | number> }).path.join('.');
        })
        .filter((path): path is string => Boolean(path));

      if (paths.length > 0) {
        return `upstream server returned invalid MCP schema at ${paths.join(', ')}`;
      }
    }
  } catch {
    // Not a JSON-formatted validation error.
  }

  return message;
}

function emit(
  message: string,
  stdioMode: boolean,
  logger: Logger,
  level: 'info' | 'warn' | 'error' = 'info',
): void {
  if (stdioMode) {
    process.stderr.write(`${message}\n`);
    return;
  }

  if (level === 'warn') logger.warn(message);
  else if (level === 'error') logger.error(message);
  else logger.info(message);
}
