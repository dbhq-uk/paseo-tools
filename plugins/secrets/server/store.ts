import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_VALUE_BYTES, NAME_PATTERN } from "../shared/contracts";

export class StoreError extends Error {}

/** `PASEO_SECRETS_DIR`, else `$PASEO_HOME/secrets`, else `~/.paseo/secrets`. */
export function secretsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PASEO_SECRETS_DIR) return env.PASEO_SECRETS_DIR;
  return join(env.PASEO_HOME || join(homedir(), ".paseo"), "secrets");
}

export function checkName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new StoreError("Names use letters, digits, underscore and hyphen, up to 64 characters, and do not start with a hyphen.");
  }
}

/** Create the folder at 0700, and tighten it if something made it looser. */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
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
