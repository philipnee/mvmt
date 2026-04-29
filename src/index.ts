export { doctor, collectDoctorReport } from './cli/doctor.js';
export type { DoctorOptions, DoctorReport, DoctorStatus } from './cli/doctor.js';
export { printConfigSummary, runConfigSetup, showConfig } from './cli/config.js';
export type { ConfigCommandOptions, ConfigSummaryRuntime } from './cli/config.js';
export { setupConfig } from './cli/init.js';
export { start } from './cli/start.js';
export type { StartOptions } from './cli/start.js';
export {
  configureTunnel,
  printMissingTunnelDependencyWarning,
  promptForTunnelConfig,
  refreshTunnelCommand,
  showTunnel,
  showTunnelLogs,
  startTunnelCommand,
  stopTunnelCommand,
  streamTunnelLogs,
} from './cli/tunnel.js';
export type { TunnelCommandOptions, TunnelRuntimeStatus } from './cli/tunnel.js';
export { printTokenSummary, readTokenSummary, rotateToken, showToken, showTokenSummary } from './cli/token.js';
export type { TokenSummary } from './cli/token.js';
export { ConfigSchema, LocalFolderMountSchema, TunnelSchema } from './config/schema.js';
export {
  DEFAULT_PATTERN_REDACTOR_PATTERNS,
  PatternRedactorPatternSchema,
  PatternRedactorPluginSchema,
  PluginSchema,
} from './config/schema.js';
export type {
  MvmtConfig,
  LocalFolderMountConfig,
  PatternRedactorPatternConfig,
  PatternRedactorPluginConfig,
  PluginConfig,
  TunnelConfig,
} from './config/schema.js';
export { configExists, expandHome, getConfigPath, loadConfig, parseConfig, readConfig, resolveConfigPath, saveConfig } from './config/loader.js';

export type { CallToolResult } from './connectors/types.js';
export { createMcpServer, startHttpServer, startStdioServer } from './server/index.js';
export type { HttpServerOptions, StartedHttpServer } from './server/index.js';
export { ToolRouter } from './server/router.js';
export type { NamespacedTool } from './server/router.js';
export { createPlugins } from './plugins/factory.js';
export { PatternRedactorPlugin } from './plugins/pattern-redactor.js';
export type {
  PatternRedactorAuditEvent,
  PluginMode,
  ToolResultPlugin,
  ToolResultPluginContext,
  ToolResultPluginOutput,
} from './plugins/types.js';
export { getControlSocketPath, sendJsonControlRequest, startJsonControlServer, streamJsonControl } from './utils/control.js';
