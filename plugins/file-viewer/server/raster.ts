import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { assertPdf } from "./scan.js";

const run = promisify(execFile);
const TIMEOUT_MS = 30_000;
const CACHE_LIMIT_BYTES = 500 * 1024 * 1024;

/**
 * Rendered pages are private documents, so the cache is not in the shared temp
 * folder, where any local user could read it or plant files in it. It lives in
 * the user's cache folder, mode 0700, and is refused if someone else owns it.
 */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PASEO_FILE_VIEWER_CACHE) return env.PASEO_FILE_VIEWER_CACHE;
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "paseo-file-viewer");
}

async function ensureCacheDir(): Promise<string> {
  const dir = cacheDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await stat(dir);
  if (process.getuid && info.uid !== process.getuid()) throw new Error("The page cache belongs to another user");
  if ((info.mode & 0o077) !== 0) await chmod(dir, 0o700);
  return dir;
}

/** Formats React Native can display directly, so no conversion step is needed. */
const NATIVE_IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
};

/**
 * ImageMagick picks a decoder from the file's content, not its name, so a file
 * called x.png can be read as MVG or SVG, which are the formats its past
 * security problems came from. A coder prefix makes it decode what the
 * extension says and nothing else. Viewed files are often downloads, so they
 * are untrusted.
 */
const CODER: Record<string, string> = {
  ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".gif": "gif", ".webp": "webp", ".bmp": "bmp", ".avif": "avif",
};

export function magickInput(file: string, frame = "[0]"): string {
  const coder = CODER[extname(file).toLowerCase()];
  if (!coder) throw new Error("This image type cannot be read");
  return `${coder}:${file}${frame}`;
}

/** Width and height from a PNG's header, so no process is needed to measure a PNG we just made. */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** 150 DPI is the 100% baseline; the zoom control moves DPI, not the image. */
const BASE_DPI = 150;

async function exec(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new Error(`Missing tool: ${cmd}. Install poppler-utils, librsvg2-bin and imagemagick`);
    if (err?.killed) throw new Error(`${cmd} timed out after ${TIMEOUT_MS / 1000}s`);
    throw new Error(err?.stderr?.toString().trim() || err?.message || `${cmd} failed`);
  }
}

function cacheKey(file: string, mtimeMs: number, size: number, page: number, dpi: number): string {
  return createHash("sha256")
    .update([file, mtimeMs, size, page, dpi].join("\0"))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Evicts the oldest entries once the cache exceeds its limit. Ordered by last
 * access where the filesystem records it, and by modification time where it
 * does not (noatime), which makes it first in, first out.
 * Called after a write, and failures are ignored - a full cache is a
 * performance problem, not a reason to fail the render.
 */
async function evict(): Promise<void> {
  try {
    const dir = cacheDir();
    const names = await readdir(dir);
    const entries = await Promise.all(
      names.map(async (n) => {
        const p = join(dir, n);
        const s = await stat(p);
        return { path: p, size: s.size, atime: Math.max(s.atimeMs, s.mtimeMs) };
      }),
    );
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    if (total <= CACHE_LIMIT_BYTES) return;
    entries.sort((a, b) => a.atime - b.atime);
    for (const e of entries) {
      if (total <= CACHE_LIMIT_BYTES) break;
      await unlink(e.path).catch(() => {});
      total -= e.size;
    }
  } catch {
    // cache maintenance is best-effort
  }
}

export interface PageInfo {
  pages: number;
  width: number;
  height: number;
}

export async function pdfInfo(file: string): Promise<PageInfo> {
  await assertPdf(file);
  const out = await exec("pdfinfo", [file]);
  const pages = Number(/^Pages:\s+(\d+)/m.exec(out)?.[1] ?? 0);
  const size = /^Page size:\s+([\d.]+) x ([\d.]+)/m.exec(out);
  if (!pages) throw new Error("Could not read the PDF - it may be encrypted or corrupt");
  return {
    pages,
    width: Math.round((Number(size?.[1] ?? 595) / 72) * BASE_DPI),
    height: Math.round((Number(size?.[2] ?? 842) / 72) * BASE_DPI),
  };
}

export async function imageInfo(file: string): Promise<PageInfo> {
  if (extname(file).toLowerCase() === ".svg") {
    // Not ImageMagick: its SVG reader is the one to keep away from untrusted files.
    // Render at natural size and read the PNG header.
    const dir = await ensureCacheDir();
    const temporary = join(dir, `size-${randomBytes(6).toString("hex")}.png`);
    try {
      await exec("rsvg-convert", ["-o", temporary, file]);
      const size = pngSize(await readFile(temporary));
      if (!size) throw new Error("Could not read the image dimensions");
      return { pages: 1, ...size };
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  const out = await exec("identify", ["-format", "%w %h", magickInput(file)]);
  const [w, h] = out.trim().split(/\s+/).map(Number);
  if (!w || !h) throw new Error("Could not read the image dimensions");
  return { pages: 1, width: w, height: h };
}

export interface RenderedPage {
  dataUri: string;
  width: number;
  height: number;
}

/** Requests for the same page that arrive together share one render. */
const inFlight = new Map<string, Promise<Buffer>>();

/**
 * Makes a PNG for one page and returns its bytes. The output is written under a
 * temporary name and renamed, so a second request can never read half a file.
 */
async function makePng(file: string, kind: "pdf" | "image", page: number, dpi: number, cached: string): Promise<Buffer> {
  try {
    return await readFile(cached);
  } catch {
    // not cached yet
  }
  const temporary = `${cached}.${randomBytes(6).toString("hex")}`;
  const output = `${temporary}.png`;
  try {
    if (kind === "pdf") {
      // pdftoppm adds .png itself and writes one file with -singlefile.
      await exec("pdftoppm", ["-png", "-r", String(dpi), "-f", String(page), "-l", String(page), "-singlefile", file, temporary]);
    } else if (extname(file).toLowerCase() === ".svg") {
      await exec("rsvg-convert", ["-z", String(dpi / BASE_DPI), "-o", output, file]);
    } else {
      const scale = dpi / BASE_DPI;
      const args = [magickInput(file)];
      if (scale !== 1) args.push("-resize", `${Math.round(scale * 100)}%`);
      await exec("convert", [...args, `png:${output}`]);
    }
    await rename(output, cached);
  } finally {
    await unlink(output).catch(() => {});
  }
  void evict();
  return await readFile(cached);
}

/**
 * Renders one page as a PNG data URI, caching the result on disk.
 *
 * The cache key includes mtime and size, so editing a file invalidates its
 * pages without any filesystem watching.
 */
export async function renderPage(
  file: string,
  kind: "pdf" | "image",
  page: number,
  dpi: number,
): Promise<RenderedPage> {
  const info = await stat(file);
  const ext = extname(file).toLowerCase();

  // A native image at 100% is shown as it is: no conversion, nothing cached.
  if (kind === "image" && NATIVE_IMAGE.has(ext) && dpi === BASE_DPI) {
    const [bytes, size] = await Promise.all([readFile(file), imageInfo(file)]);
    return { dataUri: `data:${MIME[ext]};base64,${bytes.toString("base64")}`, width: size.width, height: size.height };
  }

  const key = cacheKey(file, info.mtimeMs, info.size, page, dpi);
  const dir = await ensureCacheDir();
  const cached = join(dir, `${key}.png`);

  let pending = inFlight.get(cached);
  if (!pending) {
    pending = makePng(file, kind, page, dpi, cached).finally(() => inFlight.delete(cached));
    inFlight.set(cached, pending);
  }
  const bytes = await pending;
  const size = pngSize(bytes);
  if (!size) throw new Error("The renderer produced an unreadable image");
  return { dataUri: `data:image/png;base64,${bytes.toString("base64")}`, width: size.width, height: size.height };
}
