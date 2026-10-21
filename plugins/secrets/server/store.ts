import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_VALUE_BYTES, NAME_PATTERN } from "../shared/contracts";

export class StoreError extends Error {}

export type Storage = "memory" | "disk";
export interface Location {
  dir: string;
  storage: Storage;
}

/** Filesystem type numbers from statfs(2): tmpfs and ramfs keep their files in RAM. */
const RAM_FILESYSTEMS = new Set([0x01021994, 0x858458f6]);

export function isRamBacked(path: string): boolean {
  try {
    return RAM_FILESYSTEMS.has(Number(statfsSync(path).type));
  } catch {
    return false;
  }
}

export interface LocateOptions {
  env?: NodeJS.ProcessEnv;
  uid?: number;
  platform?: string;
  ramBacked?: (path: string) => boolean;
}

/**
 * Where secrets live. In order:
 *   1. `PASEO_SECRETS_DIR`, wherever the operator points it (counted as disk).
 *   2. `PASEO_SECRETS_STORE=disk`: `$PASEO_HOME/secrets`, which survives a reboot.
 *   3. A folder on a RAM-backed filesystem (tmpfs or ramfs), checked by type and
 *      not by name: `$XDG_RUNTIME_DIR`, `/run/user/<uid>`, then `/dev/shm`.
 *   4. `$PASEO_HOME/secrets` on disk, where there is no RAM-backed filesystem.
 */
export function locateStore(options: LocateOptions = {}): Location {
  const env = options.env ?? process.env;
  const home = env.PASEO_HOME || join(homedir(), ".paseo");
  const disk: Location = { dir: join(home, "secrets"), storage: "disk" };
  if (env.PASEO_SECRETS_DIR) return { dir: env.PASEO_SECRETS_DIR, storage: "disk" };
  if (env.PASEO_SECRETS_STORE === "disk") return disk;
  if ((options.platform ?? process.platform) !== "linux") return disk;
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const ramBacked = options.ramBacked ?? isRamBacked;
  const candidates = [
    env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "paseo-secrets") : undefined,
    join("/run/user", String(uid), "paseo-secrets"),
    // /dev/shm is shared by every user, so the name carries the uid.
    join("/dev/shm", `paseo-secrets-${uid}`),
  ];
  for (const dir of candidates) {
    if (dir && ramBacked(join(dir, ".."))) return { dir, storage: "memory" };
  }
  return disk;
}

/** Where the plugin keeps its own non-secret state. Always on disk: tokens must outlive a reboot. */
export function stateFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.PASEO_HOME || join(homedir(), ".paseo"), "secrets-plugin-state.json");
}

export function checkName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new StoreError("Names use letters, digits, underscore and hyphen, up to 64 characters, and do not start with a hyphen.");
  }
}

/** Create the folder at 0700, and tighten it if something made it looser. */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = statSync(dir);
  // A shared place such as /dev/shm lets anyone create a folder first. Never use one that is not ours.
  if (process.getuid && info.uid !== process.getuid()) throw new StoreError("The secrets folder belongs to another user.");
  if ((info.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

export function pathFor(dir: string, name: string): string {
  checkName(name);
  return join(dir, name);
}

export function hasSecret(dir: string, name: string): boolean {
  return existsSync(pathFor(dir, name));
}

/**
 * Write a secret to `<dir>/<name>` at mode 0600. The file is written under a
 * temporary name and renamed, so a reader never sees half a value and the final
 * file never exists with looser permissions. Returns the path, never the value.
 */
export function writeSecret(dir: string, name: string, value: string): string {
  checkName(name);
  if (value.length === 0) throw new StoreError("The value is empty.");
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) throw new StoreError("The value is too long.");
  ensureDir(dir);
  const target = join(dir, name);
  const temporary = join(dir, `.tmp-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(temporary, value, { mode: 0o600, flag: "wx" });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return target;
}

export function removeSecret(dir: string, name: string): boolean {
  const target = pathFor(dir, name);
  if (!existsSync(target)) return false;
  rmSync(target);
  return true;
}

/** Names only. Dotfiles are the plugin's own state and are never listed. */
export function listSecrets(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => NAME_PATTERN.test(entry))
    .sort();
}
