#!/usr/bin/env bash
# One-shot deployment verification for MGOServer.
#
# Boots the service exactly the way systemd would (bare `node src/server.js`) and
# asserts the things that silently break across a reboot: bind address, mgo binary
# discovery, whitelist merge + restart persistence, reverse-proxy header trust,
# .env loading, and a real terrain conversion through the MGO binary.
#
# Everything runs against a throwaway workspace (seeded from the live
# whitelist.json), so this is safe to run on a production instance.
#
#   scripts/verify-deployment.sh                 # port 8080
#   PORT=9000 scripts/verify-deployment.sh
#   KEEP=1 scripts/verify-deployment.sh          # keep the scratch dir for a look
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
PORT="${PORT:-8080}"
BASE="http://127.0.0.1:$PORT"
SRC_WS="${MGO_WORKSPACE:-workspace}"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/mgoserver-verify-XXXXXX")"
LOG="$SCRATCH/server.log"
PID=""
PASS=0; FAIL=0; SKIPN=0

ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n      %s\n' "$1" "${2:-}"; }
skip(){ SKIPN=$((SKIPN+1)); printf 'SKIP  %s\n      %s\n' "$1" "${2:-}"; }
chk() { local n="$1" w="$2" g="$3"; [ "$w" = "$g" ] && ok "$n" || bad "$n" "want=[$w] got=[$g]"; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
body(){ curl -s "$@"; }

start() { # start() [extra env assignments...] — waits for health
  env "$@" node src/server.js >>"$LOG" 2>&1 & PID=$!
  for _ in $(seq 60); do sleep 0.25; curl -sf -o /dev/null "$BASE/api/v1/health" && return 0; done
  bad "server did not become healthy" "$(tail -5 "$LOG")"; return 1
}
stop() { [ -n "$PID" ] && kill "$PID" 2>/dev/null && wait "$PID" 2>/dev/null; PID=""; sleep 0.5; }
cleanup() { stop; [ -z "${KEEP:-}" ] && rm -rf "$SCRATCH" || echo "scratch kept: $SCRATCH"; }
trap cleanup EXIT

# non-loopback address of this host, used to prove X-Forwarded-For is ignored
# unless the peer really is a trusted proxy
LANIP="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"

echo "############ 0. preflight ############"
command -v node >/dev/null || { echo "node required"; exit 1; }
NV="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NV" -ge 20 ] && ok "node $(node -v) (>= 20)" || bad "node too old" "$NV"
# Client IP under test: the first non-localhost entry of the live whitelist if the
# deployment has one (workspace/ is gitignored, so a fresh clone has none) —
# otherwise invent a TEST-NET one and seed it into the scratch whitelist file.
CLIENT='203.0.113.20'
if [ -f "$SRC_WS/whitelist.json" ]; then
  cp "$SRC_WS/whitelist.json" "$SCRATCH/whitelist.json"
  LIVE=$(node -p "require('$SCRATCH/whitelist.json').find(e=>e!=='127.0.0.1'&&e!=='::1')||''" 2>/dev/null)
  if [ -n "$LIVE" ]; then
    CLIENT="$LIVE"
    echo "seeded scratch whitelist from $SRC_WS/whitelist.json"
  else
    printf '[\n  "127.0.0.1",\n  "::1",\n  "%s"\n]\n' "$CLIENT" > "$SCRATCH/whitelist.json"
    echo "live whitelist is localhost-only; scratch seeded with $CLIENT"
  fi
else
  printf '[\n  "127.0.0.1",\n  "::1",\n  "%s"\n]\n' "$CLIENT" > "$SCRATCH/whitelist.json"
  echo "no $SRC_WS/whitelist.json (fresh clone); scratch seeded with $CLIENT"
fi
echo "  (client IP under test: $CLIENT)"
WS="$SCRATCH"

echo "############ 1. boot: bind + binary discovery + loud startup log ############"
start MGO_WORKSPACE="$WS" MGO_PORT="$PORT" || exit 1
chk "health responds" 200 "$(code "$BASE/api/v1/health")"
chk "listening on the configured (public) address" "$PORT" \
    "$(ss -tlnp 2>/dev/null | grep -oE "0.0.0.0:$PORT|127.0.0.1:$PORT" | head -1 | grep -o '[0-9]*$')"
grep -q '"found":true' "$LOG" && ok "mgo binary discovered and probed ($(grep -o '"binary":"[^"]*"' "$LOG" | head -1 | cut -d'"' -f4))" \
  || bad "mgo binary not runnable — set MGO_BINARY" "$(grep -o '"binary":"[^"]*"' "$LOG" | head -1)"
grep -q '"trustProxy":"loopback"' "$LOG" && ok "trustProxy=loopback (XFF only from a local proxy)" \
  || bad "trustProxy log field" "$(grep -o '"trustProxy":[^,]*' "$LOG" | head -1)"
grep -q "\"whitelistFile\":\"$SCRATCH/whitelist.json" "$LOG" && ok "startup log names the whitelist file" \
  || bad "whitelistFile log field" "$(grep -o '"whitelistFile":"[^"]*"' "$LOG" | head -1)"

echo "############ 2. whitelist gate ############"
chk "$CLIENT through local nginx → console 200" 200 "$(code -H "X-Forwarded-For: $CLIENT" "$BASE/console.html")"
chk "$CLIENT → capabilities.allowed=true" true \
    "$(body -H "X-Forwarded-For: $CLIENT" "$BASE/api/v1/capabilities" | grep -o '"allowed":[a-z]*' | cut -d: -f2)"
chk "unlisted IP → 403 page" 403 "$(code -H 'X-Forwarded-For: 203.0.113.99' "$BASE/console.html")"
body -H 'X-Forwarded-For: 203.0.113.99' "$BASE/console.html" | grep -q '403' && ok "403 body is the styled block page" || bad "403 page body" ""
chk "unlisted IP cannot submit jobs" 403 \
    "$(code -X POST -H 'content-type: application/json' -H 'X-Forwarded-For: 203.0.113.99' -d '{"type":"terrain"}' "$BASE/api/v1/jobs")"
chk "unlisted IP cannot read /ws artifacts" 403 "$(code -H 'X-Forwarded-For: 203.0.113.99' "$BASE/ws/none/out/layer.json")"

echo "############ 3. X-Forwarded-For cannot be forged by a direct client ############"
if [ -z "$LANIP" ]; then
  skip "no non-loopback interface found" "run this section manually against the public address"
else
  chk "remote peer forging XFF=127.0.0.1 → still 403" 403 \
      "$(code --interface "$LANIP" -H 'X-Forwarded-For: 127.0.0.1' "http://$LANIP:$PORT/console.html")"
  chk "server records the real peer, not the header" "\"ip\":\"$LANIP\"" \
      "$(body --interface "$LANIP" -H 'X-Forwarded-For: 127.0.0.1' "http://$LANIP:$PORT/api/v1/capabilities" | grep -o '"ip":"[^"]*"' | head -1)"
  chk "forged localhost cannot manage the whitelist" 403 \
      "$(code --interface "$LANIP" -H 'X-Forwarded-For: 127.0.0.1' "http://$LANIP:$PORT/api/v1/whitelist")"
fi

echo "############ 4. runtime add → RESTART → still allowed ############"
chk "localhost may add an entry" 200 \
    "$(code -X POST -H 'content-type: application/json' -d "{\"whitelist\":[\"$CLIENT\",\"203.0.113.77\"]}" "$BASE/api/v1/whitelist")"
stop
start MGO_WORKSPACE="$WS" MGO_PORT="$PORT" || exit 1
chk "added IP survives the restart" 200 "$(code -H 'X-Forwarded-For: 203.0.113.77' "$BASE/console.html")"
chk "pre-existing IP survives the restart" 200 "$(code -H "X-Forwarded-For: $CLIENT" "$BASE/console.html")"
chk "and MGO_IP_WHITELIST is merged in too" true \
    "$(MGO_IP_WHITELIST=203.0.113.88 node -e "import('./src/config.js').then(m=>console.log(m.loadConfig({workspaceRoot:'$WS'}).isAllowedIp('203.0.113.88')))")"
chk "restore the original entry set" 200 \
    "$(code -X POST -H 'content-type: application/json' -d "{\"whitelist\":[\"$CLIENT\"]}" "$BASE/api/v1/whitelist")"

echo "############ 5. .env is actually loaded (systemd + npm start + bare node) ############"
printf 'MGO_PORT=%s\nMGO_IP_WHITELIST=203.0.113.55\n' "$PORT" > "$SCRATCH/test.env"
stop
start MGO_WORKSPACE="$WS" MGO_ENV_FILE="$SCRATCH/test.env" || exit 1
chk ".env value applied (bound to MGO_PORT from the file)" 200 "$(code "$BASE/api/v1/health")"
grep -q "\"envFile\":\"$SCRATCH/test.env \[MGO_PORT,MGO_IP_WHITELIST\]\"" "$LOG" \
  && ok "startup log names the .env and the keys it applied" || bad "envFile log field" "$(grep -o '"envFile":"[^"]*"' "$LOG" | tail -1)"
chk "MGO_IP_WHITELIST from .env takes effect" 200 "$(code -H 'X-Forwarded-For: 203.0.113.55' "$BASE/console.html")"
stop
chk "real env beats .env (Environment= override wins)" 8123 \
    "$(MGO_ENV_FILE="$SCRATCH/test.env" MGO_PORT=8123 node -e "import('./src/config.js').then(m=>console.log(m.loadConfig().port))")"

echo "############ 6. real conversion through the MGO binary ############"
# plain boot again — section 5 stopped everything, and the job must run under the
# default config path rather than the throwaway .env
start MGO_WORKSPACE="$WS" MGO_PORT="$PORT" || exit 1
TIF="test/fixtures/test_terrain.tif"
[ -f "$TIF" ] || python3 scripts/generate-test-tif.py >/dev/null 2>&1
if [ ! -f "$TIF" ]; then
  skip "terrain fixture unavailable" "python3 scripts/generate-test-tif.py"
else
  JOB=$(body -X POST -F 'options={"type":"terrain","maxLod":2,"samplesPerTile":65}' \
          -F "file=@$TIF" "$BASE/api/v1/jobs" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  [ -n "$JOB" ] && ok "terrain job accepted ($JOB)" || bad "job submit" "$(tail -5 "$LOG")"
  ST=""
  for _ in $(seq 90); do
    ST=$(body "$BASE/api/v1/jobs/$JOB" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
    { [ "$ST" = succeeded ] || [ "$ST" = failed ]; } && break
    sleep 1
  done
  chk "job ran to succeeded" succeeded "$ST"
  chk "layer.json served from the data plane" 200 "$(code "$BASE/ws/$JOB/out/layer.json")"
  chk "quantized-mesh tile served" 200 "$(code "$BASE/ws/$JOB/out/0/0/0.terrain")"
  chk "viewer deep link produced" terrain "$(body "$BASE/api/v1/jobs/$JOB" | grep -o '"viewerUrl":"[^"]*type=terrain' | grep -o 'terrain$')"
  EV=$(body "$BASE/api/v1/jobs/$JOB/events" -H 'accept: text/event-stream' --max-time 2 | grep -c '^event:' || true)
  [ "$EV" -ge 1 ] && ok "SSE replays $EV events" || bad "SSE stream" "0 events"
  chk "job deletable (cleanup)" 204 "$(code -X DELETE "$BASE/api/v1/jobs/$JOB")"
fi

echo; echo "================  $PASS passed / $FAIL failed / $SKIPN skipped  ================"
[ "$FAIL" = 0 ]
