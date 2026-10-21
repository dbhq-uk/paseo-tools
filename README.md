# paseo-tools

Skills, plugins and tools for working with [Paseo](https://paseo.sh) agents and its remote browser.

A free, open-source collection by [DBHQ](https://dbhq.uk).

## What is in it

| Name | Kind | What it does |
| --- | --- | --- |
| [ferry](skills/ferry/README.md) | Skill | Moves files and data between the operator's devices, including the Paseo browser, and the server. Token-protected, tailnet-only HTTPS. |
| [file-viewer](plugins/file-viewer/README.md) | Paseo plugin | A Viewer panel for PDFs, images, Word documents and spreadsheets, which Paseo's files panel shows as binary noise. |

More will follow. The layout keeps each kind in its own folder:

```
skills/<name>/     agent skills (SKILL.md, scripts, tests)
plugins/<name>/    Paseo plugins (paseo-plugin.json, client and server code)
```

## Why this exists

Paseo's browser runs on the operator's own device, not on the server the agent works on. That breaks the obvious things: a download lands on the wrong machine, and an HTTPS page cannot post to a plain-HTTP address. These tools close those gaps.

## Install the skills

Claude Code, as a plugin:

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

The skills use Python 3.9 or later and the standard library only. Nothing else to install.

Paseo plugins are installed with `paseo plugin install`. See each plugin's README.

## Develop

```bash
python3 -m pytest skills        # skill tests, no network
ruff check . && ruff format --check .
cd plugins/file-viewer && npm ci && npm run typecheck && npm test
```

See [AGENTS.md](AGENTS.md) for the rules this repository follows.

## Licence

[MIT](LICENSE)
