# Remote Access

> [!WARNING]
> Remote access is authenticated, but it still exposes your configured local tools beyond your machine. Keep connector scopes narrow before exposing mvmt over a tunnel.

mvmt is local-first and binds to `127.0.0.1`. Cloud clients such as claude.ai or ChatGPT web cannot reach your local machine directly.

`mvmt init` can configure a tunnel. When `mvmt start` runs, mvmt starts the tunnel command, watches its output for a public URL, and prints the MCP URL.

Quick tunnels are temporary. Use a named tunnel or reserved domain if you need the same URL across restarts.

## Built-in tunnel providers

| Provider | Recommendation | Command | Public URL |
| --- | --- | --- | --- |
| Cloudflare Quick Tunnel | Recommended quick provider | `cloudflared tunnel --url http://127.0.0.1:{port}` | `https://random-words.trycloudflare.com/mcp` |
| localhost.run | Fallback, less stable | `ssh -R 80:localhost:{port} nokey@localhost.run` | `https://abc123.lhr.life/mcp` |

Cloudflare requires `cloudflared`. Install it with `brew install cloudflared`.

## Managing tunnels at runtime

If a quick tunnel drops while `mvmt start -i` is running, run `tunnel refresh`. This restarts only the tunnel process; the local mvmt server and bearer token stay the same.

To switch tunnel providers while mvmt is running, run `tunnel config`. mvmt saves the selected tunnel back to `~/.mvmt/config.yaml`.

## Safety guidelines

Use a narrow config before exposing mvmt:

- Read-only filesystem access.
- A low-risk folder or throwaway vault.
- No production secrets in config.
- Stop the tunnel when you are done using remote access.

For a stable URL, use a named tunnel or reserved domain instead of a quick tunnel.
