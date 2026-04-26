# Audit Log

Every tool call routed through mvmt is appended to `~/.mvmt/audit.log` as JSONL. mvmt creates the file with mode `600` (owner-only read/write).

> [!WARNING]
> `argPreview` can include truncated argument values. Do not store secrets in tool arguments unless you are comfortable with those values appearing in `~/.mvmt/audit.log`.

## Log format

Each tool call appends one JSON object:

```json
{
  "ts": "2026-04-14T14:23:01.442Z",
  "connectorId": "obsidian",
  "tool": "obsidian__search_notes",
  "clientId": "chatgpt",
  "argKeys": ["query", "maxResults"],
  "argPreview": "{\"query\":\"meeting notes\",\"maxResults\":10}",
  "redactions": [
    {
      "pluginId": "pattern-redactor",
      "mode": "redact",
      "pattern": "openai-keys",
      "count": 1
    }
  ],
  "isError": false,
  "durationMs": 34
}
```

| Field | Description |
| --- | --- |
| `ts` | ISO 8601 timestamp. |
| `connectorId` | Which connector handled the call (e.g. `obsidian`, `proxy_filesystem`). |
| `tool` | The namespaced tool name the MCP client used. |
| `clientId` | Present when HTTP auth resolved to a configured or legacy client identity. |
| `argKeys` | Argument key names, without values. |
| `argPreview` | Truncated JSON of the arguments (max 512 characters). Can contain values. |
| `redactions` | Present when `pattern-redactor` matched. Records the plugin, mode, pattern name, and match count. |
| `isError` | `true` if the connector returned an error or the call threw. |
| `deniedReason` | Present when mvmt denied a tool call before it reached a connector. |
| `durationMs` | Time from call start to result, in milliseconds. |

## Querying the log

View recent activity:

```bash
tail -20 ~/.mvmt/audit.log | jq .
```

Filter by connector:

```bash
jq 'select(.connectorId == "obsidian")' ~/.mvmt/audit.log
```

Count tool calls per connector:

```bash
jq -r '.connectorId' ~/.mvmt/audit.log | sort | uniq -c | sort -rn
```

## Log rotation

mvmt never truncates or rotates the audit log. To archive it manually:

```bash
mv ~/.mvmt/audit.log ~/.mvmt/audit.log.bak
```

mvmt creates a new log on the next tool call.
