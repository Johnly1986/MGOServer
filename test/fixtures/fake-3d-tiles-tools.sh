#!/usr/bin/env bash
# Fake 3d-tiles-tools CLI for e2e tests (merge-phase knobs).
#   FAKE_MERGE_EXIT  — exit code (default 1 → merge failure)
# On exit 0 it writes a merged tileset with exactly one child per -i input,
# which is what the manager's post-merge validation checks.
set -u
echo "merge argv: $*"
SUB="${1:-}"; shift || true
OUT=""; N=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -i) N=$((N+1)); shift ;;
    -o) OUT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ "${FAKE_MERGE_EXIT:-1}" != "0" ]; then
  echo "fake merge failure (inputs=$N)" >&2
  exit "${FAKE_MERGE_EXIT:-1}"
fi
[ "$SUB" = "mergeJson" ] || { echo "unknown subcommand $SUB" >&2; exit 2; }
KIDS=""
for ((i = 1; i <= N; i++)); do
  [ -n "$KIDS" ] && KIDS+=","
  KIDS+="{\"boundingVolume\":{\"region\":[1.0,0.5,1.01,0.51,0,1]},\"geometricError\":50,\"refine\":\"ADD\",\"content\":{\"uri\":\"sub$i/tileset.json\"}}"
done
printf '{"asset":{"version":"1.1"},"geometricError":100,"root":{"boundingVolume":{"region":[1.0,0.5,1.01,0.51,0,1]},"refine":"ADD","geometricError":100,"children":[%s]}}' "$KIDS" > "$OUT"
exit 0
