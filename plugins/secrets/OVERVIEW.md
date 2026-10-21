Lets an agent ask you for a secret without you pasting it into the chat.

When an agent needs an API key or a password, it calls a `request_secret` tool. A masked box appears in the agent's timeline in the Paseo app. You type the value and press Save. The value goes from your device to the daemon and is held in memory on the machine the daemon runs on, in a RAM-backed folder, and not written to disk. The agent is told the file path, never the value, so the secret is not in the transcript, the tool result or the agent's context.

The plugin does not use any password manager. It only stores the value and hands over a path. What the agent does next is up to the agent. For example, it can read the file into an environment variable for one command, or move it into a password manager and then delete the file.

## Setup

Needs Paseo 0.12 or later on the daemon and the app. Agents created after the plugin is installed get the tools. Agents that already exist do not, and need to be recreated. Only Claude agents get them for now.

## What it does and where it keeps things

- By default secrets live in a folder on a RAM-backed filesystem (tmpfs): `$XDG_RUNTIME_DIR/paseo-secrets`, else `/run/user/<uid>/paseo-secrets`, else `/dev/shm/paseo-secrets-<uid>`. One file per secret, folder mode 0700, files mode 0600. They survive a plugin reload and a Paseo restart, and are gone after a reboot. The plugin checks the filesystem type, so it only says "memory" when it is true.
- RAM can still be swapped to disk if the machine is short of memory. This is better than a file on disk, not a guarantee.
- To keep secrets across reboots, set `PASEO_SECRETS_STORE=disk` in the daemon's environment: they go to `$PASEO_HOME/secrets` (normally `~/.paseo/secrets`). `PASEO_SECRETS_DIR` picks any folder and counts as disk. Where there is no RAM-backed filesystem (for example macOS), the plugin uses disk and the box says so.
- The files are plaintext. Their only protection is file permissions and who can log in to the machine.
- Names use letters, digits, underscore and hyphen. They cannot be paths.
- Asking for a name that already exists shows "Replace" in the box. Nothing is overwritten without you pressing Save.
- Agents get four tools: `request_secret`, `await_secret`, `list_secrets` (names and paths only) and `forget_secret`.
- A request that you do not answer expires after 15 minutes. You can also decline.

## Limits

Once a secret is stored, the agent can read it. Nothing stops an agent from printing it into the transcript. The plugin makes sure the value never travels through chat or a tool result, and tells agents not to print it.

The plugin runs a small local server on `127.0.0.1` for the agents' tool calls. It is protected by a per-agent token and is not reachable from other machines.
