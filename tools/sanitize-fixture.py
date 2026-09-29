#!/usr/bin/env python3
"""Sanitize a captured /api/operations payload so it is safe to commit publicly.

Keeps the exact shape the server emits (that is what the tests are for) but
replaces identifying values: repository names, commit titles, users, host and
node names, and sections ActionView never reads. Fails loudly if any original
identifier survives.

Usage: sanitize-fixture.py < raw.json > sanitized.json
"""

from __future__ import annotations

import json
import re
import sys

ORG = "example-org"
DEMO_REPOS = ["api-server", "web-app", "cli-tool", "data-pipeline", "mobile-app",
              "docs-site", "infra", "sdk", "worker", "dashboard", "auth", "search"]
USER = "octocat"
DEMO_WORKFLOWS = ["CI", "Release", "Nightly", "E2E", "Lint", "Docs", "Benchmarks", "Deploy preview"]
DEMO_JOBS = ["build", "test", "lint", "package", "e2e", "publish", "check", "bench"]
HOST = "forge-host"
# Infrastructure capacity is not public documentation: replace sizes with demo values.
DEMO_POOL_MAX = {"homelab": 6, "homelab-heavy": 3}  # other (burst) pools keep their max (0)
DEMO_CPUS = 8
DEMO_MEM = 32 * 1024**3
DEMO_DISK = {"/": 256 * 1000**3}
DEMO_NODE = {"cpu": "8", "memory": "32Gi", "ephemeral-storage": "256Gi", "pods": "110"}
DEMO_RATE_LIMIT = 5000

# Sections ActionView does not read; dropping them shrinks the public surface.
DROP_TOP = ("latency_stats", "workflow_inventory", "control")
DROP_CLUSTER = ("gitea", "platform_concurrency")


def desensitize_capacity(data: dict) -> None:
    cluster = data.get("cluster") or {}
    total = 0
    for group in ("scale_sets", "listeners", "ephemeral_sets"):
        for item in cluster.get(group) or []:
            if isinstance(item, dict):
                item["container_limits"] = {}
                tier = item.get("runner_tier") or item.get("name")
                if isinstance(item.get("max"), int) and item["max"] > 0:
                    item["max"] = DEMO_POOL_MAX.get(tier, item["max"])
                    if group == "scale_sets":
                        total += item["max"]
    if isinstance(data.get("capacity"), dict):
        data["capacity"]["max"] = total
    for sample in data.get("history") or []:
        if isinstance(sample, dict) and "arcMax" in sample:
            sample["arcMax"] = total
    for node in cluster.get("nodes") or []:
        if isinstance(node, dict):
            node["capacity"] = dict(DEMO_NODE)
            node["allocatable"] = dict(DEMO_NODE)
            node["kubelet_version"] = "v1.x"
    host = data.get("host") or {}
    cpu, mem = host.get("cpu") or {}, host.get("memory") or {}
    if "logical_cpus" in cpu:
        cpu["logical_cpus"] = DEMO_CPUS
    if isinstance(mem.get("used_percent"), (int, float)):
        used = int(DEMO_MEM * mem["used_percent"] / 100)
        mem.update(total_bytes=DEMO_MEM, used_bytes=used, available_bytes=DEMO_MEM - used,
                   swap_total_bytes=0, swap_free_bytes=0)
    filesystems = []
    for fs in host.get("filesystems") or []:
        if isinstance(fs, dict) and fs.get("mount") == "/" and isinstance(fs.get("used_percent"), (int, float)):
            size = DEMO_DISK["/"]
            used = int(size * fs["used_percent"] / 100)
            filesystems.append({**fs, "total_bytes": size, "used_bytes": used, "available_bytes": size - used})
    host["filesystems"] = filesystems  # other mounts reveal layout; "/" is enough for alerts
    for source in (data.get("sources") or {}).values():
        rate = source.get("rate_limit") if isinstance(source, dict) else None
        if isinstance(rate, dict) and isinstance(rate.get("limit"), int):
            used = rate["limit"] - (rate.get("remaining") or 0)
            rate["limit"] = DEMO_RATE_LIMIT
            rate["remaining"] = max(0, DEMO_RATE_LIMIT - used)


def main() -> None:
    data = json.load(sys.stdin)
    host = data.get("host") or {}
    orig_mem = (host.get("memory") or {}).get("total_bytes")
    orig_cpus = (host.get("cpu") or {}).get("logical_cpus")
    org = "KanterLabs"
    repos: dict[str, str] = {}

    def repo_alias(name: str) -> str:
        if not name:
            return name
        if name not in repos:
            repos[name] = DEMO_REPOS[len(repos) % len(DEMO_REPOS)] + (
                "" if len(repos) < len(DEMO_REPOS) else str(len(repos)))
        return repos[name]

    # Collect every repo name the payload mentions, in a stable order.
    text = json.dumps(data, sort_keys=True)
    for m in re.finditer(r"[\w.-]+/([\w.-]+)/actions/runs|\"repo\": \"([^\"]+)\"", text):
        repo_alias(m.group(1) or m.group(2))
    for key in sorted((data.get("wait_stats") or {}).get("repos") or {}):
        repo_alias(key)
    hostnames = {str((data.get("host") or {}).get("hostname") or "")}
    hostnames |= {str(n.get("name")) for n in (data.get("cluster") or {}).get("nodes") or []}
    hostnames.discard("")
    actors = set(re.findall(r'"actor": "([^"]+)"', text))
    orgs = set(re.findall(r'"repo_full_name": "([^"/]+)/', text)) | {org}

    for key in DROP_TOP:
        data.pop(key, None)
    for key in DROP_CLUSTER:
        (data.get("cluster") or {}).pop(key, None)
    for source in (data.get("sources") or {}).values():
        if isinstance(source, dict) and "organization" in source:
            source["organization"] = ORG

    desensitize_capacity(data)

    title_ids: dict[str, int] = {}
    workflows: dict[str, str] = {}
    jobs: dict[str, str] = {}
    # Generic names already present keep their name, so reserve them up front.
    for m in re.finditer(r'"workflow": "([^"]+)"', text):
        if m.group(1) in DEMO_WORKFLOWS:
            workflows[m.group(1)] = m.group(1)
    for m in re.finditer(r'"(?:job|job_display_name)": "([^"]+)"', text):
        if m.group(1) in DEMO_JOBS:
            jobs[m.group(1)] = m.group(1)

    def alias(table: dict[str, str], names: list[str], value: str) -> str:
        # Generic names ("CI", "build") identify nothing; keep them. Others get
        # the first demo name not already in use.
        if value not in table:
            if value in names:
                table[value] = value
            else:
                used = set(table.values())
                free = [n for n in names if n not in used and n not in table]
                table[value] = free[0] if free else f"{names[0]} {len(table)}"
        return table[value]

    def slug(name: str) -> str:
        return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")

    def scrub(value, key=""):
        if isinstance(value, dict):
            out = {}
            for k, v in value.items():
                nk = repo_alias(k) if key == "repos" else k
                out[nk] = scrub(v, k)
            # Keep a run's workflow file consistent with its (sanitized) workflow name.
            for ref in ("workflow_ref", "job_workflow_ref"):
                if out.get(ref) and out.get("workflow"):
                    out[ref] = f".github/workflows/{slug(out['workflow'])}.yml"
            return out
        if isinstance(value, list):
            return [scrub(v, key) for v in value]
        if not isinstance(value, str):
            return value
        if key == "title" and value:
            title_ids.setdefault(value, len(title_ids) + 1)
            return f"feat: example change {title_ids[value]}"
        if key == "workflow" and value:
            return alias(workflows, DEMO_WORKFLOWS, value)
        if key in ("job", "job_display_name") and value:
            return alias(jobs, DEMO_JOBS, value)
        if key in ("workflow_ref", "job_workflow_ref") and value:
            # e.g. "org/repo/.github/workflows/fedora.yml@refs/heads/main"
            m = re.search(r"\.github/workflows/([^@]+?)\.ya?ml", value)
            name = slug(alias(workflows, DEMO_WORKFLOWS, m.group(1))) if m else "ci"
            return f".github/workflows/{name}.yml"
        s = value
        for full_org in orgs:
            s = re.sub(rf"\b{re.escape(full_org)}/([\w.-]+)",
                       lambda m: f"{ORG}/{repo_alias(m.group(1))}", s)
        # Bare repo names only; "org/repo" values were already rewritten above.
        if key in ("repo", "job_repository") and s and "/" not in s:
            s = repo_alias(s)
        for actor in actors:
            s = s.replace(actor, USER)
        for host in hostnames:
            s = s.replace(host, HOST)
        return s

    data = scrub(data)

    out = json.dumps(data, indent=1, sort_keys=True)
    original_numbers = [f'"{k}": {v}' for k, v in (("total_bytes", orig_mem), ("logical_cpus", orig_cpus)) if v]
    if any(n in out for n in original_numbers):
        sys.exit("sanitize-fixture: original host capacity survived")
    generic = set(DEMO_WORKFLOWS) | set(DEMO_JOBS) | {"ci"}
    originals = [n for n in [*repos, *actors, *hostnames, *orgs, *workflows, *jobs, *title_ids]
                 if n not in generic]
    leaks = [name for name in originals
             if name and re.search(rf"(?<![\w-]){re.escape(name)}(?![\w-])", out)]
    if leaks:
        sys.exit(f"sanitize-fixture: identifiers survived: {sorted(set(leaks))}")
    sys.stdout.write(out + "\n")


if __name__ == "__main__":
    main()
