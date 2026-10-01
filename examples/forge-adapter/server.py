#!/usr/bin/env python3
"""Read-only Forge adapter for GitHub Actions.

This is a small public reference backend for ActionView. It reads the GitHub
Actions REST API and exposes the same `/api/operations` path as the full Forge
dashboard. It never accepts workflow control requests and never invents jobs,
runners, or metrics when the upstream API does not provide them.

Configuration is entirely environment-driven:

  GITHUB_TOKEN       optional read-only token (Actions/Metadata read)
  GITHUB_ORG         organization, default KanterLabs
  GITHUB_REPOS       optional comma-separated owner/repo list; when empty the
                     adapter lists public repositories in GITHUB_ORG
  GITHUB_API_URL     API origin, default https://api.github.com
  FORGE_BIND         bind address, default 127.0.0.1
  FORGE_PORT         listen port, default 8090
  FORGE_CACHE_SECONDS response cache, default 5

Run this behind an HTTPS reverse proxy before pointing a desktop at it. The
token is read from the process environment and is never returned in payloads
or error messages.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock
from typing import Any


SCHEMA_VERSION = 5
ACTIVE_STATES = {"queued", "in_progress", "waiting", "requested", "pending"}
REPOSITORY_RE = re.compile(r"^[^/\s]+/[^/\s]+$")
MAX_RESPONSE_BYTES = 4 * 1024 * 1024


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def as_text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


class GitHubError(RuntimeError):
    """An upstream failure safe to expose as a short source error."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Reject redirects so a bearer token never follows an untrusted origin."""

    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        raise GitHubError("GitHub API returned a redirect")


class GitHubAPI:
    def __init__(self, environment: dict[str, str] | None = None):
        values = dict(os.environ if environment is None else environment)
        self.origin = values.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")
        self.origin_error = None
        try:
            parsed_origin = urllib.parse.urlsplit(self.origin)
            if (parsed_origin.scheme not in {"http", "https"} or not parsed_origin.hostname or
                    parsed_origin.username or parsed_origin.password or parsed_origin.query or
                    parsed_origin.fragment or parsed_origin.path not in {"", "/"}):
                self.origin_error = "GITHUB_API_URL must be an HTTP(S) origin without credentials, path, or query"
        except ValueError:
            self.origin_error = "GITHUB_API_URL is malformed"
        self.org = values.get("GITHUB_ORG", "KanterLabs").strip() or "KanterLabs"
        self.token = values.get("GITHUB_TOKEN", "").strip()
        self.repos = []
        self.repository_error = None
        for item in values.get("GITHUB_REPOS", "").split(","):
            item = item.strip()
            if item:
                try:
                    self.repos.append(self.validate_repository(item))
                except GitHubError as error:
                    self.repository_error = str(error)
                    break
        try:
            self.timeout = max(1, int(values.get("GITHUB_TIMEOUT_SECONDS", "8")))
        except ValueError:
            self.timeout = 8

    @staticmethod
    def validate_repository(repository: str) -> str:
        if not REPOSITORY_RE.fullmatch(repository):
            raise GitHubError("GITHUB_REPOS must contain owner/name values")
        owner, name = repository.split("/", 1)
        if owner in {".", ".."} or name in {".", ".."}:
            raise GitHubError("GITHUB_REPOS contains an invalid repository")
        return repository

    def request(self, path: str, query: dict[str, str] | None = None) -> Any:
        if self.origin_error:
            raise GitHubError(self.origin_error)
        if not path.startswith("/") or ".." in path.split("/"):
            raise GitHubError("GitHub API path is invalid")
        url = f"{self.origin}{path}"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "ActionView-forge-adapter/0.1",
                **({"Authorization": f"Bearer {self.token}"} if self.token else {}),
            },
        )
        try:
            opener = urllib.request.build_opener(NoRedirect)
            with opener.open(request, timeout=self.timeout) as response:
                body = response.read()
                if len(body) > MAX_RESPONSE_BYTES:
                    raise GitHubError("GitHub API response was too large")
        except urllib.error.HTTPError as error:
            raise GitHubError(f"GitHub API HTTP {error.code}") from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise GitHubError(f"GitHub API network error: {type(error).__name__}") from error
        try:
            value = json.loads(body)
        except json.JSONDecodeError as error:
            raise GitHubError("GitHub API returned invalid JSON") from error
        return value

    def repository_names(self) -> list[str]:
        if self.repository_error:
            raise GitHubError(self.repository_error)
        if self.repos:
            return list(dict.fromkeys(self.repos))
        payload = self.request(f"/orgs/{urllib.parse.quote(self.org)}/repos", {"per_page": "100"})
        if not isinstance(payload, list):
            raise GitHubError("GitHub repository response was not a list")
        repositories = []
        for item in payload:
            if not isinstance(item, dict):
                continue
            name = as_text(item.get("full_name"))
            if name:
                repositories.append(self.validate_repository(name))
        return list(dict.fromkeys(repositories))

    def collect(self) -> dict[str, Any]:
        errors: list[dict[str, str]] = []
        repositories: list[str] = []
        runs: list[dict[str, Any]] = []
        jobs: list[dict[str, Any]] = []
        try:
            repositories = self.repository_names()
        except GitHubError as error:
            errors.append({"scope": "repositories", "message": str(error)})

        for repository in repositories:
            try:
                run_payload = self.request(
                    f"/repos/{repository}/actions/runs", {"per_page": "100"}
                )
                if not isinstance(run_payload, dict):
                    raise GitHubError("workflow runs response was not an object")
                workflow_runs = run_payload.get("workflow_runs", [])
                if not isinstance(workflow_runs, list):
                    raise GitHubError("workflow runs response was malformed")
                for run in workflow_runs:
                    if isinstance(run, dict):
                        runs.append(self._run(repository, run))
                        if as_text(run.get("status")) in ACTIVE_STATES:
                            jobs.extend(self._jobs(repository, run))
            except GitHubError as error:
                errors.append({"scope": repository, "message": str(error)})

        runners: list[dict[str, Any]] = []
        try:
            runner_payload = self.request(
                f"/orgs/{urllib.parse.quote(self.org)}/actions/runners", {"per_page": "100"}
            )
            if isinstance(runner_payload, dict):
                runners_payload = runner_payload.get("runners", [])
                if not isinstance(runners_payload, list):
                    raise GitHubError("GitHub runner response was malformed")
                for runner in runners_payload:
                    if not isinstance(runner, dict):
                        continue
                    runners.append(
                        {
                            "name": as_text(runner.get("name")),
                            "status": as_text(runner.get("status")),
                            "busy": bool(runner.get("busy")),
                            "labels": [
                                as_text(label.get("name"))
                                for label in runner.get("labels", [])
                                if isinstance(label, dict) and as_text(label.get("name"))
                            ],
                        }
                    )
        except GitHubError as error:
            errors.append({"scope": "runners", "message": str(error)})

        return {
            "repositories": repositories,
            "runs": runs,
            "jobs": jobs,
            "runners": runners,
            "errors": errors,
        }

    def _run(self, repository: str, run: dict[str, Any]) -> dict[str, Any]:
        actor = run.get("actor") if isinstance(run.get("actor"), dict) else {}
        return {
            "id": as_text(run.get("id")),
            "repo": repository.split("/", 1)[-1],
            "workflow": as_text(run.get("name") or run.get("workflow_id")),
            "status": as_text(run.get("status")),
            "conclusion": run.get("conclusion"),
            "branch": as_text(run.get("head_branch")),
            "event": as_text(run.get("event")),
            "actor": as_text(actor.get("login")),
            "created_at": run.get("created_at"),
            "updated_at": run.get("updated_at"),
            "url": as_text(run.get("html_url")),
        }

    def _jobs(self, repository: str, run: dict[str, Any]) -> list[dict[str, Any]]:
        run_id = as_text(run.get("id"))
        if not run_id:
            return []
        payload = self.request(
            f"/repos/{repository}/actions/runs/{run_id}/jobs", {"per_page": "100"}
        )
        if not isinstance(payload, dict):
            raise GitHubError("workflow jobs response was not an object")
        result: list[dict[str, Any]] = []
        for job in payload.get("jobs", []):
            if not isinstance(job, dict):
                continue
            actor = run.get("actor") if isinstance(run.get("actor"), dict) else {}
            item = {
                "id": f"github:{as_text(job.get('id'))}",
                "job_id": as_text(job.get("id")),
                "run_id": run_id,
                "repo": repository.split("/", 1)[-1],
                "job": as_text(job.get("name")),
                "workflow": as_text(run.get("name") or run.get("workflow_id")),
                "status": as_text(job.get("status")),
                "conclusion": job.get("conclusion"),
                "branch": as_text(run.get("head_branch")),
                "event": as_text(run.get("event")),
                "actor": as_text(actor.get("login")),
                "runner": as_text(job.get("runner_name")),
                "labels": [as_text(label) for label in job.get("labels", []) if as_text(label)],
                "started_at": job.get("started_at"),
                "completed_at": job.get("completed_at"),
                "url": as_text(job.get("html_url")),
            }
            result.append(item)
        return result


class ForgeApplication:
    def __init__(self, api: GitHubAPI, cache_seconds: int = 5):
        self.api = api
        self.cache_seconds = max(0, cache_seconds)
        self._lock = Lock()
        self._cached: tuple[float, dict[str, Any]] | None = None

    def operations(self) -> dict[str, Any]:
        now = time.monotonic()
        with self._lock:
            if self._cached and now - self._cached[0] < self.cache_seconds:
                return self._cached[1]
            snapshot = self.api.collect()
            served = utc_now()
            errors = snapshot["errors"]
            source = {
                "state": "unavailable" if errors else "fresh",
                "last_success_at": None if errors else served,
                "errors": errors,
            }
            payload = {
                "schema_version": SCHEMA_VERSION,
                "generated_at": served,
                "served_at": served,
                "sources": {"github": source},
                "jobs": snapshot["jobs"],
                "running_jobs": [job for job in snapshot["jobs"] if job.get("status") == "in_progress"],
                "recent_runs": snapshot["runs"][:100],
                "active_runs": [run for run in snapshot["runs"] if run.get("status") in ACTIVE_STATES],
                "runners": snapshot["runners"],
                "alerts": [],
                "history": [],
                "wait_stats": {"repos": {}},
                "cluster": {"scale_sets": []},
            }
            self._cached = (now, payload)
            return payload


class Handler(BaseHTTPRequestHandler):
    server_version = "ActionViewForgeAdapter/0.1"

    def log_message(self, _format: str, *_args: object) -> None:
        print(json.dumps({"event": "http", "path": self.path}), file=sys.stderr, flush=True)

    def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
        if self.path == "/healthz":
            self._send(200, {"status": "ok"})
            return
        if self.path == "/readyz":
            payload = self.server.application.operations()
            status = 200 if payload["sources"]["github"]["state"] == "fresh" else 503
            self._send(status, {"status": "ok" if status == 200 else "degraded"})
            return
        if self.path.split("?", 1)[0] == "/api/operations":
            self._send(200, self.server.application.operations())
            return
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        self._send(405, {"error": "read-only adapter"})

    def _send(self, status: int, payload: object) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], application: ForgeApplication):
        super().__init__(address, Handler)
        self.application = application


def main() -> int:
    values = dict(os.environ)
    try:
        port = int(values.get("FORGE_PORT", "8090"))
        cache_seconds = int(values.get("FORGE_CACHE_SECONDS", "5"))
    except ValueError as error:
        print(f"invalid FORGE_PORT/FORGE_CACHE_SECONDS: {error}", file=sys.stderr)
        return 2
    bind = values.get("FORGE_BIND", "127.0.0.1").strip() or "127.0.0.1"
    server = Server((bind, port), ForgeApplication(GitHubAPI(values), cache_seconds))
    print(json.dumps({"event": "ready", "bind": bind, "port": server.server_port}), flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
