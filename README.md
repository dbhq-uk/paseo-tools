# paseo-tools

Three tools that fix things [Paseo](https://paseo.sh) does not do on its own. A free, open-source collection by [DBHQ](https://dbhq.uk).

| Name | What it does | Kind |
| --- | --- | --- |
| [**ferry**](skills/ferry/README.md) | Moves files and data between your devices, including the Paseo browser, and the server | Agent skill |
| [**file-viewer**](plugins/file-viewer/README.md) | Opens PDFs, images, Word documents and spreadsheets inside Paseo | Paseo plugin |
| [**secrets**](plugins/secrets/README.md) | The password box: an agent asks for a secret, you type it into a masked box, and it never goes in the chat | Paseo plugin |

## Why these exist

Paseo's browser runs on your own device, not on the server the agent works on, and Paseo's files panel only shows text. That leaves gaps: a download lands on the wrong machine, a contract shows as binary noise, and the only way to give an agent an API key is to paste it into the chat. Each tool closes one of those gaps.

## ferry

Moves things between your devices and the server.

- **Use it when** a Paseo browser download would land on your device and not the server, when page data has to reach the server, when you want to upload files from a phone or laptop, or when a file on the server has to reach your device.
- **How:** a small receiver on `127.0.0.1`, published over HTTPS to your tailnet only with `tailscale serve`, behind a random token. Never the public internet.
- **Needs:** Python 3.9 or later, and Tailscale on the server.
- **Install:** run `./install.sh` from a clone, or install this repository as a Claude Code plugin (below). Agents then use it when you ask to move a file or data.

## file-viewer

A Viewer panel in the workspace for the files Paseo shows as binary noise.

- **Opens:** PDFs (page images, with zoom), images (including SVG and AVIF), Word `.docx` (reflowable text) and Excel `.xlsx` (sheet picker and scrollable table).
- **Needs:** Paseo 0.8 or later, and `poppler-utils`, `imagemagick` and `librsvg2-bin` on the server.
- **Install:** `paseo plugin install github:dbhq-uk/paseo-tools:plugins/file-viewer`. Open it from the workspace sidebar, or search "Open file viewer" in the Command Center.

## secrets

The password box. When an agent needs an API key or a password, it asks for it. A masked box appears in the agent's timeline, you type the value, and it is stored where the agent can read it. The value never goes through the chat, a tool result or the agent's context.

- **Where it is kept:** in a RAM-backed folder on the server by default, so it is not written to disk and is gone after a reboot. Set `PASEO_SECRETS_STORE=disk` to keep it across reboots. It does not use a password manager; an agent that keeps secrets in one can move the file there itself.
- **Needs:** Paseo 0.12 or later. Only new Claude agents get the tools; agents that already exist need recreating.
- **Install:** `paseo plugin install github:dbhq-uk/paseo-tools:plugins/secrets`.
- An agent can still print a secret it has read. The plugin makes sure the value never travels through chat, and tells agents not to print it.

## Install

**The skill (ferry).** As a Claude Code plugin:

```
/plugin marketplace add dbhq-uk/paseo-tools
/plugin install paseo-tools
```

Or from a clone, as live symlinks into your personal Claude Code skills folder:

```bash
git clone https://github.com/dbhq-uk/paseo-tools.git
cd paseo-tools
./install.sh
```

**The plugins (file-viewer, secrets).** Plugins must be enabled on the daemon (**Settings, Plugins**, or `pluginsEnabled: true` in `~/.paseo/config.json`). Paseo plugins are trusted, unsandboxed code, so read the source first. Then use the command in each section above, or install from a clone:

```bash
cd paseo-tools/plugins/secrets && npm install && paseo plugin install "$(pwd)"
cd ../file-viewer && npm install && paseo plugin install "$(pwd)"
paseo plugin ls        # both should say "running"
```

To update from a clone, `git pull`, run `npm install` in the plugin's folder if its `package.json` changed, then `paseo plugin reload <id>`.

## Develop

```bash
python3 -m pytest skills                       # ferry: tests, no network
ruff check . && ruff format --check .
cd plugins/file-viewer && npm ci && npm run typecheck && npm test
cd plugins/secrets && npm ci && npm run typecheck && npm test
```

See [AGENTS.md](AGENTS.md) for the rules this repository follows, and the [issues](https://github.com/dbhq-uk/paseo-tools/issues) for what is planned.

## Licence

[MIT](LICENSE)
