import { z } from 'zod';

export const TunnelSchema = z.object({
  provider: z.enum(['cloudflare-quick', 'pinggy', 'localhost-run', 'custom']),
  command: z.string().min(1),
  url: z.string().url().optional(),
});

export const ProxySchema = z
  .object({
    // id is the policy-stable identifier used by client permissions and
    // semantic tools. When omitted, name is used. Set id explicitly when
    // you need to rename a proxy without re-mapping policy.
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    source: z.string().optional(), // legacy setup-provenance metadata; runtime ignores it
    transport: z.enum(['stdio', 'http']).default('stdio'),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    url: z.string().min(1).optional(),
    env: z.record(z.string()).default({}),
    writeAccess: z.boolean().optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((data, ctx) => {
    if (data.transport === 'stdio' && !data.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'stdio transport requires "command"',
        path: ['command'],
      });
    }

    if (data.transport === 'http' && !data.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'http transport requires "url"',
        path: ['url'],
      });
    }
  });

export const ObsidianSchema = z.object({
  path: z.string().min(1),
  enabled: z.boolean().default(true),
  writeAccess: z.boolean().default(false),
});

export const PatternRedactorPatternSchema = z
  .object({
    name: z.string().min(1),
    regex: z.string().min(1),
    flags: z.string().regex(/^[dgimsuvy]*$/).default('g'),
    replacement: z.string().min(1),
    enabled: z.boolean().default(true),
  })
  .superRefine((data, ctx) => {
    try {
      new RegExp(data.regex, data.flags.includes('g') ? data.flags : `${data.flags}g`);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : 'Invalid regex',
        path: ['regex'],
      });
    }
  });

export const DEFAULT_PATTERN_REDACTOR_PATTERNS: z.infer<typeof PatternRedactorPatternSchema>[] = [
  {
    name: 'anthropic-keys',
    regex: '\\bsk-ant-[A-Za-z0-9_-]{20,}\\b',
    flags: 'g',
    replacement: '[REDACTED:ANTHROPIC_KEY]',
    enabled: true,
  },
  {
    name: 'openai-keys',
    regex: '\\bsk-[A-Za-z0-9_-]{20,}\\b',
    flags: 'g',
    replacement: '[REDACTED:OPENAI_KEY]',
    enabled: true,
  },
  {
    name: 'aws-access-keys',
    regex: '\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b',
    flags: 'g',
    replacement: '[REDACTED:AWS_ACCESS_KEY]',
    enabled: true,
  },
  {
    name: 'github-tokens',
    regex: '\\b(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,255}|github_pat_[A-Za-z0-9_]{22,255})\\b',
    flags: 'g',
    replacement: '[REDACTED:GITHUB_TOKEN]',
    enabled: true,
  },
  {
    name: 'slack-tokens',
    regex: '\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b',
    flags: 'g',
    replacement: '[REDACTED:SLACK_TOKEN]',
    enabled: true,
  },
  {
    name: 'jwt-looking-strings',
    regex: '\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b',
    flags: 'g',
    replacement: '[REDACTED:JWT]',
    enabled: true,
  },
];

export const PatternRedactorPluginSchema = z.object({
  name: z.literal('pattern-redactor'),
  enabled: z.boolean().default(true),
  mode: z.enum(['warn', 'redact', 'block']).default('redact'),
  maxBytes: z.number().int().min(1024).max(10 * 1024 * 1024).default(1024 * 1024),
  patterns: z.array(PatternRedactorPatternSchema).default(DEFAULT_PATTERN_REDACTOR_PATTERNS),
});

// Single-variant today; kept as a discriminated union so plugin #N lands as
// a schema addition, not a structural refactor of PluginSchema.
export const PluginSchema = z.discriminatedUnion('name', [
  PatternRedactorPluginSchema,
]);

// OBSIDIAN_SOURCE_ID is the conventional source id for the native Obsidian
// connector. Used by client permissions and semantic tool source lists.
export const OBSIDIAN_SOURCE_ID = 'obsidian';

export const PermissionAction = z.enum(['search', 'read', 'write', 'memory_write']);

export const PermissionSchema = z.object({
  sourceId: z.string().min(1),
  actions: z.array(PermissionAction).default([]),
});

export const ClientAuthTokenSchema = z.object({
  type: z.literal('token'),
  // SHA-256 hex hash of the issued bearer token. Plaintext is shown to
  // the operator once at issuance and never persisted.
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/i, 'tokenHash must be a 64-char hex SHA-256'),
});

export const ClientAuthOAuthSchema = z.object({
  type: z.literal('oauth'),
  oauthClientIds: z.array(z.string().min(1)).default([]),
});

export const ClientAuthSchema = z.discriminatedUnion('type', [
  ClientAuthTokenSchema,
  ClientAuthOAuthSchema,
]);

export const ClientSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/, 'client id must be lowercase alphanum/dash/underscore'),
  name: z.string().min(1),
  auth: ClientAuthSchema,
  rawToolsEnabled: z.boolean().default(false),
  permissions: z.array(PermissionSchema).default([]),
});

export const SemanticToolEntrySchema = z.object({
  enabled: z.boolean().default(true),
  sourceIds: z.array(z.string().min(1)).default([]),
});

// SemanticToolsSchema is an object keyed by well-known tool names rather
// than an array, so adding a new semantic tool is a schema addition, not
// a structural change. Keys are camelCase; the runtime tool name is the
// snake_case form (search_personal_context, read_context_item).
export const SemanticToolsSchema = z.object({
  searchPersonalContext: SemanticToolEntrySchema.optional(),
  readContextItem: SemanticToolEntrySchema.optional(),
}).default({});

export const ConfigSchema = z
  .object({
    version: z.literal(1),
    server: z
      .object({
        port: z.number().int().min(1).max(65535).default(4141),
        allowedOrigins: z.array(z.string().min(1)).default([]),
        access: z.enum(['local', 'tunnel']).default('local'),
        tunnel: TunnelSchema.optional(),
      })
      .superRefine((data, ctx) => {
        if (data.access === 'tunnel' && !data.tunnel) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'tunnel access requires "tunnel" config',
            path: ['tunnel'],
          });
        }
      })
      .default({}),
    proxy: z.array(ProxySchema).default([]),
    obsidian: ObsidianSchema.optional(),
    plugins: z.array(PluginSchema).default([]),
    // clients and semanticTools are additive to the v1 schema. When
    // absent, the runtime synthesizes a single default client that maps
    // to the existing session token (preserves pre-PR behavior).
    clients: z.array(ClientSchema).optional(),
    semanticTools: SemanticToolsSchema.optional(),
  })
  .superRefine((data, ctx) => {
    const knownSourceIds = collectKnownSourceIds(data);
    const seenClientIds = new Set<string>();

    for (const [clientIndex, client] of (data.clients ?? []).entries()) {
      if (seenClientIds.has(client.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate client id "${client.id}"`,
          path: ['clients', clientIndex, 'id'],
        });
      } else {
        seenClientIds.add(client.id);
      }

      for (const [permIndex, permission] of client.permissions.entries()) {
        if (!knownSourceIds.has(permission.sourceId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `unknown sourceId "${permission.sourceId}"; configure a proxy or obsidian first`,
            path: ['clients', clientIndex, 'permissions', permIndex, 'sourceId'],
          });
        }
      }
    }

    if (data.semanticTools) {
      for (const [toolKey, tool] of Object.entries(data.semanticTools)) {
        if (!tool) continue;
        for (const [sourceIndex, sourceId] of tool.sourceIds.entries()) {
          if (!knownSourceIds.has(sourceId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `unknown sourceId "${sourceId}"; configure a proxy or obsidian first`,
              path: ['semanticTools', toolKey, 'sourceIds', sourceIndex],
            });
          }
        }
      }
    }
  });

// resolveProxySourceId returns the policy-stable source id for a proxy
// entry (id when set, otherwise name). Exported so policy enforcement
// uses the same lookup the schema validation uses.
export function resolveProxySourceId(proxy: ProxyConfig): string {
  return proxy.id ?? proxy.name;
}

function collectKnownSourceIds(data: { proxy: ProxyConfig[]; obsidian?: ObsidianConfig }): Set<string> {
  const ids = new Set<string>();
  for (const proxy of data.proxy) {
    ids.add(resolveProxySourceId(proxy));
  }
  if (data.obsidian) {
    ids.add(OBSIDIAN_SOURCE_ID);
  }
  return ids;
}

export type TunnelConfig = z.infer<typeof TunnelSchema>;
export type ProxyConfig = z.infer<typeof ProxySchema>;
export type ObsidianConfig = z.infer<typeof ObsidianSchema>;
export type PatternRedactorPatternConfig = z.infer<typeof PatternRedactorPatternSchema>;
export type PatternRedactorPluginConfig = z.infer<typeof PatternRedactorPluginSchema>;
export type PluginConfig = z.infer<typeof PluginSchema>;
export type PermissionConfig = z.infer<typeof PermissionSchema>;
export type ClientAuthConfig = z.infer<typeof ClientAuthSchema>;
export type ClientConfig = z.infer<typeof ClientSchema>;
export type SemanticToolEntryConfig = z.infer<typeof SemanticToolEntrySchema>;
export type SemanticToolsConfig = z.infer<typeof SemanticToolsSchema>;
export type MvmtConfig = z.infer<typeof ConfigSchema>;
