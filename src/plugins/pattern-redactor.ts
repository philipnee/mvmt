import {
  DEFAULT_PATTERN_REDACTOR_PATTERNS,
  PatternRedactorPatternConfig,
  PatternRedactorPluginConfig,
} from '../config/schema.js';
import { CallToolResult, TextToolContent } from '../connectors/types.js';
import { ToolResultPlugin, ToolResultPluginContext, ToolResultPluginOutput } from './types.js';

interface CompiledPattern {
  name: string;
  regex: RegExp;
  replacement: string;
}

interface PatternMatchSummary {
  pattern: string;
  count: number;
}

interface RedactTextResult {
  text: string;
  matches: PatternMatchSummary[];
  truncated: boolean;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;

export class PatternRedactorPlugin implements ToolResultPlugin {
  readonly id = 'pattern-redactor';
  readonly displayName = 'pattern-based redactor';

  private readonly mode: PatternRedactorPluginConfig['mode'];
  private readonly maxBytes: number;
  private readonly patterns: CompiledPattern[];

  constructor(config: Partial<PatternRedactorPluginConfig> = {}) {
    this.mode = config.mode ?? 'redact';
    this.maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
    this.patterns = (config.patterns ?? DEFAULT_PATTERN_REDACTOR_PATTERNS)
      .filter((pattern) => pattern.enabled !== false)
      .map(compilePattern);
  }

  process(context: ToolResultPluginContext): ToolResultPluginOutput {
    const redacted = context.result.content.map((item) => {
      if (item.type !== 'text') return { item, matches: [], truncated: false };
      const result = this.redactText(item.text);
      return {
        item: { ...item, text: result.text } satisfies TextToolContent,
        matches: result.matches,
        truncated: result.truncated,
      };
    });

    const matches = mergeMatches(redacted.flatMap((entry) => entry.matches));
    const truncated = redacted.some((entry) => entry.truncated);
    if (matches.length === 0) {
      return {
        result: this.withScanNotice(context.result, truncated),
        auditEvents: [],
      };
    }

    const auditEvent = {
      pluginId: this.id,
      mode: this.mode,
      matches,
      truncated,
    };

    if (this.mode === 'block') {
      return {
        result: {
          content: [
            {
              type: 'text',
              text: `Blocked by mvmt pattern-redactor: ${formatMatches(matches)} matched ${context.toolName}.`,
            },
          ],
          isError: true,
        },
        auditEvents: [auditEvent],
      };
    }

    const content =
      this.mode === 'warn'
        ? context.result.content
        : redacted.map((entry) => entry.item);

    return {
      result: {
        ...context.result,
        content: [
          ...content,
          {
            type: 'text',
            text:
              this.mode === 'warn'
                ? `mvmt pattern-redactor warning: ${formatMatches(matches)} matched but output was not changed.`
                : `mvmt pattern-redactor: redacted ${formatMatches(matches)}.`,
          },
          ...(truncated
            ? [
                {
                  type: 'text' as const,
                  text: `mvmt pattern-redactor: output exceeded ${this.maxBytes} bytes; only the first ${this.maxBytes} bytes of each text item were scanned.`,
                },
              ]
            : []),
        ],
      },
      auditEvents: [auditEvent],
    };
  }

  private redactText(text: string): RedactTextResult {
    const scanned = text.slice(0, this.maxBytes);
    const suffix = text.slice(this.maxBytes);
    const counts = new Map<string, number>();
    let output = scanned;

    for (const pattern of this.patterns) {
      pattern.regex.lastIndex = 0;
      output = output.replace(pattern.regex, (match) => {
        counts.set(pattern.name, (counts.get(pattern.name) ?? 0) + 1);
        if (this.mode === 'warn' || this.mode === 'block') return match;
        return pattern.replacement;
      });
    }

    return {
      text: output + suffix,
      matches: [...counts.entries()].map(([pattern, count]) => ({ pattern, count })),
      truncated: suffix.length > 0,
    };
  }

  private withScanNotice(result: CallToolResult, truncated: boolean): CallToolResult {
    if (!truncated) return result;
    return {
      ...result,
      content: [
        ...result.content,
        {
          type: 'text',
          text: `mvmt pattern-redactor: output exceeded ${this.maxBytes} bytes; only the first ${this.maxBytes} bytes of each text item were scanned.`,
        },
      ],
    };
  }
}

function compilePattern(pattern: PatternRedactorPatternConfig): CompiledPattern {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return {
    name: pattern.name,
    regex: new RegExp(pattern.regex, flags),
    replacement: pattern.replacement,
  };
}

function mergeMatches(matches: PatternMatchSummary[]): PatternMatchSummary[] {
  const counts = new Map<string, number>();
  for (const match of matches) {
    counts.set(match.pattern, (counts.get(match.pattern) ?? 0) + match.count);
  }
  return [...counts.entries()]
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => a.pattern.localeCompare(b.pattern));
}

function formatMatches(matches: PatternMatchSummary[]): string {
  return matches.map((match) => `${match.pattern}(${match.count})`).join(', ');
}
