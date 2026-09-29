#!/usr/bin/env python3
"""Copy fixtures into a directory with every timestamp shifted so base.json's
served_at becomes "now". Keeps relative timing (a job queued 7 min before the
capture is still 7 min old) while elapsed timers and "ago" labels look live.

Usage: rebase-fixtures.py <src-dir> <dst-dir>
"""

from __future__ import annotations

import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


def parse(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def main() -> None:
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    dst.mkdir(parents=True, exist_ok=True)
    anchor = parse(json.loads((src / "base.json").read_text())["served_at"])
    delta = datetime.now(timezone.utc) - anchor
    delta_ms = int(delta.total_seconds() * 1000)

    def shift(value, key=""):
        if isinstance(value, dict):
            return {k: shift(v, k) for k, v in value.items()}
        if isinstance(value, list):
            return [shift(v, key) for v in value]
        if isinstance(value, str) and ISO.match(value):
            return (parse(value) + delta).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        if key == "t" and isinstance(value, int) and value > 10**12:
            return value + delta_ms
        return value

    for path in sorted(src.glob("*.json")):
        (dst / path.name).write_text(json.dumps(shift(json.loads(path.read_text()))))
    print(f"rebased {len(list(src.glob('*.json')))} fixtures by {delta} (now={time.strftime('%H:%M:%S')})")


if __name__ == "__main__":
    main()
