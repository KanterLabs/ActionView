#!/usr/bin/env python3
"""Derive scenario fixtures from a real captured payload (tests/fixtures/operations/base.json).

Each scenario is a small, explicit mutation of the live shape so the fixtures
stay faithful to what the server actually emits. Timestamps are anchored to
base.json's served_at, and tests pass that as "now".
"""

from __future__ import annotations

import copy
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "operations"


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def load_base() -> dict:
    return json.loads((ROOT / "base.json").read_text())


def served(base: dict) -> datetime:
    return datetime.fromisoformat(base["served_at"].replace("Z", "+00:00"))


RUN_ID = 46000000001
JOB_ID = 99000000001


def github_job(now: datetime, *, status: str, job: str, run_id: int, job_id: int,
               queued_for: timedelta, runner: str = "") -> dict:
    return {
        "id": run_id,
        "repo": "web-app",
        "repo_full_name": "example-org/web-app",
        "workflow": "CI",
        "title": "feat: add queue view",
        "status": status,
        "conclusion": None,
        "branch": "main",
        "event": "push",
        "actor": "octocat",
        "created_at": iso(now - queued_for),
        "updated_at": iso(now),
        "url": f"https://github.com/example-org/web-app/actions/runs/{run_id}/job/{job_id}",
        "workflow_ref": ".github/workflows/ci.yml",
        "job": job,
        "job_id": job_id,
        "workflow_run_id": run_id,
        "runner": runner,
        "labels": ["homelab-heavy"],
        "runner_tier": "homelab-heavy",
        "started_at": iso(now - timedelta(seconds=61)) if status == "in_progress" else None,
        "workflow_created_at": iso(now - queued_for),
        "job_created_at": iso(now - queued_for),
    }


def running_entry(now: datetime) -> dict:
    runner = "homelab-heavy-p6hw7-runner-78zz7"
    return {
        "key": f"arc:{runner}",
        "workflow_run_id": RUN_ID,
        "repo": "web-app",
        "repo_full_name": "example-org/web-app",
        "job": "build (linux-x64)",
        "job_id": JOB_ID,
        "runner": runner,
        "runner_tier": "homelab-heavy",
        "runner_ready": True,
        "arc_phase": "Running",
        "workflow": "CI",
        "branch": "main",
        "actor": "octocat",
        "detected_at": iso(now - timedelta(seconds=61)),
        "started_at": iso(now - timedelta(seconds=61)),
        "last_seen_at": iso(now),
        "status": "in_progress",
        "url": f"https://github.com/example-org/web-app/actions/runs/{RUN_ID}/job/{JOB_ID}",
        "source": "arc+github",
        "resource_usage": {"runner": runner, "cpu_millicores": 60.0, "memory_bytes": 201431040},
    }


def with_running(base: dict) -> dict:
    d = copy.deepcopy(base)
    now = served(d)
    d["jobs"] = [github_job(now, status="in_progress", job="build (linux-x64)",
                            run_id=RUN_ID, job_id=JOB_ID, queued_for=timedelta(seconds=80),
                            runner="homelab-heavy-p6hw7-runner-78zz7")]
    d["active_runs"] = [{k: v for k, v in d["jobs"][0].items() if k in (
        "id", "repo", "repo_full_name", "workflow", "title", "status", "conclusion", "branch",
        "event", "actor", "created_at", "updated_at", "url", "workflow_ref")}]
    d["running_jobs"] = [running_entry(now)]
    for s in d["cluster"]["scale_sets"]:
        if s["name"] == "homelab-heavy":
            s["current"], s["pending"], s["running"] = 1, 1, 1
    return d


def with_queued(base: dict) -> dict:
    d = with_running(base)
    now = served(d)
    # A second matrix leg waiting 7 minutes for capacity, plus the running job's
    # own GitHub entry still reporting "queued" (must be de-duplicated).
    d["jobs"].append(github_job(now, status="queued", job="build (linux-arm64)",
                                run_id=RUN_ID, job_id=JOB_ID + 1,
                                queued_for=timedelta(minutes=7)))
    d["jobs"].append(github_job(now, status="queued", job="build (linux-x64)",
                                run_id=RUN_ID, job_id=JOB_ID, queued_for=timedelta(seconds=80)))
    return d


def with_concluded(base: dict, conclusion: str) -> dict:
    d = copy.deepcopy(base)
    now = served(d) + timedelta(minutes=4)
    d["served_at"] = iso(now)
    d["generated_at"] = iso(now - timedelta(seconds=1))
    run = {k: v for k, v in github_job(now, status="completed", job="", run_id=RUN_ID,
                                       job_id=JOB_ID, queued_for=timedelta(minutes=5)).items()
           if k in ("id", "repo", "repo_full_name", "workflow", "title", "status", "branch",
                    "event", "actor", "created_at", "updated_at", "workflow_ref")}
    run["conclusion"] = conclusion
    run["url"] = f"https://github.com/example-org/web-app/actions/runs/{RUN_ID}"
    d["recent_runs"] = [run, *d["recent_runs"]][:20]
    return d


def with_alert(base: dict) -> dict:
    d = copy.deepcopy(base)
    d["alerts"] = [
        {"level": "critical", "message": "node forge-host is NotReady"},
        {"level": "warning", "message": "host memory usage at 83.4%"},
    ]
    return d


def with_stale_source(base: dict) -> dict:
    d = copy.deepcopy(base)
    d["sources"]["github"]["state"] = "stale"
    d["sources"]["github"]["error"] = "GitHub rate limited"
    return d


def with_hung_collector(base: dict) -> dict:
    d = copy.deepcopy(base)
    d["generated_at"] = iso(served(d) - timedelta(minutes=5))
    return d


def main() -> None:
    base = load_base()
    scenarios = {
        "running": with_running(base),
        "queued": with_queued(base),
        "concluded-failure": with_concluded(base, "failure"),
        "concluded-success": with_concluded(base, "success"),
        "alert": with_alert(base),
        "source-stale": with_stale_source(base),
        "collector-hung": with_hung_collector(base),
        "schema-future": {**copy.deepcopy(base), "schema_version": base["schema_version"] + 1},
    }
    for name, payload in scenarios.items():
        (ROOT / f"{name}.json").write_text(json.dumps(payload, indent=1, sort_keys=True) + "\n")
        print(f"wrote {name}.json")


if __name__ == "__main__":
    main()
