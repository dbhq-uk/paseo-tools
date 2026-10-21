import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Connections } from "../server/connections";

const file = () => join(mkdtempSync(join(tmpdir(), "secrets-conn-")), "state", ".plugin-state.json");

test("a token is unknown until bound, then names its agent", () => {
  const c = new Connections(file());
  const token = c.issue();
  assert.equal(c.agentFor(token), null);
  assert.equal(c.bind(token, "agent-1"), true);
  assert.equal(c.agentFor(token), "agent-1");
  assert.equal(c.agentFor("not-a-token"), null);
  assert.equal(c.bind("not-a-token", "agent-2"), false);
});

test("bindings and the port survive a restart, in a 0600 file", () => {
  const path = file();
  const first = new Connections(path);
  const token = first.issue();
  first.bind(token, "agent-1");
  first.setPort(4321);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const second = new Connections(path);
  assert.equal(second.agentFor(token), "agent-1");
  assert.equal(second.port, 4321);
});

test("a damaged state file starts empty instead of crashing", () => {
  const path = file();
  const c = new Connections(path);
  c.issue();
  writeFileSync(path, "{not json");
  assert.equal(new Connections(path).port, undefined);
});
