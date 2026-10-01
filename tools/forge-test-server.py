#!/usr/bin/env python3
"""Serve a disposable, fixture-backed Forge `/api/operations` endpoint.

The server is intentionally loopback-only and has no production URL or
credentials. `ci/test-artifact --forge-e2e` changes the scenario named in the
state file between requests to exercise connected, stale, and unreachable
behaviour against a real HTTP endpoint.
"""

from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--state-file", type=Path, required=True)
    parser.add_argument("--port", type=int, default=0)
    return parser.parse_args()


class ForgeHandler(BaseHTTPRequestHandler):
    server_version = "ActionViewForgeTest/1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
        parsed = urlparse(self.path)
        if parsed.path == "/healthz":
            self._send(200, {"status": "ok"})
            return
        if parsed.path != "/api/operations":
            self._send(404, {"error": "not found"})
            return
        query = parse_qs(parsed.query)
        scenario = query.get("scenario", [""])[0]
        if not scenario:
            try:
                scenario = self.server.state_file.read_text(encoding="utf-8").strip()
            except FileNotFoundError:
                scenario = "base"
        if scenario == "offline":
            self._send(503, {"error": "fixture backend offline"})
            return
        if scenario not in {
            "base",
            "collector-hung",
            "source-stale",
            "schema-future",
            "concluded-failure",
            "running",
            "queued",
        }:
            self._send(400, {"error": f"unknown scenario: {scenario}"})
            return
        path = self.server.fixtures / f"{scenario}.json"
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError) as exc:
            self._send(500, {"error": str(exc)})
            return
        self._send(200, payload)

    def _send(self, status: int, payload: object) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ForgeServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], fixtures: Path, state_file: Path):
        super().__init__(address, ForgeHandler)
        self.fixtures = fixtures
        self.state_file = state_file


def main() -> int:
    args = parse_args()
    server = ForgeServer(("127.0.0.1", args.port), args.fixtures.resolve(), args.state_file.resolve())
    print(f"READY http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
