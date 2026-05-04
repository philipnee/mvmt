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

  it('describes agent trigger behavior for the built-in tools', () => {
    const descriptions = new Map(CONTEXT_TOOLS.map((tool) => [tool.name, tool.definition.description]));

    expect(descriptions.get('search')).toContain('Use first when the user asks about their own notes');
    expect(descriptions.get('list')).toContain('For topic/content questions, use search first');
    expect(descriptions.get('read')).toContain('Use after search or list');
    expect(descriptions.get('write')).toContain('Use only when the user explicitly asks');
    expect(descriptions.get('remove')).toContain('Use only when the user explicitly asks');
  });
});
