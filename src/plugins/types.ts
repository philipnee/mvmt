import { CallToolResult } from '../connectors/types.js';

export type PluginMode = 'warn' | 'redact' | 'block';

export interface PatternRedactorAuditEvent {
  pluginId: string;
  mode: PluginMode;
  matches: Array<{ pattern: string; count: number }>;
  truncated?: boolean;
}

export interface ToolResultPluginContext {
  connectorId: string;
  toolName: string;
  originalName: string;
  args: Record<string, unknown>;
  result: CallToolResult;
}

export interface ToolResultPluginOutput {
  result: CallToolResult;
  auditEvents?: PatternRedactorAuditEvent[];
}

export interface ToolResultPlugin {
  readonly id: string;
  readonly displayName: string;
  process(context: ToolResultPluginContext): Promise<ToolResultPluginOutput> | ToolResultPluginOutput;
}
