# Plugins

A plugin is a post-processing hook for tool results.

Mount tools fetch local data. Plugins inspect or transform the result before mvmt returns it to the MCP client.

In v0, plugins are compiled into mvmt. mvmt does not load arbitrary plugin code from disk.

## What a Plugin Can Do

A plugin can:

- inspect the runtime id, tool name, arguments, and result;
- leave the result unchanged;
- add warnings to the result;
- transform text or image content;
- block the result and return an MCP error;
- add audit metadata.

A plugin should not:

- expand mount scope;
- bypass auth, Origin checks, mount write gates, client policy, or audit logging;
- call external services by default;
- pretend to be a full privacy or compliance layer.

## Current Plugin

`pattern-redactor` is the only built-in plugin.

It scans text tool results with configured regex patterns and can run in three modes:

| Mode | Behavior |
| --- | --- |
| `warn` | Records matches but returns the original result. |
| `redact` | Replaces matches with configured replacement strings. |
| `block` | Blocks the entire tool result. |

> [!WARNING]
> Pattern redaction is best-effort defense in depth. It can miss sensitive data and can redact harmless data. Use mounts and client permissions as the primary security boundary.

## Interface

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

For the current mount tools:

- `connectorId` is `mvmt`;
- `toolName` is one of `search`, `list`, `read`, `write`, `remove`;
- `originalName` is the same as `toolName`.

## Pipeline

```text
client -> auth/origin -> client policy -> router -> mount provider -> plugins -> audit log -> client
```

Plugins run after the tool has produced a result and before the result is returned.

If multiple plugins are enabled, they run in factory order. Each plugin receives the previous plugin's output.

## Add a Plugin

1. Add a plugin class under `src/plugins/`.
2. Implement `ToolResultPlugin`.
3. Add config schema in `src/config/schema.ts`.
4. Register the plugin in `src/plugins/factory.ts`.
5. Add setup prompts if users should configure it interactively.
6. Add tests for pass-through, transform, block, audit events, large outputs, and disabled config.
7. Update `docs/configuration.md` and this file.

## Design Rule

Plugins are not the permission model.

If a client must not see a class of data, do not mount that data for the client. Use plugin redaction only as an additional guardrail.
