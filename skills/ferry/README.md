# ferry

Move files and data between the operator's devices and the server, through Paseo's remote browser.

## The problem

Paseo's browser runs on the operator's own device. A download lands there, and an HTTPS page cannot POST to a plain-HTTP address on the server. ferry gives the page an HTTPS address that works.

## How it works

- A receiver listens on `127.0.0.1` only.
- `tailscale serve` publishes it over HTTPS with a valid certificate, on the tailnet only. ferry never uses `tailscale funnel`.
- Every path starts with a random token. A wrong or missing token gets a 404.

## HTTP API

| Request | Result |
| --- | --- |
| `POST /<token>/up/<name>` | Saves the body to `dest/<safe name>`. Never overwrites. Replies with the saved name, bytes and sha256. |
| `GET /<token>/` | An upload page with a file picker and drag and drop. |
| `GET /<token>/down/<name>` | Downloads a file from `--serve-dir`. Read-only. |
| `OPTIONS` (any path) | 204 with the CORS and Private-Network headers. |

Every request goes to `dest/.ferry-log.jsonl`. After `--idle` seconds with no traffic (default 3600) the server stops and turns its `tailscale serve` port off.

## Commands

```
ferry.py start --dest DIR [--port N] [--serve-dir DIR] [--idle S] [--max-mb N] [--no-tailscale]
ferry.py snippet --name NAME (--url URL | --var EXPR)
ferry.py share FILE [--link]
ferry.py status
ferry.py stop [--port N | --all]
```

State (PID, port, token, folders) is kept in `${XDG_STATE_HOME:-~/.local/state}/ferry/`, with owner-only permissions.

## Tests

```
cd skills/ferry && python3 -m pytest tests
```

They use `--no-tailscale` and an ephemeral port. No network, no Tailscale.
