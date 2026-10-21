# secrets

A Paseo plugin that lets an agent request a secret. A masked box appears in the app, you type the value, and it is stored in a protected file on the daemon host. The agent gets the path, never the value. See [OVERVIEW.md](OVERVIEW.md) for what it does and its limits.

## How it works

1. `agent.create` hook: for new Claude agents the plugin adds an MCP server (`type: http`, `127.0.0.1`, bearer token per agent), pre-approves its four tools, and puts the token in the agent's environment as `PASEO_SECRETS_CONN`.
2. `agent.session_open` hook: the plugin sees the agent's id and the token together and records which agent holds the token. The map is kept in `<secrets dir>/.plugin-state.json` (mode 0600) because the agent's saved MCP configuration outlives the daemon. The server's port is kept there too, so the saved URL stays valid after a restart.
3. The agent calls `request_secret`. The plugin appends a `secret-request` row to that agent's timeline with `{ requestId, name, purpose, status }`. It never holds the value.
4. The client renders the row as a masked field. Save calls the `secrets.submit` RPC, the daemon writes the file, and the row is replaced with a "stored" state. The waiting tool call returns the path.

Files:

```
shared/contracts.ts     name rule, row schema, the two RPCs
server/store.ts         files: 0700 folder, 0600 files, atomic write
server/broker.ts        open requests: waiting, stored, cancelled, expired
server/connections.ts   token to agent id, persisted
server/mcp.ts           the MCP server: JSON-RPC over HTTP
index.server.ts         hooks, RPC handlers, wiring
client/SecretRequest.tsx  the timeline row and the box
```

## Rules for changing it

- **The value is never logged, never put in a row, never returned.** `Broker.submit` hands it straight to `writeSecret`. Plugin stdout and stderr are kept in memory and in `daemon.log`, so nothing that touches the value may print. Tests check the rows and tool results for a canary value.
- Names are validated in three places (store, MCP, RPC contract). Keep all three.
- Only providers in `PROVIDERS` in `index.server.ts` get the tools, because an MCP server a provider cannot use can break agent launch.

## Develop

```bash
cd plugins/secrets
npm install
npm run typecheck
npm test
paseo plugin install "$(pwd)"      # or: paseo plugin reload secrets
paseo plugin logs secrets
```
