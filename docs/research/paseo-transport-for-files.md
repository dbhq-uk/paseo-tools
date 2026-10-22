# Can ferry use Paseo's own client-server transport

Date: 2026-10-22. Paseo 0.12.0 on this host. Source read: `getpaseo/paseo` at commit `9d908d6` (shallow clone, Apache-2.0). Paths below are in that repository.

## The question

Ferry moves files with a second channel: a receiver on the server, published with `tailscale serve`. Could it use the channel Paseo already has between the app and the daemon (direct, relay, or QR pairing) instead? Most interesting case: a file saved in a tab of the Paseo browser, which runs on the operator's device.

## Short answer

The transport can carry files. Nothing connects a browser tab to it. The page cannot reach it, a plugin cannot reach the tab, and the app never captures downloads. So the browser-download case needs a change inside Paseo. Other cases can already use the transport, or can with a plugin.

## What the transport already does

- **Binary file transfer frames.** `packages/server/src/server/file-upload/index.ts` has `FileUploadStore`, which takes `FileBegin`, `FileChunk` and `FileEnd` frames and writes `$PASEO_HOME/uploads/<id>/<name>`. The client method is `DaemonClient.uploadFile` (`@getpaseo/client`, `daemon-client.d.ts:1083`). The WebSocket message cap is 100 MB (`packages/protocol/src/websocket-message-limit.ts:2`), the app's own cap is 50 MB (`packages/app/src/attachments/upload-limit.ts`).
- **The app already uses it for composer attachments** (`packages/app/src/composer/actions.ts:126`, `uploadFileAttachments`) and for pasting files into a terminal. So handing the agent a file from the operator's device, by attaching it in the composer, already goes through the paired transport with no Tailscale and no URL. Not tested here, because it needs the app.
- **Downloads** have a token API (`requestDownloadToken`, `daemon-client.d.ts:1084`).

## Why a browser tab cannot use it

1. **The page is isolated.** Tabs are Electron webviews with `nodeIntegration` off, `contextIsolation` and `sandbox` on, and the only preload is a keyboard-shortcut forwarder (`packages/desktop/src/main.ts:743-762`). Page JavaScript can make network requests and nothing else. That is why ferry needs a reachable HTTPS address.
2. **`browser_evaluate` is capped.** Its result is limited to 80,000 characters (`packages/desktop/src/features/browser-automation/service.ts:74`), and it is returned as a tool result, so it lands in the agent's context. A 1.25 MB file would be about 21 calls and a flooded context. Fine for small JSON, not for files.
3. **Downloads are not captured.** There is no `will-download` handler anywhere in `packages/desktop/src`. The only download call is the context menu's "Save image" (`window-manager.ts:369`). A download in a tab is left to Electron's default, which saves on the operator's device.
4. **`browser_upload` does not use the transport.** It sets a file input with CDP `DOM.setFileInputFiles` and the paths as given (`service.ts:1385-1450`), checked against the agent's working directory. Those paths are resolved on the desktop. With a remote daemon the file is on the other machine, so it only works when both machines have the same path. Read from the code, not tested.
5. **The agent MCP token cannot be borrowed.** The `/mcp/agents` token is random per daemon run and injected only into local agent configs (`packages/server/src/server/bootstrap.ts:655-661`). A script cannot call the browser tools and keep the result out of the agent's context.
6. **The plugin SDK does not expose it.** `PaseoApi` covers terminals, workspaces, projects, agents, providers and config (`@getpaseo/client` `index.d.ts:392`). No `uploadFile`, no browser. A plugin RPC can carry JSON, so a plugin could send chunks of base64 itself.

## The one route left: a plugin reaching into the app

The webviews are plain DOM elements in the app window: a host `#paseo-browser-resident-webviews`, each `<webview>` tagged `data-paseo-browser-id` (`packages/app/src/desktop/browser/resident-webviews.ts:9,10,306`). A Paseo client plugin is code running in the app, and `<webview>.executeJavaScript()` has no 80,000 character cap. In principle a plugin could read a page's bytes there and send them to the daemon in chunks over plugin RPC.

**Spike** (`docs/research/webview-spike/`): a throwaway plugin whose timeline row, when rendered, looks for the host and the test tab, runs `executeJavaScript` there, and sends 500 KB to the server in 100 KB chunks. The server compares what arrived. I opened `https://example.com` for it and probed nothing else.

**Result: inconclusive.** The client ran, and reported `{"hasDocument":false}`. In that client the plugin code has no DOM, so the route does not exist there. I could not tell which client it was (a phone has no DOM either; the platform field was added after it). A second row, with platform and user agent, was never rendered. To settle it, open this conversation in the desktop app and look at `paseo plugin logs webview-spike` for a line starting `SPIKE client report`.

Even if it works, this depends on the app's DOM ids, which are not a plugin API, and it only works on desktop.

## What this means for ferry

| Need | Today | With the transport |
| --- | --- | --- |
| Page data, small | `browser_evaluate` return value | same |
| Page data or a download, large | ferry (HTTPS over Tailscale) | needs a change in Paseo: capture downloads in the desktop app and send them with `uploadFile` |
| Operator's device to server, picked by hand | ferry upload page | composer attachment, already built in |
| Server to operator's device | ferry `share` | none |
| Server file into a page's file input | broken for remote daemons | would need the app to receive bytes |

## Recommendation

1. Keep ferry for the browser case. Nothing short of a change in Paseo replaces it.
2. Tell agents that a file the operator wants to hand over can be attached in the composer. It uses the paired transport and needs no setup. Add a line to the ferry skill.
3. Ask Paseo for browser-tab downloads to be saved into the workspace through the existing upload frames. It would also fix `browser_upload` for remote daemons. This is a feature request, which Paseo takes in Discussions, not Issues.
4. Do not build a plugin that reaches into the app's DOM unless the spike proves the DOM is there and Paseo accepts that as supported.
