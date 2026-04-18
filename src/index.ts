export { doctor, collectDoctorReport } from './cli/doctor.js';
export type { DoctorOptions, DoctorReport, DoctorStatus } from './cli/doctor.js';
export { init, buildConfig, countNotes, detectObsidianVaults } from './cli/init.js';
export { start } from './cli/start.js';
export type { StartOptions } from './cli/start.js';
export { rotateToken, showToken } from './cli/token.js';
export { ConfigSchema, ObsidianSchema, ProxySchema, TunnelSchema } from './config/schema.js';
export {
  DEFAULT_PATTERN_REDACTOR_PATTERNS,
  PatternRedactorPatternSchema,
  PatternRedactorPluginSchema,
  PluginSchema,
} from './config/schema.js';
export type {
  MvmtConfig,
  ObsidianConfig,
  PatternRedactorPatternConfig,
  PatternRedactorPluginConfig,
  PluginConfig,
  ProxyConfig,
  TunnelConfig,
} from './config/schema.js';
export { expandHome, getConfigPath, loadConfig, parseConfig } from './config/loader.js';
export { ObsidianConnector, extractTags } from './connectors/obsidian.js';
export { createProxyConnector } from './connectors/factory.js';
export type { CallToolResult, Connector, ToolDefinition } from './connectors/types.js';
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
