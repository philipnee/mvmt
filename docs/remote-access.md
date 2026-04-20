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
| Cloudflare Named Tunnel | Recommended stable provider | `cloudflared tunnel --config ~/.cloudflared/mvmt.yml run` | `https://you.example.com/mcp` |
| localhost.run | Fallback, less stable | `ssh -R 80:localhost:{port} nokey@localhost.run` | `https://abc123.lhr.life/mcp` |
| Custom command | Advanced escape hatch | Any command that forwards public HTTPS to `127.0.0.1:{port}` | Depends on your provider |

Cloudflare requires `cloudflared`. Install it with `brew install cloudflared`.

For a stable Cloudflare hostname, create a named tunnel and DNS route first, then choose **Cloudflare Named Tunnel** in `mvmt init` or interactive `tunnel config`. mvmt asks for:

- the `cloudflared` config file path,
- the public base URL, such as `https://pnee.gofrieda.org`.

mvmt stores that as a `custom` tunnel because Cloudflare named tunnels are user-managed local config files.

## Managing tunnels at runtime

If a quick tunnel drops while `mvmt start -i` is running, run `tunnel refresh`. This restarts only the tunnel process; the local mvmt server and bearer token stay the same.

To switch tunnel providers while mvmt is running, run `tunnel config`. mvmt saves the selected tunnel back to `~/.mvmt/config.yaml`. The same menu supports quick tunnels, Cloudflare named tunnels, and raw custom commands.

## Safety guidelines

Use a narrow config before exposing mvmt:

- Read-only filesystem access.
- A low-risk folder or throwaway vault.
- No production secrets in config.
- Stop the tunnel when you are done using remote access.

For a stable URL, use a named tunnel or reserved domain instead of a quick tunnel.
