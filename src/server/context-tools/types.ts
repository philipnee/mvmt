import { CallToolResult } from '../../connectors/types.js';
import { PermissionConfig } from '../../config/schema.js';
import { TextContextIndex } from '../../context/text-index.js';
import { ClientIdentity } from '../client-identity.js';

export type PermissionAction = PermissionConfig['actions'][number];
export type ContextToolName = 'search' | 'list' | 'read' | 'write' | 'remove';

export interface NamespacedTool {
  namespacedName: string;
  originalName: string;
  connectorId: string;
  sourceId: string;
  requiredAction: PermissionAction;
  toolKind: 'semantic';
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ContextToolAccess {
  allowedMounts(action: PermissionAction, requestedMountNames?: string[]): string[];
  pathAllowed(inputPath: string, action: PermissionAction): boolean;
  pathMayExposeEntry(inputPath: string, action: PermissionAction): boolean;
}

export interface ContextToolHandlerContext {
  index: TextContextIndex;
  identity?: ClientIdentity;
  access: ContextToolAccess;
}

export interface ContextToolModule {
  name: ContextToolName;
  definition: NamespacedTool;
  handle(args: Record<string, unknown>, context: ContextToolHandlerContext): Promise<CallToolResult>;
}
