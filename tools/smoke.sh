#!/usr/bin/env bash
# Headless end-to-end smoke test: run a real gnome-shell with ActionView + the
# smoke driver in a throwaway HOME (your dconf/extensions are untouched),
# screenshot each scenario, cycle enable/disable, and fail on JS errors.
#
# Usage: tools/smoke.sh [out-dir]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/build/smoke}"
# gnome-shell chdirs to $HOME (the throwaway one), so every path handed to it must be absolute.
mkdir -p "$out" && out="$(cd "$out" && pwd)"
uuid="actionview@kanterlabs.dev"
steps="${ACTIONVIEW_SMOKE_STEPS:-base,base>running,base>queued,base>concluded-failure,base>alert,source-stale>source-stale,collector-hung,schema-future,base>offline}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
rm -rf "$out" && mkdir -p "$out"

export HOME="$tmp/home" XDG_CONFIG_HOME="$tmp/config" XDG_DATA_HOME="$tmp/data" XDG_CACHE_HOME="$tmp/cache"
export XDG_RUNTIME_DIR="$tmp/run" && mkdir -p "$HOME" "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
ext_dir="$XDG_DATA_HOME/gnome-shell/extensions"
mkdir -p "$ext_dir"
# Install the packed zip (what ships), not the source tree.
gnome-extensions pack --force --out-dir="$tmp" --extra-source=lib --extra-source=icons "$root/$uuid" >/dev/null
gnome-extensions install --force "$tmp/$uuid.shell-extension.zip"
cp -r "$root/tools/smoke/actionview-smoke@kanterlabs.dev" "$ext_dir/"

export ACTIONVIEW_FIXTURE="$tmp/live.json"
# Shift fixture timestamps to "now" so timers/ages render realistically.
python3 "$root/tools/rebase-fixtures.py" "$root/tests/fixtures/operations" "$tmp/fixtures" >/dev/null
export ACTIONVIEW_SMOKE_DIR="$tmp/fixtures"
export ACTIONVIEW_SMOKE_STEPS="$steps"
export ACTIONVIEW_SMOKE_OUT="$out"
cp "$ACTIONVIEW_SMOKE_DIR/base.json" "$ACTIONVIEW_FIXTURE"

log="$out/gnome-shell.log"
dbus-run-session -- bash -c '
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell enabled-extensions "[\"'"$uuid"'\", \"actionview-smoke@kanterlabs.dev\"]"
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
    gsettings set org.gnome.desktop.interface color-scheme prefer-dark
    exec timeout 90 gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x900
  ' >"$log" 2>&1 || true
if [[ ! -f "$out/report.json" ]]; then
  echo "smoke: no report produced; see $log" >&2
  grep -iE "error|actionview" "$log" | tail -20 >&2 || true
  exit 1
fi

echo "smoke: report"
cat "$out/report.json"
# Fail on any warning/error block (message + stack frames) that involves ActionView.
# Unrelated shell noise in a bare headless session (e.g. dash icon lookups) is ignored.
python3 - "$log" <<'EOF'
import re, sys
lines = open(sys.argv[1], errors="replace").read().splitlines()
start = re.compile(r"JS ERROR|JS WARNING|CRITICAL|WARNING \*\*|Unhandled promise|ActionView:")
frame = re.compile(r"^(\s|#\d|\S*@\S+:\d+)")
blocks, i = [], 0
while i < len(lines):
    if start.search(lines[i]) and "ACTIONVIEW-SMOKE-REPORT" not in lines[i]:
        block = [lines[i]]
        i += 1
        def continues(j):
            line = lines[j]
            if frame.match(line) or line.startswith(("== Stack", "Stack trace")):
                return True
            # GNOME Shell prints "<message>\n\nStack trace:\n  frames"
            return line == "" and j + 1 < len(lines) and lines[j + 1].startswith("Stack trace")
        while i < len(lines) and continues(i):
            block.append(lines[i]); i += 1
        if re.search(r"actionview", "\n".join(block), re.I):
            blocks.append("\n".join(block))
    else:
        i += 1
if blocks:
    sys.exit("smoke: ActionView errors in shell log:\n" + "\n---\n".join(blocks))
EOF
python3 - "$out/report.json" <<'EOF'
import json, sys
r = json.load(open(sys.argv[1]))
if "fatal" in r:
    sys.exit(f"smoke: driver failed: {r['fatal']}")
expect = {
    "base": "idle", "base>running": "running", "base>queued": "queued",
    "base>concluded-failure": "failure", "base>alert": "critical",
    "source-stale>source-stale": "stale", "collector-hung": "stale", "schema-future": "idle",
    "base>offline": "offline",
}
bad = [f"{s['step']}: badge {s['badge']['level']} != {expect[s['step']]}"
       for s in r["scenarios"] if s["step"] in expect and s["badge"]["level"] != expect[s["step"]]]
c = r["cycles"]
if c["indicators"] != 1 or not c["statusAreaPresent"] or not c["haveView"] or (c["pollerSources"] or 0) > 1:
    bad.append(f"enable/disable cycles: {c}")
if bad:
    sys.exit("smoke: FAILED\n  " + "\n  ".join(bad))
print(f"smoke: OK ({len(r['scenarios'])} scenarios, {c['count']} enable/disable cycles)")
EOF
