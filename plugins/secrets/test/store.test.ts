import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listSecrets, pathFor, locateStore, removeSecret, StoreError, stateFile, writeSecret } from "../server/store";

const scratch = () => join(mkdtempSync(join(tmpdir(), "secrets-store-")), "secrets");
const mode = (path: string) => statSync(path).mode & 0o777;

test("a secret is written at 0600 inside a 0700 folder, with exactly the bytes given", () => {
  const dir = scratch();
  const value = "p@ss word\nwith a newline and ünïcode";
  const path = writeSecret(dir, "STRIPE_KEY", value);
  assert.equal(path, join(dir, "STRIPE_KEY"));
  assert.equal(readFileSync(path, "utf8"), value);
  assert.equal(mode(path), 0o600);
  assert.equal(mode(dir), 0o700);
});

test("a looser existing folder is tightened", () => {
  const dir = scratch();
  writeSecret(dir, "A", "1");
  // simulate someone loosening it
  chmodSync(dir, 0o755);
  writeSecret(dir, "B", "2");
  assert.equal(mode(dir), 0o700);
});

test("replacing a secret overwrites it and leaves no temporary file behind", () => {
  const dir = scratch();
  writeSecret(dir, "K", "old");
  writeSecret(dir, "K", "new");
  assert.equal(readFileSync(join(dir, "K"), "utf8"), "new");
  assert.deepEqual(readdirSync(dir), ["K"]);
});

test("names that could escape the folder or hide are refused", () => {
  const dir = scratch();
  for (const bad of ["", "../x", "a/b", "a\\b", ".hidden", "-lead", "with space", "x".repeat(65), "a\0b", ".."]) {
    assert.throws(() => writeSecret(dir, bad, "v"), StoreError, JSON.stringify(bad));
    assert.throws(() => pathFor(dir, bad), StoreError, JSON.stringify(bad));
  }
  assert.deepEqual(readdirSync(join(dir, "..")), []);
});

test("an empty or oversized value is refused", () => {
  const dir = scratch();
  assert.throws(() => writeSecret(dir, "K", ""), StoreError);
  assert.throws(() => writeSecret(dir, "K", "x".repeat(64 * 1024 + 1)), StoreError);
  writeSecret(dir, "K", "x".repeat(64 * 1024));
});

test("list shows names only and hides the plugin's own dotfiles", () => {
  const dir = scratch();
  writeSecret(dir, "B", "1");
  writeSecret(dir, "A", "2");
  writeFileSync(join(dir, ".plugin-state.json"), "{}");
  assert.deepEqual(listSecrets(dir), ["A", "B"]);
  assert.deepEqual(listSecrets(join(dir, "missing")), []);
});

test("remove deletes the file and says whether there was one", () => {
  const dir = scratch();
  writeSecret(dir, "K", "v");
  assert.equal(removeSecret(dir, "K"), true);
  assert.equal(removeSecret(dir, "K"), false);
  assert.throws(() => removeSecret(dir, "../K"), StoreError);
});

const ram = (...bases: string[]) => (path: string) => bases.includes(path);

test("an explicit folder wins and counts as disk", () => {
  assert.deepEqual(locateStore({ env: { PASEO_SECRETS_DIR: "/a", PASEO_HOME: "/h" }, platform: "linux" }), {
    dir: "/a",
    storage: "disk",
  });
});

test("PASEO_SECRETS_STORE=disk keeps secrets under the Paseo home", () => {
  const env = { PASEO_HOME: "/h", PASEO_SECRETS_STORE: "disk", XDG_RUNTIME_DIR: "/run/user/7" };
  assert.deepEqual(locateStore({ env, uid: 7, platform: "linux", ramBacked: ram("/run/user/7") }), {
    dir: "/h/secrets",
    storage: "disk",
  });
});

test("by default a RAM-backed runtime folder is used, found by type and not by name", () => {
  const env = { PASEO_HOME: "/h", XDG_RUNTIME_DIR: "/run/user/7" };
  assert.deepEqual(locateStore({ env, uid: 7, platform: "linux", ramBacked: ram("/run/user/7") }), {
    dir: "/run/user/7/paseo-secrets",
    storage: "memory",
  });
});

test("without XDG_RUNTIME_DIR it tries /run/user/<uid>, then /dev/shm with the uid in the name", () => {
  const env = { PASEO_HOME: "/h" };
  assert.equal(locateStore({ env, uid: 7, platform: "linux", ramBacked: ram("/run/user/7") }).dir, "/run/user/7/paseo-secrets");
  assert.deepEqual(locateStore({ env, uid: 7, platform: "linux", ramBacked: ram("/dev/shm") }), {
    dir: "/dev/shm/paseo-secrets-7",
    storage: "memory",
  });
});

test("a folder that is not RAM-backed is never called memory", () => {
  const env = { PASEO_HOME: "/h", XDG_RUNTIME_DIR: "/run/user/7" };
  assert.deepEqual(locateStore({ env, uid: 7, platform: "linux", ramBacked: () => false }), {
    dir: "/h/secrets",
    storage: "disk",
  });
});

test("outside Linux it falls back to disk", () => {
  assert.equal(locateStore({ env: { PASEO_HOME: "/h" }, platform: "darwin", ramBacked: () => true }).storage, "disk");
});

test("on this machine the real check agrees with the mounts", () => {
  const found = locateStore({ env: { PASEO_HOME: "/h" } });
  if (process.platform === "linux" && existsSync("/dev/shm")) assert.equal(found.storage, "memory");
});

test("plugin state lives under the Paseo home, on disk", () => {
  assert.equal(stateFile({ PASEO_HOME: "/h" }), "/h/secrets-plugin-state.json");
  assert.match(stateFile({}), /\.paseo\/secrets-plugin-state\.json$/);
});
