import { describe, expect, it } from 'vitest';
import { CONTEXT_TOOLS } from '../src/server/context-tools/index.js';

describe('context tool registry', () => {
  it('registers the canonical tool surface in display order', () => {
    expect(CONTEXT_TOOLS.map((tool) => tool.name)).toEqual([
      'search',
      'list',
      'read',
      'write',
      'remove',
    ]);
    expect(CONTEXT_TOOLS.map((tool) => tool.definition.namespacedName)).toEqual([
      'search',
      'list',
      'read',
      'write',
      'remove',
    ]);
  });
});
