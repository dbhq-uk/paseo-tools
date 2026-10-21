"""Tests for ferry. No network and no tailscale: everything runs on 127.0.0.1."""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import ferry

TOKEN = "test-token-abc123"


class Rig:
    """A running receiver on an ephemeral port, plus a tiny HTTP client."""

    def __init__(self, tmp_path: Path, serve_dir: bool = False, max_bytes: int = 1 << 20):
        self.dest = tmp_path / "dest"
        self.serve_dir = tmp_path / "serve" if serve_dir else None
        self.server = ferry.make_server(self.dest, TOKEN, self.serve_dir, max_bytes, port=0)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            resp = conn.getresponse()
            data = resp.read()
            return resp.status, {k.lower(): v for k, v in resp.getheaders()}, data
        finally:
            conn.close()

    def upload(self, name, data, token=TOKEN, headers=None):
        status, hdrs, body = self.request("POST", f"/{token}/up/{name}", data, headers)
        return status, json.loads(body) if body.strip().startswith(b"{") else body

    def log(self):
        path = self.dest / ferry.LOG_NAME
        return [json.loads(line) for line in path.read_text().splitlines()]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def rig(tmp_path):
    r = Rig(tmp_path)
    yield r
    r.close()


@pytest.fixture
def rig_serve(tmp_path):
    r = Rig(tmp_path, serve_dir=True)
    yield r
    r.close()


def files(directory: Path):
    return sorted(p.name for p in directory.iterdir() if p.name != ferry.LOG_NAME)


# --- token -------------------------------------------------------------------


def test_token_required(rig):
    for method, path in [
        ("GET", "/"),
        ("GET", "/wrong/"),
        ("POST", "/up/a.txt"),
        ("POST", "/wrong/up/a.txt"),
        ("GET", "/wrong/down/a.txt"),
        ("PUT", "/wrong/up/a.txt"),
    ]:
        status, _, _ = rig.request(method, path, b"data" if method != "GET" else None)
        assert status == 404, (method, path)
    assert files(rig.dest) == []


def test_token_prefix_is_not_enough(rig):
    status, _, _ = rig.request("GET", f"/{TOKEN[:-1]}/")
    assert status == 404
    status, _, _ = rig.request("GET", f"/{TOKEN}x/")
    assert status == 404


def test_upload_page_served_with_token(rig):
    status, hdrs, body = rig.request("GET", f"/{TOKEN}/")
    assert status == 200
    assert hdrs["content-type"].startswith("text/html")
    assert b'type="file"' in body
    assert b"drop" in body


# --- upload ------------------------------------------------------------------


def test_upload_writes_exact_bytes_and_returns_sha256(rig):
    data = os.urandom(300_000) + b"\x00\xff\r\n"
    status, out = rig.upload("blob.bin", data)
    assert status == 201
    assert out == {"saved": "blob.bin", "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    assert (rig.dest / "blob.bin").read_bytes() == data


def test_put_is_accepted_like_post(rig):
    status, _, body = rig.request("PUT", f"/{TOKEN}/up/put.txt", b"hello")
    assert status == 201
    assert (rig.dest / "put.txt").read_bytes() == b"hello"


def test_empty_body_is_saved(rig):
    status, out = rig.upload("empty.txt", b"")
    assert status == 201 and out["bytes"] == 0
    assert (rig.dest / "empty.txt").read_bytes() == b""


def test_never_overwrites(rig):
    names = [rig.upload("a.json", f"v{i}".encode())[1]["saved"] for i in range(3)]
    assert names == ["a.json", "a-1.json", "a-2.json"]
    assert (rig.dest / "a.json").read_bytes() == b"v0"
    assert (rig.dest / "a-2.json").read_bytes() == b"v2"


def test_no_overwrite_without_extension(rig):
    assert rig.upload("notes", b"1")[1]["saved"] == "notes"
    assert rig.upload("notes", b"2")[1]["saved"] == "notes-1"


def test_parallel_uploads_of_one_name_all_survive(rig):
    results = []

    def go(i):
        results.append(rig.upload("same.txt", f"body {i}".encode())[1]["saved"])

    threads = [threading.Thread(target=go, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(set(results)) == 8
    assert len(files(rig.dest)) == 8


def test_missing_content_length_is_refused(rig):
    sock = socket.create_connection(("127.0.0.1", rig.port), timeout=5)
    sock.sendall(f"POST /{TOKEN}/up/x.txt HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n".encode())
    reply = sock.recv(4096)
    sock.close()
    assert b" 411 " in reply.split(b"\r\n")[0]
    assert files(rig.dest) == []


# --- names -------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("../x", "x"),
        ("..%2Fx", "x"),
        ("%2e%2e%2f%2e%2e%2fetc%2fpasswd", "passwd"),
        ("a/b/c.txt", "c.txt"),
        ("..%5C..%5Cx.txt", "x.txt"),
        ("C:%5Cdir%5Cfile.csv", "file.csv"),
        (".hidden", "hidden"),
        ("..", "upload"),
        (".", "upload"),
        ("", "upload"),
        ("/", "upload"),
        ("my%20file%20(1).json", "my_file__1_.json"),
        ("caf%C3%A9.txt", "caf_.txt"),
    ],
)
def test_names_are_sanitised(rig, raw, expected):
    status, out = rig.upload(raw, b"x")
    assert status == 201, out
    assert out["saved"] == expected
    # Nothing escaped the destination folder.
    assert files(rig.dest.parent) == ["dest"]
    assert files(rig.dest) == [expected]


def test_log_file_cannot_be_overwritten_by_name(rig):
    status, out = rig.upload(ferry.LOG_NAME, b"evil")
    assert status == 201
    assert out["saved"] == ferry.LOG_NAME.lstrip(".")
    assert b"evil" not in (rig.dest / ferry.LOG_NAME).read_bytes()


def test_safe_name_is_bounded():
    assert len(ferry.safe_name("a" * 1000 + ".txt")) <= 150


# --- size cap ----------------------------------------------------------------


def test_size_cap_rejected(tmp_path):
    r = Rig(tmp_path, max_bytes=1024)
    try:
        status, out = r.upload("big.bin", b"x" * 2048)
        assert status == 413
        assert "too large" in out["error"]
        assert files(r.dest) == []  # no file and no leftover temp part
        status, out = r.upload("ok.bin", b"x" * 1024)  # exactly at the cap
        assert status == 201
    finally:
        r.close()


# --- CORS --------------------------------------------------------------------


@pytest.mark.parametrize("path", ["/", f"/{TOKEN}/up/x", "/anything/at/all"])
def test_options_preflight(rig, path):
    status, hdrs, body = rig.request(
        "OPTIONS",
        path,
        headers={
            "Origin": "https://example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Private-Network": "true",
        },
    )
    assert status == 204
    assert body == b""
    assert hdrs["access-control-allow-origin"] == "*"
    assert hdrs["access-control-allow-headers"] == "*"
    assert hdrs["access-control-allow-private-network"] == "true"
    assert "POST" in hdrs["access-control-allow-methods"]
    assert "OPTIONS" in hdrs["access-control-allow-methods"]


def test_cors_headers_on_errors_too(rig):
    _, hdrs, _ = rig.request("GET", "/wrong/")
    assert hdrs["access-control-allow-origin"] == "*"


# --- download ----------------------------------------------------------------


def test_download_from_serve_dir(rig_serve):
    data = os.urandom(5000)
    (rig_serve.serve_dir / "report.pdf").write_bytes(data)
    status, hdrs, body = rig_serve.request("GET", f"/{TOKEN}/down/report.pdf")
    assert status == 200
    assert body == data
    assert hdrs["content-disposition"].startswith("attachment")
    assert "report.pdf" in hdrs["content-disposition"]
    assert hdrs["content-length"] == str(len(data))


def test_download_cannot_leave_serve_dir(rig_serve):
    (rig_serve.dest / "secret.txt").write_text("secret")
    (rig_serve.serve_dir / ".hidden").write_text("h")
    for path in [
        "down/..%2Fdest%2Fsecret.txt",
        "down/../dest/secret.txt",
        "down/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
        "down/..%5Csecret.txt",
        "down/.hidden",
        "down/missing.txt",
        "down/",
        "down/sub/x",
    ]:
        status, _, body = rig_serve.request("GET", f"/{TOKEN}/{path}")
        assert status == 404, path
        assert b"secret" not in body


def test_upload_dest_is_not_downloadable(rig_serve):
    rig_serve.upload("got.txt", b"uploaded")
    status, _, _ = rig_serve.request("GET", f"/{TOKEN}/down/got.txt")
    assert status == 404


def test_download_404_without_serve_dir(rig):
    status, _, _ = rig.request("GET", f"/{TOKEN}/down/anything.txt")
    assert status == 404


def test_download_is_read_only(rig_serve):
    status, _, _ = rig_serve.request("POST", f"/{TOKEN}/down/x.txt", b"data")
    assert status == 404
    assert files(rig_serve.serve_dir) == []


# --- idle shutdown -----------------------------------------------------------


def test_idle_shutdown(tmp_path):
    server = ferry.make_server(tmp_path / "d", TOKEN, port=0)
    result = []
    t = threading.Thread(target=lambda: result.append(ferry.run_server(server, idle=0.4)))
    t.start()
    t.join(timeout=10)
    assert not t.is_alive(), "server did not stop itself"
    assert result == ["idle"]
    with pytest.raises(OSError):
        socket.create_connection(server.server_address, timeout=1)


def test_activity_defers_idle_shutdown(tmp_path):
    server = ferry.make_server(tmp_path / "d", TOKEN, port=0)
    port = server.server_address[1]
    result = []
    t = threading.Thread(target=lambda: result.append(ferry.run_server(server, idle=1.5)))
    t.start()
    start = time.monotonic()
    try:
        while time.monotonic() - start < 2.4:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/{TOKEN}/", timeout=2).read()
            time.sleep(0.3)
        assert t.is_alive(), "stopped despite steady traffic"
    finally:
        t.join(timeout=10)
    assert result == ["idle"]


# --- log ---------------------------------------------------------------------


def test_log_line_written(rig):
    data = b"logged"
    rig.upload("l.txt", data, headers={"Origin": "https://shop.example"})
    rig.request("GET", "/wrong/")
    entries = rig.log()
    up = entries[0]
    assert up["method"] == "POST"
    assert up["name"] == "l.txt"
    assert up["bytes"] == len(data)
    assert up["sha256"] == hashlib.sha256(data).hexdigest()
    assert up["status"] == 201
    assert up["origin"] == "https://shop.example"
    assert up["time"].endswith("Z")
    assert entries[1]["status"] == 404
    assert entries[1]["name"] is None


def test_log_never_holds_the_token(rig):
    rig.upload("l.txt", b"x")
    rig.request("GET", f"/{TOKEN}x/guess")
    assert TOKEN not in (rig.dest / ferry.LOG_NAME).read_text()


# --- binding and tailscale guard ---------------------------------------------


def test_binds_to_loopback_only(rig):
    assert rig.server.server_address[0] == "127.0.0.1"


@pytest.mark.parametrize("args", [["funnel", "--bg", "10002"], ["serve", "funnel", "on"], ["set", "--operator=x"], []])
def test_tailscale_helper_refuses_anything_but_serve_and_status(args):
    with pytest.raises(ferry.FerryError):
        ferry.run_tailscale(args)


# --- snippets ----------------------------------------------------------------


BASE = "https://host.example.ts.net:10002/tok"


def test_fetch_snippet_shape():
    js = ferry.js_fetch_and_send(BASE, "/product/42", "p 42.html")
    assert js.startswith("async () => {")
    assert '"/product/42"' in js
    assert 'credentials: "include"' in js  # the page's own session, for the read
    assert 'credentials: "omit"' in js  # never the cookies to ferry
    assert f"{BASE}/up/p%2042.html" in js


def test_variable_snippet_shape():
    js = ferry.js_send_variable(BASE, "window.__cf", "cf.json")
    assert "JSON.stringify(window.__cf)" in js
    assert f"{BASE}/up/cf.json" in js
    assert 'credentials: "omit"' in js


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_snippets_are_valid_javascript(tmp_path):
    for i, js in enumerate(
        [
            ferry.js_fetch_and_send(BASE, 'https://x.example/a"b', 'we"ird.txt'),
            ferry.js_send_variable(BASE, "({a: 1})", "v.json"),
        ]
    ):
        f = tmp_path / f"s{i}.js"
        f.write_text(f"const f = {js};\n")
        assert subprocess.run(["node", "--check", str(f)], capture_output=True).returncode == 0


# --- the CLI, end to end -----------------------------------------------------


def cli(env, *args, check=True):
    res = subprocess.run(
        [sys.executable, str(SCRIPTS / "ferry.py"), *args], capture_output=True, text=True, env=env, timeout=60
    )
    if check:
        assert res.returncode == 0, res.stderr + res.stdout
    return res


def test_cli_start_use_stop(tmp_path):
    env = {**os.environ, "XDG_STATE_HOME": str(tmp_path / "state")}
    dest, serve = tmp_path / "dest", tmp_path / "serve"
    info = json.loads(
        cli(env, "start", "--no-tailscale", "--dest", str(dest), "--serve-dir", str(serve), "--json").stdout
    )
    try:
        base = info["base_url"]
        assert base.startswith("http://127.0.0.1:")
        state_file = tmp_path / "state" / "ferry" / f"{info['port']}.json"
        assert oct(state_file.stat().st_mode & 0o777) == "0o600"

        data = os.urandom(2000)
        req = urllib.request.Request(f"{base}/up/cli.bin", data=data, method="POST")
        out = json.loads(urllib.request.urlopen(req, timeout=10).read())
        assert out["sha256"] == hashlib.sha256(data).hexdigest()
        assert (dest / "cli.bin").read_bytes() == data

        status = json.loads(cli(env, "status", "--json").stdout)
        assert status["running"] is True
        assert status["received_files"] == 1 and status["received_bytes"] == len(data)

        src = tmp_path / "hand-over.txt"
        src.write_text("for the device")
        url = cli(env, "share", str(src)).stdout.strip()
        assert url == f"{base}/down/hand-over.txt"
        assert urllib.request.urlopen(url, timeout=10).read() == b"for the device"
        assert cli(env, "share", str(src)).stdout.strip().endswith("/down/hand-over-1.txt")

        js = cli(env, "snippet", "--name", "x.json", "--var", "window.__cf").stdout
        assert f"{base}/up/x.json" in js
        assert cli(env, "snippet", "--name", "x", check=False).returncode == 2
    finally:
        stop = cli(env, "stop", check=False)
    assert "stopped ferry" in stop.stdout
    with pytest.raises(urllib.error.URLError):
        urllib.request.urlopen(f"{base}/", timeout=2)
    assert list((tmp_path / "state" / "ferry").iterdir()) == []  # no state, no stray log
    assert cli(env, "status", check=False).returncode == 1


def test_cli_stop_when_nothing_runs(tmp_path):
    env = {**os.environ, "XDG_STATE_HOME": str(tmp_path / "state")}
    res = cli(env, "stop")
    assert "not running" in res.stdout


def test_cli_share_needs_serve_dir(tmp_path):
    env = {**os.environ, "XDG_STATE_HOME": str(tmp_path / "state")}
    cli(env, "start", "--no-tailscale", "--dest", str(tmp_path / "d"))
    try:
        f = tmp_path / "f.txt"
        f.write_text("x")
        res = cli(env, "share", str(f), check=False)
        assert res.returncode == 2
        assert "--serve-dir" in res.stderr
    finally:
        cli(env, "stop")
