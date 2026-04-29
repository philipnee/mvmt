import { accessDeniedResult, jsonResult, optionalString } from './helpers.js';
import { ContextToolModule } from './types.js';

export const listTool: ContextToolModule = {
  name: 'list',
  definition: {
    namespacedName: 'list',
    originalName: 'list',
    connectorId: 'mvmt',
    sourceId: 'mvmt',
    requiredAction: 'read',
    toolKind: 'semantic',
    description: 'List permitted mounts or a directory within one mount.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional path such as /workspace or /workspace/docs' },
      },
    },
  },
  async handle(args, { index, access }) {
    const inputPath = optionalString(args.path) ?? '/';
    const mountName = inputPath === '/' ? undefined : index.mountNameForPath(inputPath);
    if (mountName && !access.pathMayExposeEntry(inputPath, 'read')) {
      return accessDeniedResult(`missing_permission path=${inputPath} action=read`);
    }
    const entries = await index.list(inputPath);
    return jsonResult({
      path: inputPath,
      entries: entries.filter((entry) => access.pathMayExposeEntry(entry.path, 'read')),
    });
  },
};
