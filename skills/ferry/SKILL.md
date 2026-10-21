---
name: ferry
description: "Move files and data between the operator's own devices (including the Paseo browser) and this server. Use when a Paseo browser download would land on the operator's device instead of the server, when page data (for example window.__x) or fetched pages must reach the server, when the operator wants to upload files to the server from a phone or laptop, or when a file on the server must reach the operator's device. Starts a token-protected, tailnet-only HTTPS receiver with tailscale serve. Not for the public internet, and not for files already on the server."
---

# ferry - move files and data between the operator's devices and the server

Paseo's browser tools (`mcp__paseo__browser_*`) drive a browser on the **operator's device**, not on this server. So:

- A browser download lands on the operator's device, not here.
- An HTTPS page cannot POST to a plain `http://` address on the server (mixed content is blocked).
- Returning big data from `browser_evaluate` floods your context. It is fine for small values only.

ferry fixes this. It runs a small receiver on `127.0.0.1` and exposes it with `tailscale serve`: HTTPS, a valid certificate, tailnet only. Everything sits behind a random token in the URL.

```bash
FERRY=${CLAUDE_SKILL_DIR}/scripts/ferry.py
```

Python 3.9 or later, standard library only. It needs Tailscale on the server (`tailscale serve` must be allowed, with or without `sudo -n`).

## When to use it

- Read many pages in the operator's browser session and keep the results on the server.
- Send data held in a page (a JS variable, a fetched blob) to the server.
- Let the operator drop files from a phone or laptop onto the server (the upload page).
- Hand a file from the server to the operator's device (`share`).

## When not to use it

- The file is already on the server. Just read it.
- Small values. Return them from `browser_evaluate` instead.
- Anything that must be public. ferry is tailnet only. **Never use `tailscale funnel`.**
- DRM-protected content. Out of scope.

## Rules

1. **Only fetch what the operator asked for.** Name the pages or data before you start.
2. **Never read or send cookies, tokens, passwords or account pages.** The fetch snippet uses the page's own session to read a page. It never sends credentials to ferry.
3. **Never add to a cart, buy or submit a form** from the page.
4. **`--dest` is a folder in the git repository the work belongs to.** Never `/tmp`: data in `/tmp` has been lost before. Commit what you keep.
5. **Stop ferry when you are done.** Do not leave it running.
6. Tokens are printed to the terminal only. Do not write the URL into a file, an issue or a commit.

## Workflow

### 1. Start

```bash
python3 $FERRY start --dest <repo>/research/raw            # receive only
python3 $FERRY start --dest <repo>/research/raw --serve-dir <repo>/outbox   # also hand files out
```

It prints the base URL, `https://<host>.ts.net:<port>/<token>`. It picks a free port from 10002 and checks `tailscale serve status` first, so it will not take a port that is in use. If `tailscale serve` is refused, it prints the fix. Options: `--port`, `--idle SECONDS` (default 3600, then it stops itself and turns the port off), `--max-mb` (default 512), `--no-tailscale` (stay on this machine).

### 2. Use it

**From a page in the Paseo browser.** Open the page with `mcp__paseo__browser_new_tab`. Print a ready-made function and pass it to `mcp__paseo__browser_evaluate` (argument `function`):

```bash
python3 $FERRY snippet --url /product/123 --name p123.html      # fetch a URL in the page, send the bytes
python3 $FERRY snippet --var window.__cf --name cf.json         # send a page variable as JSON
```

Run the function as printed. It returns `{ok, status, saved, bytes, sha256}`. Check that `sha256` and `bytes` match what you expect. For many pages, write one loop inside the page and send one file, not one call per page.

**From any device on the tailnet.** Give the operator the upload page, `<base url>/`. They pick or drop files.

**Plain HTTP, for example from curl.**

```bash
curl -sS -X POST --data-binary @file "<base url>/up/<name>"
```

**Server to device.** Needs `--serve-dir` at start.

```bash
python3 $FERRY share path/to/file      # copies it into serve-dir, prints its download URL
```

Give the operator that URL. Add `--link` to symlink instead of copying.

### 3. Check

```bash
python3 $FERRY status                  # running, URL, files received
```

Every request is logged to `<dest>/.ferry-log.jsonl` (time, method, name, bytes, sha256, status, Origin). Never overwrite: a second upload called `a.json` is saved as `a-1.json`. Names are reduced to a safe basename.

### 4. Stop

```bash
python3 $FERRY stop                    # tailscale port off, server stopped, state removed
```

Confirm with `tailscale serve status` that the port is gone. If you started more than one, pass `--port N` or `--all`.

## Troubleshooting

- `tailscale serve` says to use sudo or `--operator`: run `sudo tailscale set --operator=$USER` once, or allow `sudo -n tailscale`.
- A fetch from the page fails with a network error: the device is not on the tailnet, or the token or port is wrong. Run `status`.
- 413: the file is over `--max-mb`. Restart with a higher limit.
- Do not use `pkill -f` with a pattern that appears in your own command line. ferry tracks its process by PID and `stop` handles it.
