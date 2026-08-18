#!/usr/bin/env python3
"""HTTP wrapper that runs catalog fetch scripts inside this Ubuntu image."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
BIND = os.environ.get("CURSEFORGE_FETCH_BIND", "127.0.0.1")
PORT = int(os.environ.get("CURSEFORGE_FETCH_PORT", "37851"))
TIMEOUT = int(os.environ.get("CURSEFORGE_FETCH_TIMEOUT", str(20 * 60)))
ALLOWED_ROOT = Path(os.environ.get("CURSEFORGE_FETCH_WORKDIR", "/tmp/mc-cf-import")).resolve()
MAX_BODY = 16 * 1024
SCRIPTS = (
    ("https://www.curseforge.com/minecraft-bedrock", SCRIPT_DIR / "fetch-curseforge-mod.py"),
    ("https://mcpedl.com", SCRIPT_DIR / "fetch-mcpedl-mod.py"),
    ("https://www.mcpedl.com", SCRIPT_DIR / "fetch-mcpedl-mod.py"),
)


def _script_for_url(url: str) -> Path | None:
    for prefix, script in SCRIPTS:
        if url.startswith(prefix):
            return script
    return None


def _safe_root(root: str) -> Path:
    path = Path(root).expanduser().resolve()
    try:
        path.relative_to(ALLOWED_ROOT)
    except ValueError as exc:
        raise ValueError("root is outside the shared fetch directory") from exc
    if not path.is_dir():
        raise ValueError("root directory does not exist")
    return path


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.rstrip("/") in ("", "/health"):
            self._send_json(200, {"ok": True})
            return
        self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/fetch":
            self._send_json(404, {"ok": False, "error": "not found"})
            return
        length = int(self.headers.get("Content-Length") or "0")
        if length <= 0 or length > MAX_BODY:
            self._send_json(400, {"ok": False, "error": "invalid request body"})
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"ok": False, "error": "invalid JSON"})
            return

        url = str(body.get("url") or "").strip()
        root = str(body.get("root") or "").strip()
        script = _script_for_url(url)
        if script is None:
            self._send_json(400, {"ok": False, "error": "URL is not a supported CurseForge or MCPEDL project address"})
            return
        try:
            work_root = _safe_root(root)
        except ValueError as exc:
            self._send_json(400, {"ok": False, "error": str(exc)})
            return

        print(f"Fetching {url} into {work_root}", flush=True)
        try:
            result = subprocess.run(
                [sys.executable, str(script), url, "--root", str(work_root)],
                check=False,
                capture_output=True,
                text=True,
                timeout=TIMEOUT,
                env={
                    **os.environ,
                    "PYTHONIOENCODING": "utf-8",
                    "PYTHONUTF8": "1",
                },
            )
        except subprocess.TimeoutExpired:
            self._send_json(504, {"ok": False, "error": "Catalog import timed out after 20 minutes"})
            return

        if result.stderr:
            sys.stderr.write(result.stderr)
            if not result.stderr.endswith("\n"):
                sys.stderr.write("\n")
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "").strip()
            if detail.lower().startswith("error:"):
                detail = detail[6:].strip()
            self._send_json(400, {
                "ok": False,
                "error": detail or f"Python exited with code {result.returncode}",
            })
            return
        self._send_json(200, {"ok": True})


def main() -> int:
    missing = [str(script) for _, script in SCRIPTS if not script.is_file()]
    if missing:
        print(f"Missing fetch script(s): {', '.join(missing)}", file=sys.stderr)
        return 1
    ALLOWED_ROOT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"Catalog fetch sidecar listening on {BIND}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
