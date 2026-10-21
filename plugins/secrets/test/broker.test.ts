import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SecretRow } from "../shared/contracts";
import { Broker } from "../server/broker";
import { writeSecret } from "../server/store";

function rig(ttlMs?: number) {
  const dir = join(mkdtempSync(join(tmpdir(), "secrets-broker-")), "secrets");
  const rows: Array<{ agentId: string; rowId: string; row: SecretRow }> = [];
  const broker = new Broker({ dir, ttlMs, publish: async (agentId, rowId, row) => void rows.push({ agentId, rowId, row }) });
  return { dir, rows, broker };
}

test("a request puts a waiting row in that agent's timeline", async () => {
  const { broker, rows } = rig();
  const outcome = await broker.request("agent-1", "API_KEY", "for the build");
  assert.equal(outcome.status, "waiting");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agentId, "agent-1");
  assert.equal(rows[0].row.status, "waiting");
  assert.equal(rows[0].row.replacing, false);
});

test("submitting stores the value, resolves the waiter with a path, and the row never holds the value", async () => {
  const { broker, rows, dir } = rig();
  const opened = await broker.request("agent-1", "API_KEY", "x");
  assert.equal(opened.status, "waiting");
  if (opened.status !== "waiting") return;
  const waiting = broker.wait(opened.requestId, 5000);
  const canary = "canary-value-do-not-leak";
  assert.deepEqual(await broker.submit(opened.requestId, canary), { ok: true });
  const outcome = await waiting;
  assert.equal(outcome?.status, "stored");
  if (outcome?.status === "stored") {
    assert.equal(outcome.path, join(dir, "API_KEY"));
    assert.equal(readFileSync(outcome.path, "utf8"), canary);
  }
  assert.equal(rows.at(-1)?.row.status, "stored");
  assert.ok(!JSON.stringify(rows).includes(canary), "the value must not appear in any row");
  assert.ok(!JSON.stringify(outcome).includes(canary), "the value must not appear in the outcome");
});

test("the same agent asking for the same name twice gets the same open request", async () => {
  const { broker, rows } = rig();
  const a = await broker.request("agent-1", "K", "x");
  const b = await broker.request("agent-1", "K", "x");
  assert.deepEqual(a, b);
  assert.equal(rows.length, 1);
  const other = await broker.request("agent-2", "K", "x");
  assert.notDeepEqual(a, other);
});

test("asking for a name that already exists says it is replacing", async () => {
  const { broker, rows, dir } = rig();
  writeSecret(dir, "K", "old");
  await broker.request("agent-1", "K", "x");
  assert.equal(rows[0].row.replacing, true);
});

test("cancelling ends the request and tells the waiter", async () => {
  const { broker, rows } = rig();
  const opened = await broker.request("agent-1", "K", "x");
  if (opened.status !== "waiting") throw new Error("expected waiting");
  const waiting = broker.wait(opened.requestId, 5000);
  assert.equal(await broker.cancel(opened.requestId), true);
  assert.equal((await waiting)?.status, "cancelled");
  assert.equal(rows.at(-1)?.row.status, "cancelled");
  assert.equal(await broker.cancel(opened.requestId), false);
});

test("a request that is not answered expires", async () => {
  const { broker, rows } = rig(30);
  const opened = await broker.request("agent-1", "K", "x");
  if (opened.status !== "waiting") throw new Error("expected waiting");
  const outcome = await broker.wait(opened.requestId, 2000);
  assert.equal(outcome?.status, "expired");
  assert.equal(rows.at(-1)?.row.status, "expired");
});

test("waiting returns 'waiting' when the time runs out", async () => {
  const { broker } = rig();
  const opened = await broker.request("agent-1", "K", "x");
  if (opened.status !== "waiting") throw new Error("expected waiting");
  assert.equal((await broker.wait(opened.requestId, 20))?.status, "waiting");
  assert.equal(await broker.wait("no-such-request", 20), undefined);
});

test("a closed or unknown request refuses a value and stores nothing", async () => {
  const { broker, dir } = rig();
  assert.equal((await broker.submit("nope", "v")).ok, false);
  const opened = await broker.request("agent-1", "K", "x");
  if (opened.status !== "waiting") throw new Error("expected waiting");
  await broker.cancel(opened.requestId);
  assert.equal((await broker.submit(opened.requestId, "v")).ok, false);
  assert.throws(() => readFileSync(join(dir, "K")));
});

test("if the box cannot be shown, the request fails at once and nothing stays open", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "secrets-broker-")), "secrets");
  const broker = new Broker({ dir, publish: async () => { throw new Error("no paseo yet"); } });
  await assert.rejects(broker.request("agent-1", "K", "x"), /no paseo yet/);
});

test("a failed later update does not lose a stored secret", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "secrets-broker-")), "secrets");
  let calls = 0;
  const broker = new Broker({
    dir,
    publish: async () => {
      if (++calls > 1) throw new Error("connection dropped");
    },
  });
  const opened = await broker.request("agent-1", "K", "x");
  if (opened.status !== "waiting") throw new Error("expected waiting");
  assert.deepEqual(await broker.submit(opened.requestId, "v"), { ok: true });
  assert.equal(readFileSync(join(dir, "K"), "utf8"), "v");
});
