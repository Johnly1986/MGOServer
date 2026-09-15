#!/usr/bin/env bash
# Fake mgo binary for e2e tests (Linux/macOS only; the e2e test skips Windows).
# Mirrors the real progress protocol:
#   [Module] Progress: X/Y      [Module] Done: ...
# Knobs (env): FAKE_EXIT (default 0), FAKE_SLEEP (default 0.05),
#              FAKE_STALL (long sleep after artifacts, for timeout tests),
#              FAKE_SIGNAL (e.g. FPE/SEGV: die by that signal instead of exiting,
#              for ENGINE_CRASH diagnostics), FAKE_B3DM (path to a real batch-table b3dm: the tiles branch
#              embeds it instead of the 'b3d0' stub, so a viewer can pick
#              features end-to-end without the C++ engine)
set -u
SUB="${1:-}"; shift || true
FULL="$*"
IN=""; OUT=""; PROPS=""; REPORT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -i) IN="$2"; shift 2 ;;
    -o) OUT="$2"; shift 2 ;;
    --bim-props) PROPS="$2"; shift 2 ;;
    --bim-report) REPORT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
S=${FAKE_SLEEP:-0.05}

# capability probe surface: mgo.js runs `tiles --help` and looks for --bim-bind
if [[ "$SUB" == "tiles" && " $FULL " == *" --help "* ]]; then
  cat <<'HELP'
mgo tiles — FBX/OBJ to 3D Tiles
  -i <file>   Input model
  -o <dir>    Output directory
  --bim-bind          Enable BIM property binding
  --bim-props <csv>   Sidecar property table (implies --bim-bind)
  --bim-report <f>    Write JSON transparency manifest
HELP
  exit 0
fi

# engine parity: --bim-props pointing at a missing/unreadable table is a
# fail-fast (exit 1), never a silently attribute-less conversion
if [[ -n "$PROPS" && ! -s "$PROPS" ]]; then
  echo "[TilesConverter] BIM binding: cannot read sidecar $PROPS" >&2
  exit 1
fi

echo "argv: $SUB $FULL"
echo "[TerrainConverter] Progress: 0/3"
sleep "$S"
echo "[TerrainConverter] Progress: 1/3"
sleep "$S"
echo "[TerrainConverter] Progress: 2/3"
sleep "$S"
echo "[TerrainConverter] Progress: 3/3"

case "$SUB" in
  terrain)
    mkdir -p "$OUT/0/0"
    echo '{"format":"quantized-mesh-1.0"}' > "$OUT/layer.json"
    printf 'TERRAINBIN' > "$OUT/0/0/0.terrain"
    echo "[TerrainConverter] Done: 3/3"
    ;;
  tiles|osgb)
    # real MGOConsole cannot create its -o dir — mirror that so the e2e suite
    # catches service-side regressions of the per-file output layout
    if [ ! -d "$OUT" ]; then
      echo "[TileBuilder] Cannot write $OUT/tileset.json" >&2
      echo "[TilesConverter] Failed to generate tileset.json" >&2
      exit 1
    fi
    # minimally VALID 1.0 tileset (root.boundingVolume + geometricError):
    # the 3d-tiles-tools merge step reads these, like it reads real MGO output
    mkdir -p "$OUT/L0"
    if [ "$SUB" = "tiles" ] && command -v node >/dev/null 2>&1 \
        && node "$(dirname "$0")/make-b3dm.mjs" "$OUT" 2>/dev/null; then
      # real b3dm with a non-empty Batch Table + tileset.json (Cesium-loadable),
      # so the viewer's click-to-inspect path can be e2e-tested without the
      # C++ engine (make-b3dm.mjs writes both files)
      :
    else
      cat > "$OUT/tileset.json" <<EOF
{"asset":{"version":"1.0"},"geometricError":500,"root":{"transform":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],"boundingVolume":{"region":[1.0,0.5,0.001,1.01,0.51,0.002]},"geometricError":50,"refine":"ADD","content":{"uri":"L0/tile.b3dm"}}}
EOF
      printf 'b3d0' > "$OUT/L0/tile.b3dm"
    fi
    # --bim-report: mirror the real engine's transparency manifest shape
    # (instances / withSidecarRow / features[].matchSource) so tests assert the
    # same fields against the stub and against MGOConsole
    if [ -n "$REPORT" ]; then
      mkdir -p "$(dirname "$REPORT")" 2>/dev/null || true
      ROWS=0
      if [ -n "$PROPS" ] && [ -s "$PROPS" ]; then
        LINES=$(wc -l < "$PROPS" | tr -d ' ')
        [ "$LINES" -gt 0 ] && ROWS=$((LINES - 1))
      fi
      cat > "$REPORT" <<EOF
{"strategy":"FAKE","formatId":"fake","nativeGuid":false,"idSource":"objectName","sceneMetadata":false,"sidecar":"$PROPS","instances":1,"withSceneRow":0,"withSidecarRow":$ROWS,"withRow":$ROWS,"withObjectId":1,"reservedCollisions":0,"droppedKeys":[],"idSourceCounts":{"objectName":1},"features":[{"instance":0,"objectId":"CubeA","idSource":"objectName","matchSource":"sidecar","properties":{"objectId":"CubeA"}}],"featuresTruncated":false}
EOF
    fi
    if [ "$SUB" = "tiles" ]; then
      echo "[TilesConverter] Done: 1 tile(s) -> $OUT/tileset.json"
    else
      echo "[OSGBConverter] Done: 1 tile(s) -> $OUT/tileset.json"
    fi
    ;;
  image)
    mkdir -p "$OUT/0/0"
    echo '<TileMap/>' > "$OUT/tilemapresource.xml"
    printf 'PNG' > "$OUT/0/0/0.png"
    echo '{"tiles":[{"url":"layer.json"}]}' > "$OUT/layer.json"
    echo "[ImageTiler] Done: 1 tiles (1 levels)"
    ;;
  geojson)
    echo '{"type":"FeatureCollection","features":[]}' > "$OUT"
    ;;
  mesh)
    printf 'glTF' > "$OUT"
    ;;
esac

[[ -n "${FAKE_STALL:-}" ]] && sleep "$FAKE_STALL"
# Signal death (shell reports 128+N): mirrors a crashing engine binary so the
# service's ENGINE_CRASH path is exercised end-to-end.
if [ -n "${FAKE_SIGNAL:-}" ]; then
  kill -s "$FAKE_SIGNAL" $$
  sleep 1
fi
exit "${FAKE_EXIT:-0}"
