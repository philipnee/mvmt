# Plugins

A plugin is a post-processing hook for tool results.

Connectors fetch or compute data. Plugins inspect the result before mvmt returns it to the MCP client.

In v0, plugins are compiled into mvmt. They are not dynamic npm packages and mvmt does not load arbitrary plugin code from disk.

## What a plugin can do

A plugin can:

- Inspect the connector ID, tool name, original tool name, arguments, and result.
- Leave the result unchanged.
- Add warnings to the result.
- Transform text or image content.
- Block the result and return an MCP error.
- Add audit metadata that explains what happened.

A plugin should not:

- Expand connector scope.
- Bypass auth, Origin checks, write gates, or audit logging.
- Call arbitrary external services by default.
- Pretend to be a full privacy or compliance layer.

## Current plugin

`pattern-redactor` is the only built-in plugin.

It scans text tool results with configured regex patterns and can run in three modes:

- `warn` — report matches but return the original result.
- `redact` — replace matches with configured replacement strings.
- `block` — block the entire tool result.

> [!WARNING]
> The pattern-based redactor is best-effort defense-in-depth, not a security control. It will miss data that does not match configured patterns and may redact things you did not intend. Do not rely on it for compliance, privacy, or security requirements.

## Plugin interface

Plugins implement `ToolResultPlugin` from `src/plugins/types.ts`.

```ts
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
  process(
    context: ToolResultPluginContext
  ): Promise<ToolResultPluginOutput> | ToolResultPluginOutput;
}
```

`toolName` is the namespaced tool name visible to clients, such as `obsidian__read_note`.

`originalName` is the connector-local tool name, such as `read_note`.

## How plugins run

The request pipeline is:

```text
client -> auth/origin -> write gate -> router -> connector -> plugins -> audit log -> client
```

Plugins run after connector execution and before the final response is returned.

If multiple plugins are enabled, they run in factory order. Each plugin receives the previous plugin's output.

## How to add a plugin

1. Add a plugin class under `src/plugins/`.
2. Implement `ToolResultPlugin`.
3. Add config schema in `src/config/schema.ts`.
4. Register the plugin in `src/plugins/factory.ts`.
5. Add setup prompts in `src/cli/init.ts` if users should configure it interactively.
6. Add config docs in `docs/configuration.md`.
7. Add README docs if users need to understand the behavior before enabling it.
8. Add tests for pass-through, transform, block, audit events, large outputs, and disabled config.

## Minimal plugin skeleton

```ts
import { ToolResultPlugin, ToolResultPluginContext, ToolResultPluginOutput } from './types.js';

export class ExamplePlugin implements ToolResultPlugin {
  readonly id = 'example-plugin';
  readonly displayName = 'example plugin';

  process(context: ToolResultPluginContext): ToolResultPluginOutput {
    return {
      result: {
        ...context.result,
        content: [
          ...context.result.content,
          {
            type: 'text',
            text: `mvmt example plugin inspected ${context.toolName}.`,
          },
        ],
      },
      auditEvents: [],
    };
  }
}
```

## Audit expectations

If a plugin changes behavior in a way a user may need to debug, it should write an audit event.

Examples:

- A redactor matched `openai-key` twice.
- A policy plugin blocked `proxy_filesystem__read_file`.
- A size-limit plugin truncated a result.

Audit metadata should explain what happened without logging full sensitive values.

## Design rule

Plugins are defense-in-depth. They are not the primary permission model.

The primary security model is still:

- exact connector scope,
- read-only defaults,
- explicit write access,
- localhost bind,
- bearer/OAuth gates,
- Origin checks,
- env scrubbing,
- audit logging.

If a user does not want a client to see a class of data, the right fix is to not expose that data through a connector.
