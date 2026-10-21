# AGENTS.md

Guidance for AI agents (and people) working in this repository.

## What this is

**paseo-tools** holds skills, Paseo plugins and tools for working with Paseo agents and its remote browser. It is a collection, not one product: each item stands alone and a new one must fit beside the others without changing them.

Paseo's browser tools (`mcp__paseo__browser_*`) drive a browser on the operator's own device, not on the server. That one fact explains most of what is here.

## Layout

```
.claude-plugin/plugin.json          Claude Code plugin manifest (no version field)
skills/<name>/SKILL.md              the skill, written for the agent
skills/<name>/README.md             the skill, written for people
skills/<name>/scripts/              the code, standard library only
skills/<name>/tests/                pytest, no network
plugins/<name>/                     Paseo plugins, each a Node project with its own paseo-plugin.json,
                                    package.json and lockfile. CI: one workflow per plugin, path-filtered
.github/workflows/<name>.yml        the workflow for plugins/<name>/
install.sh                          symlinks every skills/<name>/ into ~/.claude/skills/
pyproject.toml                      ruff config for every skill
.github/workflows/validate.yml      CI
```

## Adding a skill

1. Create `skills/<name>/` with `SKILL.md` (frontmatter `name` must equal the directory), `README.md`, `scripts/` and `tests/`.
2. Add `<name>` to `known-first-party` in `pyproject.toml`.
3. Add a row to the table in `README.md`.
4. CI discovers `skills/*/tests` and `skills/*/scripts/*.sh` by itself. Add a bare-copy and an installer check to `validate.yml` if the skill has a CLI.

## Rules that must not be broken

- **Standard library only.** A skill must run from a bare copy of its directory, because `/plugin install` and `npx skills add` copy it and run nothing. CI has a job that proves it.
- **Python floor is 3.9.** Keep `from __future__ import annotations`. Ruff targets `py39`.
- **Braced skill paths.** `SKILL.md` names its own files as `${CLAUDE_SKILL_DIR}/...`. Never hardcode `~/.claude/skills`. CI fails on it.
- **No version in `plugin.json`.** The commit is the version.
- **No secrets in the tree.** Tokens are printed to the terminal only. No tokens, URLs with tokens or email addresses in docs, tests, logs or commits.
- **House style.** British English, plain hyphens, never an em or en dash (CI fails on them), no full stop at the end of a heading.

## Adding a Paseo plugin

Put it in `plugins/<name>/` with `paseo-plugin.json` at its root (see the `paseo-plugin` skill and https://paseo.sh/docs/plugins). Give it its own workflow in `.github/workflows/`, filtered to its folder, with actions pinned by SHA and `permissions: contents: read`. Add an npm entry for its folder to `.github/dependabot.yml`, and a row to the table in `README.md`. A plugin is trusted, unsandboxed code: say what it reads and runs in its README.

`plugins/file-viewer` came from `dbhq-uk/paseo-file-viewer` with its history (a subtree import). That repository is not touched by this one.

## ferry

`skills/ferry/scripts/ferry.py` is a receiver bound to `127.0.0.1`, published only by `tailscale serve`. These are the lines not to cross:

- **Bind to `127.0.0.1` only.** Exposure is `tailscale serve` and nothing else.
- **Never `tailscale funnel`.** `run_tailscale` only allows `serve` and `status`, and a test holds it.
- **The token gates every path.** A wrong or missing token is a 404. The token is never logged and never put in a file other than the owner-only state file.
- **Never overwrite.** An upload that would clash gets `-1`, `-2` and so on.
- **Names are sanitised to a flat basename.** Downloads are flat too, read-only, and cannot reach dotfiles.
- **Everything stops.** The server stops itself after the idle time and turns its tailscale port off. Tests and live checks end with `stop`.
- Track the process by PID file. `pkill -f <pattern>` inside a command that contains the pattern kills the caller.

`SKILL.md` is loaded into the agent's context every time, so it holds instructions only. Reasons live here or in commit messages.
