import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Broker } from "../server/broker";
import { Connections } from "../server/connections";
import { createMcpServer } from "../server/mcp";

const dir = join(mkdtempSync(join(tmpdir(), "secrets-mcp-")), "secrets");
const connections = new Connections(join(dir, ".plugin-state.json"));
const broker = new Broker({ dir, publish: async () => {} });
const server = createMcpServer({ broker, connections, dir });
const token = connections.issue();
connections.bind(token, "agent-1");
let url = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
after(() => server.close());

async function rpc(body: unknown, auth: string | null = `Bearer ${token}`) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : undefined, raw };
}
const call = (name: string, args: unknown, id = 1) =>
  rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

test("no token, a wrong token, or an unbound token gets 401", async () => {
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, null)).status, 401);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, "Bearer nope")).status, 401);
  const unbound = connections.issue();
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, `Bearer ${unbound}`)).status, 401);
});

test("only POST is accepted", async () => {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 405);
});

test("initialize, notifications and tools/list follow the protocol", async () => {
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.body.result.capabilities, { tools: {} });
  assert.equal((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(
    list.body.result.tools.map((t: { name: string }) => t.name),
    ["request_secret", "await_secret", "list_secrets", "forget_secret"],
  );
  assert.equal((await rpc({ jsonrpc: "2.0", id: 3, method: "nope" })).body.error.code, -32601);
});

test("a bad name is refused before anything is asked", async () => {
  const reply = await call("request_secret", { name: "../etc/passwd", purpose: "x" });
  assert.equal(reply.body.result.isError, true);
});

test("request, then the operator saves: the agent gets a path and never the value", async () => {
  const canary = "canary-value-do-not-leak";
  const asking = call("request_secret", { name: "STRIPE_KEY", purpose: "to test" }, 7);
  // wait until the broker has the request, then play the operator
  let requestId = "";
  for (let i = 0; i < 100 && !requestId; i++) {
    await new Promise((r) => setTimeout(r, 10));
    const open = broker.openRequest("agent-1", "STRIPE_KEY");
    if (open?.status === "waiting") requestId = open.requestId;
  }
  assert.ok(requestId);
  assert.deepEqual(await broker.submit(requestId, canary), { ok: true });
  const reply = await asking;
  const text = reply.body.result.content[0].text as string;
  assert.match(text, /Stored STRIPE_KEY/);
  assert.match(text, new RegExp(join(dir, "STRIPE_KEY").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(!reply.raw.includes(canary), "the tool result must not contain the value");
  assert.equal(readFileSync(join(dir, "STRIPE_KEY"), "utf8"), canary);
  assert.equal(statSync(join(dir, "STRIPE_KEY")).mode & 0o777, 0o600);
});

test("list shows names and paths, and forget deletes", async () => {
  const listed = await call("list_secrets", {});
  assert.match(listed.body.result.content[0].text, /STRIPE_KEY:/);
  assert.ok(!listed.raw.includes("canary-value-do-not-leak"));
  assert.match((await call("forget_secret", { name: "STRIPE_KEY" })).body.result.content[0].text, /Deleted/);
  assert.equal((await call("forget_secret", { name: "STRIPE_KEY" })).body.result.isError, true);
  assert.equal((await call("forget_secret", { name: "../x" })).body.result.isError, true);
});

test("a declined request tells the agent not to keep asking", async () => {
  const asking = call("request_secret", { name: "DECLINED", purpose: "x" });
  let requestId = "";
  for (let i = 0; i < 100 && !requestId; i++) {
    await new Promise((r) => setTimeout(r, 10));
    const open = broker.openRequest("agent-1", "DECLINED");
    if (open?.status === "waiting") requestId = open.requestId;
  }
  await broker.cancel(requestId);
  const reply = await asking;
  assert.equal(reply.body.result.isError, true);
  assert.match(reply.body.result.content[0].text, /declined/);
});

test("await on an unknown request says so", async () => {
  const reply = await call("await_secret", { requestId: "nope", waitSeconds: 0 });
  assert.equal(reply.body.result.isError, true);
});

test("when the timeline row cannot be shown, the agent is told and nothing is left open", async () => {
  const brokenDir = join(mkdtempSync(join(tmpdir(), "secrets-mcp-")), "secrets");
  const broken = createMcpServer({
    broker: new Broker({ dir: brokenDir, publish: async () => { throw new Error("no paseo yet"); } }),
    connections,
    dir: brokenDir,
  });
  await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));
  try {
    const brokenUrl = `http://127.0.0.1:${(broken.address() as AddressInfo).port}/mcp`;
    const response = await fetch(brokenUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "request_secret", arguments: { name: "K", purpose: "x" } } }),
    });
    const body = await response.json();
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /could not be shown/);
  } finally {
    broken.close();
  }
});
