#!/usr/bin/env bash
# Capture a live /api/operations payload as a sanitized test fixture.
# Runs curl on the Forge host itself over ssh (Forge usually only admits
# allow-listed clients), then strips identifying data before it touches disk.
#
# Usage: FORGE_SSH_HOST=<ssh alias> FORGE_URL=http://<forge>:8090 tools/capture-fixture.sh [name]
set -euo pipefail
name="${1:-base}"
host="${FORGE_SSH_HOST:?set FORGE_SSH_HOST to an ssh alias for the Forge host}"
url="${FORGE_URL:?set FORGE_URL, e.g. http://<forge-ip>:8090}"
out="$(dirname "$0")/../tests/fixtures/operations/${name}.json"
ssh -o BatchMode=yes "$host" "curl -sf -m 10 '${url}/api/operations'" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); d["history"]=d.get("history",[])[-60:]; json.dump(d,sys.stdout)' \
  | python3 "$(dirname "$0")/sanitize-fixture.py" > "$out.tmp"
mv "$out.tmp" "$out"
echo "wrote $out (schema_version $(python3 -c "import json;print(json.load(open('$out')).get('schema_version'))" ))"
echo "run tools/make-fixtures.py to regenerate derived scenarios"
