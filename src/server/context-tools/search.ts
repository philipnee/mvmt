import { jsonResult, normalizeLimit, optionalStringArray, requireString } from './helpers.js';
import { ContextToolModule } from './types.js';

export const searchTool: ContextToolModule = {
  name: 'search',
  definition: {
    namespacedName: 'search',
    originalName: 'search',
    connectorId: 'mvmt',
    sourceId: 'mvmt',
    requiredAction: 'search',
    toolKind: 'semantic',
    description: 'Search permitted text-file mounts and return ranked chunks from the local index.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword or phrase to search for' },
        mounts: { type: 'array', items: { type: 'string' }, description: 'Optional mount names to search' },
        limit: { type: 'number', description: 'Maximum total results. Default 8, max 20' },
      },
      required: ['query'],
    },
  },
  async handle(args, { index, access }) {
    const query = requireString(args.query, 'query');
    const requested = optionalStringArray(args.mounts);
    const mountNames = access.allowedMounts('search', requested);
    const limit = normalizeLimit(args.limit);
    return jsonResult({
      query,
      ranking: 'prototype_keyword_count',
      results: (await index.search(query, mountNames, limit))
        .filter((entry) => access.pathAllowed(entry.path, 'search')),
    });
  },
};
