import { z } from 'zod';

export const TunnelSchema = z.object({
  provider: z.enum(['cloudflare-quick', 'pinggy', 'localhost-run', 'custom']),
  command: z.string().min(1),
  url: z.string().url().optional(),
});

export const ProxySchema = z
  .object({
    name: z.string().min(1),
    source: z.string().optional(),
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

export const PluginSchema = PatternRedactorPluginSchema;

export const ConfigSchema = z.object({
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
});

export type TunnelConfig = z.infer<typeof TunnelSchema>;
export type ProxyConfig = z.infer<typeof ProxySchema>;
export type ObsidianConfig = z.infer<typeof ObsidianSchema>;
export type PatternRedactorPatternConfig = z.infer<typeof PatternRedactorPatternSchema>;
export type PatternRedactorPluginConfig = z.infer<typeof PatternRedactorPluginSchema>;
export type PluginConfig = z.infer<typeof PluginSchema>;
export type MvmtConfig = z.infer<typeof ConfigSchema>;
