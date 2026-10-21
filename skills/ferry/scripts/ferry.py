#!/usr/bin/env python3
"""ferry - move files and data between the operator's devices and this server.

Paseo's browser runs on the operator's own device, so a download lands there and an
HTTPS page cannot POST to a plain-HTTP address on the server. ferry runs a small
receiver bound to 127.0.0.1 and exposes it over `tailscale serve` (HTTPS, valid
certificate, tailnet only). Everything sits behind a random token in the URL path.

    ferry.py start --dest DIR [--serve-dir DIR]     start, print the base URL
    ferry.py snippet --url URL --name NAME          JS for the browser to run
    ferry.py share FILE                             make FILE downloadable
    ferry.py status                                 is it up, what has arrived
    ferry.py stop                                   turn everything off

Standard library only, Python 3.9+. Linux and macOS. Never uses `tailscale funnel`.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import shutil
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

LOG_NAME = ".ferry-log.jsonl"
DEFAULT_IDLE = 3600.0
DEFAULT_MAX_MB = 512.0
PORT_RANGE = range(10002, 10021)
CHUNK = 1 << 20
DRAIN_LIMIT = 16 << 20

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600",
}

UPLOAD_PAGE = """<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Ferry</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; color: #1b1f24; }
  h1 { font-size: 1.4rem; margin-bottom: .25rem; }
  p.sub { margin-top: 0; color: #57606a; }
  #drop { border: 2px dashed #8c959f; border-radius: 8px; padding: 2.5rem 1rem; text-align: center; }
  #drop.over { border-color: #0969da; background: #ddf4ff; }
  ul { list-style: none; padding: 0; }
  li { border-bottom: 1px solid #d0d7de; padding: .5rem 0; word-break: break-all; }
  progress { width: 100%; }
  .ok { color: #1a7f37; } .bad { color: #cf222e; } code { font-size: .85em; }
</style>
</head>
<body>
<h1>Ferry</h1>
<p class="sub">Send files to the server. Nothing leaves your tailnet</p>
<div id="drop">
  <p>Drop files here, or choose them</p>
  <input id="pick" type="file" multiple>
</div>
<ul id="list"></ul>
<script>
const list = document.getElementById("list");
const drop = document.getElementById("drop");
function send(file) {
  const li = document.createElement("li");
  const label = document.createElement("div");
  label.textContent = file.name + " (" + file.size + " bytes)";
  const bar = document.createElement("progress");
  bar.max = 1; bar.value = 0;
  const note = document.createElement("div");
  li.append(label, bar, note);
  list.prepend(li);
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "up/" + encodeURIComponent(file.name));
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.value = e.loaded / e.total; };
  xhr.onload = () => {
    let out = {};
    try { out = JSON.parse(xhr.responseText); } catch (e) {}
    if (xhr.status >= 200 && xhr.status < 300) {
      bar.value = 1;
      note.className = "ok";
      note.textContent = "Saved as " + out.saved + ", sha256 " + String(out.sha256).slice(0, 12);
    } else {
      note.className = "bad";
      note.textContent = "Failed: " + (out.error || xhr.status);
    }
  };
  xhr.onerror = () => { note.className = "bad"; note.textContent = "Failed: network error"; };
  xhr.send(file);
}
function sendAll(files) { for (const f of files) send(f); }
document.getElementById("pick").addEventListener("change", (e) => { sendAll(e.target.files); e.target.value = ""; });
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); sendAll(e.dataTransfer.files); });
</script>
</body>
</html>
"""


class FerryError(Exception):
    """A failure that should reach the user as a message, not a traceback."""


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


# --- names -------------------------------------------------------------------


def safe_name(raw: str) -> str:
    """Reduce any client-supplied name to a harmless basename.

    No directories, no `..`, no leading dot (so the log and temp files can never be
    reached), and only letters, digits, dot, dash and underscore.
    """
    parts = [p for p in raw.replace("\\", "/").split("/") if p]
    name = parts[-1] if parts else ""
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name).lstrip(".")
    name = name[-150:]
    return name or "upload"


def numbered(name: str, n: int) -> str:
    stem, ext = os.path.splitext(name)
    return f"{stem}-{n}{ext}" if n else name


def reserve_name(directory: Path, name: str) -> Path:
    """Create an empty file under a name nobody else has, and return its path.

    O_EXCL makes the claim atomic, so two uploads of the same name at once cannot
    both get it. An existing file is never touched.
    """
    n = 0
    while True:
        path = directory / numbered(name, n)
        try:
            os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644))
        except FileExistsError:
            n += 1
            continue
        return path


# --- server ------------------------------------------------------------------


class FerryServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, dest: Path, token: str, serve_dir: Path | None, max_bytes: int):
        super().__init__(address, FerryHandler)
        self.dest = dest
        self.token = token
        self.serve_dir = serve_dir
        self.max_bytes = max_bytes
        self.stop_reason: str | None = None
        self._lock = threading.Lock()
        self._active = 0
        self._last = time.monotonic()
        self._log_lock = threading.Lock()

    def server_bind(self) -> None:
        # HTTPServer.server_bind calls getfqdn(), which can stall for seconds on a
        # slow resolver. Nothing here needs the host name.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "127.0.0.1", self.server_address[1]

    def begin(self) -> None:
        with self._lock:
            self._active += 1
            self._last = time.monotonic()

    def end(self) -> None:
        with self._lock:
            self._active -= 1
            self._last = time.monotonic()

    def idle_for(self) -> float:
        """Seconds since the last activity, or 0 while a request is in flight."""
        with self._lock:
            return 0.0 if self._active else time.monotonic() - self._last

    def write_log(self, entry: dict) -> None:
        line = json.dumps(entry, sort_keys=True) + "\n"
        with self._log_lock, open(self.dest / LOG_NAME, "a", encoding="utf-8") as fh:
            fh.write(line)


class FerryHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ferry"
    timeout = 60

    server: FerryServer

    # The default logger prints the request line, which holds the token.
    def log_message(self, format, *args):  # noqa: A002
        pass

    # -- plumbing

    def _log_once(self) -> None:
        """Write the log line. Called before the reply goes out, so the log is
        never behind what a client has seen."""
        if self._logged:
            return
        self._logged = True
        self.server.write_log(
            {
                "time": now_iso(),
                "method": self.command,
                "name": self._name,
                "bytes": self._bytes,
                "sha256": self._sha,
                "status": self._status,
                "origin": self.headers.get("Origin"),
            }
        )

    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self._status = status
        self._log_once()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in {**CORS_HEADERS, **(extra or {})}.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, obj: dict) -> None:
        self._send(status, json.dumps(obj).encode() + b"\n", "application/json")

    def _handle(self, fn) -> None:
        self._status = 0
        self._logged = False
        self._name = None
        self._bytes = None
        self._sha = None
        self.server.begin()
        try:
            fn()
        except (BrokenPipeError, ConnectionResetError, TimeoutError, socket.timeout):
            self.close_connection = True
            self._status = self._status or 499
        except Exception as exc:  # a bug must not kill the server
            self.close_connection = True
            with contextlib.suppress(OSError):
                self._json(500, {"error": f"server error: {type(exc).__name__}"})
        finally:
            try:
                self._log_once()
            finally:
                self.server.end()

    def _route(self):
        """Return the part of the path after a valid token, or None."""
        path = urlsplit(self.path).path.lstrip("/")
        token, _, tail = path.partition("/")
        if not hmac.compare_digest(token.encode(), self.server.token.encode()):
            return None
        return tail

    def _not_found(self) -> None:
        self._json(404, {"error": "not found"})

    # -- verbs

    def do_OPTIONS(self):
        def run():
            self._status = 204
            self._log_once()
            self.send_response(204)
            for k, v in CORS_HEADERS.items():
                self.send_header(k, v)
            self.send_header("Content-Length", "0")
            self.end_headers()

        self._handle(run)

    def do_GET(self):
        self._handle(self._get)

    do_HEAD = do_GET

    def do_POST(self):
        self._handle(self._post)

    do_PUT = do_POST

    def _get(self) -> None:
        tail = self._route()
        if tail is None:
            return self._not_found()
        if tail == "":
            self._name = "(upload page)"
            return self._send(200, UPLOAD_PAGE.encode(), "text/html; charset=utf-8")
        if tail.startswith("down/"):
            return self._download(unquote(tail[5:]))
        self._not_found()

    def _post(self) -> None:
        tail = self._route()
        if tail is None or not tail.startswith("up/"):
            # An unread body would corrupt the next request on a kept-alive connection.
            length = self.headers.get("Content-Length", "")
            self._drain(int(length) if length.isdigit() else 0)
            self.close_connection = True
            return self._not_found()
        name = safe_name(unquote(tail[3:]))
        self._name = name
        raw_len = self.headers.get("Content-Length")
        if raw_len is None or not raw_len.isdigit():
            self.close_connection = True
            return self._json(411, {"error": "Content-Length required"})
        length = int(raw_len)
        if length > self.server.max_bytes:
            self._drain(length)
            self.close_connection = True
            return self._json(413, {"error": f"too large, limit is {self.server.max_bytes} bytes"})
        tmp = self.server.dest / f".ferry-{secrets.token_hex(6)}.part"
        digest = hashlib.sha256()
        received = 0
        try:
            with open(tmp, "wb") as fh:
                while received < length:
                    chunk = self.rfile.read(min(CHUNK, length - received))
                    if not chunk:
                        self.close_connection = True
                        return self._json(400, {"error": "body ended early"})
                    fh.write(chunk)
                    digest.update(chunk)
                    received += len(chunk)
            final = reserve_name(self.server.dest, name)
            os.replace(tmp, final)
        finally:
            with contextlib.suppress(FileNotFoundError):
                tmp.unlink()
        self._name, self._bytes, self._sha = final.name, received, digest.hexdigest()
        self._json(201, {"saved": final.name, "bytes": received, "sha256": self._sha})

    def _drain(self, length: int) -> None:
        """Read and discard a refused body, so the client can read the 413.

        Capped: a huge body is not worth reading, and the client just sees the
        connection close.
        """
        left = min(length, DRAIN_LIMIT)
        while left > 0:
            chunk = self.rfile.read(min(CHUNK, left))
            if not chunk:
                return
            left -= len(chunk)

    def _download(self, name: str) -> None:
        serve_dir = self.server.serve_dir
        if serve_dir is None:
            return self._not_found()
        # Flat names only: no separators, no leading dot, so no way out of the folder.
        if not name or "/" in name or "\\" in name or name.startswith(".") or "\x00" in name:
            return self._not_found()
        path = serve_dir / name
        if not path.is_file():
            return self._not_found()
        self._name = name
        size = path.stat().st_size
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        ascii_name = re.sub(r'[^A-Za-z0-9._-]', "_", name)
        disposition = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"
        self._status = 200
        self._bytes = size if self.command != "HEAD" else 0
        self._log_once()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", disposition)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            with open(path, "rb") as fh:
                while chunk := fh.read(CHUNK):
                    self.wfile.write(chunk)


def make_server(
    dest: Path,
    token: str,
    serve_dir: Path | None = None,
    max_bytes: int = int(DEFAULT_MAX_MB * 1024 * 1024),
    port: int = 0,
) -> FerryServer:
    """Build the receiver. It binds to 127.0.0.1 only, whatever the caller asks."""
    dest.mkdir(parents=True, exist_ok=True)
    if serve_dir is not None:
        serve_dir.mkdir(parents=True, exist_ok=True)
    return FerryServer(("127.0.0.1", port), dest, token, serve_dir, max_bytes)


def run_server(server: FerryServer, idle: float) -> str:
    """Serve until stopped. Returns why it stopped: "idle", "signal" or "stopped"."""
    done = threading.Event()

    def watch() -> None:
        interval = min(1.0, idle / 4)
        while not done.wait(interval):
            if server.idle_for() >= idle:
                server.stop_reason = "idle"
                server.shutdown()
                return

    watcher = None
    if idle > 0:
        watcher = threading.Thread(target=watch, daemon=True)
        watcher.start()
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        done.set()
        server.server_close()
    return server.stop_reason or "stopped"


# --- tailscale ---------------------------------------------------------------

TAILSCALE_FIX = (
    "tailscale needs permission to change `serve` settings. Either run once:\n"
    "    sudo tailscale set --operator=$USER\n"
    "or allow passwordless sudo for tailscale. To skip tailscale and stay on this machine, use --no-tailscale."
)


def run_tailscale(args: list[str], sudo_fallback: bool = False) -> subprocess.CompletedProcess:
    """Run `tailscale serve ...` or `tailscale status ...`. Nothing else, ever.

    The allow-list is deliberate: `tailscale funnel` would put the receiver on the
    public internet, and ferry must never do that.
    """
    if not args or args[0] not in ("serve", "status"):
        raise FerryError(f"refusing to run `tailscale {' '.join(args)}`: ferry only uses serve and status")
    if "funnel" in args:
        raise FerryError("refusing to use funnel: ferry is tailnet only")
    kw = {"capture_output": True, "text": True, "stdin": subprocess.DEVNULL, "timeout": 30}
    try:
        first = subprocess.run(["tailscale", *args], **kw)
    except FileNotFoundError:
        raise FerryError(
            "tailscale is not installed or not on PATH. Use --no-tailscale to stay on this machine."
        ) from None
    except subprocess.TimeoutExpired:
        raise FerryError(f"`tailscale {' '.join(args)}` timed out") from None
    if first.returncode == 0 or not sudo_fallback:
        return first
    try:
        second = subprocess.run(["sudo", "-n", "tailscale", *args], **kw)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return first
    return second if second.returncode == 0 else first


def tailscale_host() -> str:
    res = run_tailscale(["status", "--json"])
    if res.returncode != 0:
        raise FerryError(f"tailscale status failed: {(res.stderr or res.stdout).strip()}")
    try:
        name = json.loads(res.stdout)["Self"]["DNSName"]
    except (ValueError, KeyError, TypeError):
        raise FerryError("could not read this machine's MagicDNS name from `tailscale status --json`") from None
    name = name.rstrip(".")
    if not name:
        raise FerryError("this machine has no MagicDNS name. Enable MagicDNS and HTTPS in the tailnet admin page.")
    return name


def tailscale_serve_ports() -> set[int]:
    """Ports `tailscale serve` already uses. Empty if it cannot be read."""
    try:
        res = run_tailscale(["serve", "status", "--json"])
        if res.returncode != 0 or not res.stdout.strip():
            return set()
        return {int(p) for p in (json.loads(res.stdout).get("TCP") or {})}
    except (FerryError, ValueError, AttributeError):
        return set()


def tailscale_serve_on(port: int) -> None:
    res = run_tailscale(["serve", "--bg", f"--https={port}", f"http://127.0.0.1:{port}"], sudo_fallback=True)
    if res.returncode != 0:
        detail = (res.stderr or res.stdout).strip()
        raise FerryError(f"tailscale serve failed: {detail}\n{TAILSCALE_FIX}")


def tailscale_serve_off(port: int) -> bool:
    """Turn off the one port ferry opened. Returns whether tailscale said yes."""
    try:
        return run_tailscale(["serve", f"--https={port}", "off"], sudo_fallback=True).returncode == 0
    except FerryError:
        return False


# --- state -------------------------------------------------------------------


def state_dir() -> Path:
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return Path(base) / "ferry"


def state_path(port: int) -> Path:
    return state_dir() / f"{port}.json"


def read_state(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def write_state(port: int, data: dict) -> None:
    d = state_dir()
    d.mkdir(parents=True, exist_ok=True)
    os.chmod(d, 0o700)
    path = state_path(port)
    fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")


def all_states() -> list[dict]:
    d = state_dir()
    if not d.is_dir():
        return []
    out = []
    for p in sorted(d.glob("*.json")):
        st = read_state(p)
        if st and "port" in st:
            out.append(st)
    return out


def pick_state(port: int | None) -> dict | None:
    states = all_states()
    if port is not None:
        return next((s for s in states if s["port"] == port), None)
    if len(states) > 1:
        ports = ", ".join(str(s["port"]) for s in states)
        raise FerryError(f"more than one ferry is running (ports {ports}). Pass --port.")
    return states[0] if states else None


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
        if stat.rsplit(")", 1)[1].split()[0] == "Z":
            return False
    except (OSError, IndexError):
        pass
    return True


def is_ferry_process(pid: int) -> bool:
    """Guard against a recycled PID: only signal a process that looks like ours."""
    try:
        cmd = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
    except OSError:
        res = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True)
        cmd = res.stdout
        if res.returncode != 0 or not cmd:
            return False
    return "ferry" in cmd and "serve" in cmd


def port_listening(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def free_local_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def received_since(state: dict) -> tuple[int, int]:
    """Files and bytes uploaded since this ferry started, from the request log."""
    count = total = 0
    try:
        with open(Path(state["dest"]) / LOG_NAME, encoding="utf-8") as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if e.get("status") == 201 and e.get("time", "") >= state.get("started", ""):
                    count += 1
                    total += e.get("bytes") or 0
    except OSError:
        pass
    return count, total


# --- commands ----------------------------------------------------------------


def choose_port(requested: int, use_tailscale: bool) -> int:
    in_use = tailscale_serve_ports() if use_tailscale else set()
    if requested:
        if requested in in_use:
            raise FerryError(f"port {requested} is already used by `tailscale serve`. See `tailscale serve status`.")
        if port_listening(requested):
            raise FerryError(f"port {requested} is already in use on this machine")
        return requested
    if not use_tailscale:
        return free_local_port()
    for p in PORT_RANGE:
        if p not in in_use and not port_listening(p):
            return p
    raise FerryError(f"no free port in {PORT_RANGE.start}-{PORT_RANGE.stop - 1}. Pass --port.")


def cmd_start(a) -> int:
    dest = Path(a.dest).expanduser().resolve()
    serve_dir = Path(a.serve_dir).expanduser().resolve() if a.serve_dir else None
    use_ts = not a.no_tailscale
    host = tailscale_host() if use_ts else None
    port = choose_port(a.port, use_ts)
    existing = read_state(state_path(port))
    if existing and pid_alive(existing.get("pid", 0)):
        raise FerryError(f"ferry is already running on port {port}. Run `stop` first.")
    dest.mkdir(parents=True, exist_ok=True)
    if serve_dir:
        serve_dir.mkdir(parents=True, exist_ok=True)

    token = secrets.token_urlsafe(24)
    base_url = f"https://{host}:{port}/{token}" if use_ts else f"http://127.0.0.1:{port}/{token}"
    sdir = state_dir()
    sdir.mkdir(parents=True, exist_ok=True)
    os.chmod(sdir, 0o700)
    logfile = sdir / f"{port}.log"
    cmd = [
        sys.executable,
        os.path.abspath(__file__),
        "serve",
        "--dest",
        str(dest),
        "--port",
        str(port),
        "--idle",
        str(a.idle),
        "--max-mb",
        str(a.max_mb),
        "--state-file",
        str(state_path(port)),
    ]
    if serve_dir:
        cmd += ["--serve-dir", str(serve_dir)]
    if not use_ts:
        cmd.append("--no-tailscale")
    env = {**os.environ, "FERRY_TOKEN": token}
    with open(logfile, "ab") as lf:
        proc = subprocess.Popen(cmd, env=env, stdin=subprocess.DEVNULL, stdout=lf, stderr=lf, start_new_session=True)
    os.chmod(logfile, 0o600)

    state = {
        "pid": proc.pid,
        "port": port,
        "token": token,
        "dest": str(dest),
        "serve_dir": str(serve_dir) if serve_dir else None,
        "tailscale": use_ts,
        "base_url": base_url,
        "started": now_iso(),
    }
    write_state(port, state)

    def abort(msg: str) -> FerryError:
        with contextlib.suppress(OSError):
            proc.kill()
        with contextlib.suppress(OSError):
            state_path(port).unlink()
        return FerryError(msg)

    deadline = time.monotonic() + 10
    while not port_listening(port):
        if proc.poll() is not None or time.monotonic() > deadline:
            tail = logfile.read_text(errors="replace")[-600:].strip()
            raise abort(f"the receiver did not start. Log {logfile}:\n{tail}")
        time.sleep(0.05)

    if use_ts:
        try:
            tailscale_serve_on(port)
        except FerryError as exc:
            raise abort(str(exc)) from None

    if a.json:
        print(json.dumps({k: v for k, v in state.items() if k != "started"} | {"upload_page": base_url + "/"}))
        return 0
    print(f"ferry running (pid {proc.pid}, stops itself after {a.idle:g} s idle)")
    print(f"url:         {base_url}")
    print(f"upload page: {base_url}/")
    print(f"dest:        {dest}")
    if serve_dir:
        print(f"serve-dir:   {serve_dir}")
    print(f"stop with:   python3 {os.path.abspath(__file__)} stop --port {port}")
    return 0


def cmd_serve(a) -> int:
    token = os.environ.get("FERRY_TOKEN")
    generated = not token
    token = token or secrets.token_urlsafe(24)
    server = make_server(
        Path(a.dest).expanduser().resolve(),
        token,
        Path(a.serve_dir).expanduser().resolve() if a.serve_dir else None,
        int(a.max_mb * 1024 * 1024),
        a.port,
    )
    port = server.server_address[1]
    if generated:
        print(f"token: {token}", flush=True)
    print(f"ferry listening on 127.0.0.1:{port}", flush=True)

    def on_signal(signum, frame):
        server.stop_reason = "signal"
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    reason = run_server(server, a.idle)
    if reason == "idle":
        print(f"idle for {a.idle:g} s, shutting down", flush=True)
        if not a.no_tailscale:
            tailscale_serve_off(port)
        if a.state_file:
            for leftover in (Path(a.state_file), Path(a.state_file).with_suffix(".log")):
                with contextlib.suppress(OSError):
                    leftover.unlink()
    return 0


def need_state(port: int | None) -> dict:
    st = pick_state(port)
    if not st or not pid_alive(st.get("pid", 0)):
        raise FerryError("ferry is not running. Start it with `start --dest DIR`.")
    return st


def cmd_status(a) -> int:
    st = pick_state(a.port)
    if not st:
        print(json.dumps({"running": False}) if a.json else "ferry is not running")
        return 1
    running = pid_alive(st["pid"]) and port_listening(st["port"])
    count, total = received_since(st)
    if a.json:
        print(json.dumps({"running": running, **st, "received_files": count, "received_bytes": total}))
    else:
        print(f"running:   {'yes' if running else 'no (stale state; run stop)'}")
        print(f"url:       {st['base_url']}")
        print(f"dest:      {st['dest']}")
        if st.get("serve_dir"):
            print(f"serve-dir: {st['serve_dir']}")
        print(f"received:  {count} file(s), {total} bytes since {st['started']}")
    return 0 if running else 1


def cmd_stop(a) -> int:
    states = all_states() if a.all else [s for s in [pick_state(a.port)] if s]
    if not states:
        print("ferry is not running")
        return 0
    for st in states:
        port, pid = st["port"], st.get("pid", 0)
        if st.get("tailscale"):
            ok = tailscale_serve_off(port)
            print(
                f"tailscale serve port {port}: {'off' if ok else 'could not turn off (already off, or no permission)'}"
            )
        if pid and pid_alive(pid) and is_ferry_process(pid):
            os.kill(pid, signal.SIGTERM)
            deadline = time.monotonic() + 5
            while pid_alive(pid) and time.monotonic() < deadline:
                time.sleep(0.05)
            if pid_alive(pid):
                os.kill(pid, signal.SIGKILL)
        count, total = received_since(st)
        for leftover in (state_path(port), state_dir() / f"{port}.log"):
            with contextlib.suppress(OSError):
                leftover.unlink()
        print(f"stopped ferry on port {port}; {count} file(s), {total} bytes were received")
    return 0


def js_fetch_and_send(base: str, src: str, name: str) -> str:
    target = f"{base}/up/{quote(name, safe='')}"
    return (
        "async () => {\n"
        f"  const src = {json.dumps(src)};\n"
        '  const r = await fetch(src, { credentials: "include" });\n'
        '  if (!r.ok) return { ok: false, stage: "read", status: r.status };\n'
        "  const body = await r.arrayBuffer();\n"
        f'  const u = await fetch({json.dumps(target)}, {{ method: "POST", body, credentials: "omit" }});\n'
        "  const out = await u.json().catch(() => ({}));\n"
        "  return { ok: u.ok, status: u.status, ...out };\n"
        "}"
    )


def js_send_variable(base: str, expr: str, name: str) -> str:
    target = f"{base}/up/{quote(name, safe='')}"
    return (
        "async () => {\n"
        f"  const data = JSON.stringify({expr});\n"
        '  if (data === undefined) return { ok: false, stage: "read", error: "expression is undefined" };\n'
        f'  const u = await fetch({json.dumps(target)}, {{ method: "POST", body: data, credentials: "omit" }});\n'
        "  const out = await u.json().catch(() => ({}));\n"
        "  return { ok: u.ok, status: u.status, ...out };\n"
        "}"
    )


def cmd_snippet(a) -> int:
    if bool(a.url) == bool(a.var):
        raise FerryError("give exactly one of --url or --var")
    st = need_state(a.port)
    base = st["base_url"]
    print(js_fetch_and_send(base, a.url, a.name) if a.url else js_send_variable(base, a.var, a.name))
    return 0


def cmd_share(a) -> int:
    st = need_state(a.port)
    if not st.get("serve_dir"):
        raise FerryError("this ferry has no --serve-dir. Stop it and start again with --serve-dir DIR.")
    src = Path(a.file).expanduser().resolve()
    if not src.is_file():
        raise FerryError(f"not a file: {a.file}")
    serve_dir = Path(st["serve_dir"])
    serve_dir.mkdir(parents=True, exist_ok=True)
    name = safe_name(src.name)
    if a.link:
        n = 0
        while True:
            target = serve_dir / numbered(name, n)
            try:
                os.symlink(src, target)
                break
            except FileExistsError:
                n += 1
    else:
        target = reserve_name(serve_dir, name)
        shutil.copyfile(src, target)
    print(f"{st['base_url']}/down/{quote(target.name)}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="ferry.py", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="command", required=True)

    def port_arg(sp):
        sp.add_argument("--port", type=int, help="which ferry, if more than one is running")

    s = sub.add_parser("start", help="start the receiver and print its URL")
    s.add_argument("--dest", required=True, help="folder for received files (use a folder in the project's git repo)")
    s.add_argument(
        "--port", type=int, default=0, help="local and tailscale HTTPS port (default: first free from 10002)"
    )
    s.add_argument("--serve-dir", help="folder to offer for download (enables `share` and /down/)")
    s.add_argument(
        "--idle", type=float, default=DEFAULT_IDLE, help="stop after this many idle seconds, 0 to never (default 3600)"
    )
    s.add_argument("--max-mb", type=float, default=DEFAULT_MAX_MB, help="largest single upload in MB (default 512)")
    s.add_argument("--no-tailscale", action="store_true", help="serve on 127.0.0.1 only; no tailscale")
    s.add_argument("--json", action="store_true", help="print the result as JSON")
    s.set_defaults(fn=cmd_start)

    s = sub.add_parser("serve", help="the foreground server that `start` launches")
    s.add_argument("--dest", required=True)
    s.add_argument("--port", type=int, default=0)
    s.add_argument("--serve-dir")
    s.add_argument("--idle", type=float, default=DEFAULT_IDLE)
    s.add_argument("--max-mb", type=float, default=DEFAULT_MAX_MB)
    s.add_argument("--no-tailscale", action="store_true")
    s.add_argument("--state-file", help="removed when the server stops itself")
    s.set_defaults(fn=cmd_serve)

    s = sub.add_parser("stop", help="turn the tailscale port off, stop the server, remove state")
    port_arg(s)
    s.add_argument("--all", action="store_true", help="stop every ferry")
    s.set_defaults(fn=cmd_stop)

    s = sub.add_parser("status", help="is it running, its URL, files received")
    port_arg(s)
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_status)

    s = sub.add_parser("snippet", help="print JS for the browser tool that sends data to ferry")
    s.add_argument("--name", required=True, help="file name to save as")
    s.add_argument("--url", help="fetch this URL in the page (with its session) and send the bytes")
    s.add_argument("--var", help="JS expression in the page, sent as JSON (for example window.__data)")
    port_arg(s)
    s.set_defaults(fn=cmd_snippet)

    s = sub.add_parser("share", help="make a file downloadable and print its URL")
    s.add_argument("file")
    s.add_argument("--link", action="store_true", help="symlink instead of copying")
    port_arg(s)
    s.set_defaults(fn=cmd_share)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.fn(args)
    except FerryError as exc:
        print(f"ferry: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
