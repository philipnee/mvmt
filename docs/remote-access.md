# Remote Access

> [!WARNING]
> Tunnel mode is not production remote access. Use it only with narrow scopes, preferably read-only folders or a throwaway vault, and stop the tunnel when testing is done.

mvmt is local-first and binds to `127.0.0.1`. Cloud clients such as claude.ai or ChatGPT web cannot reach your local machine directly.

For a short demo, `mvmt init` can configure a tunnel. When `mvmt start` runs, mvmt starts the tunnel command, watches its output for a public URL, and prints the MCP URL.

## Built-in tunnel providers

| Provider | Recommendation | Command | Public URL |
| --- | --- | --- | --- |
| Cloudflare Quick Tunnel | Recommended for V0 testing | `cloudflared tunnel --url http://127.0.0.1:{port}` | `https://random-words.trycloudflare.com/mcp` |
| localhost.run | Fallback, less stable | `ssh -R 80:localhost:{port} nokey@localhost.run` | `https://abc123.lhr.life/mcp` |

Cloudflare requires `cloudflared`. Install it with `brew install cloudflared`.

## Managing tunnels at runtime

If a free tunnel drops while `mvmt start -i` is running, run `tunnel refresh`. This restarts only the tunnel process; the local mvmt server and bearer token stay the same.

To switch tunnel providers while mvmt is running, run `tunnel config`. mvmt saves the selected tunnel back to `~/.mvmt/config.yaml`.

## Safety guidelines

Tunnel mode is for testing and demos. Use a narrow config before exposing mvmt:

- Read-only filesystem access.
- A throwaway folder or demo vault.
- No production secrets in config.
- Stop the tunnel when the demo is over.

A production remote mode should use a proper relay/OAuth design rather than exposing your local hub directly.
