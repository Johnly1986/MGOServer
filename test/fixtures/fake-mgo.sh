#!/usr/bin/env bash
# Fake mgo binary for e2e tests (Linux/macOS only; the e2e test skips Windows).
# Mirrors the real progress protocol:
#   [Module] Progress: X/Y      [Module] Done: ...
# Knobs (env): FAKE_EXIT (default 0), FAKE_SLEEP (default 0.05),
#              FAKE_STALL (long sleep after artifacts, for timeout tests)
set -u
SUB="${1:-}"; shift || true
FULL="$*"
IN=""; OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -i) IN="$2"; shift 2 ;;
    -o) OUT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
S=${FAKE_SLEEP:-0.05}

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
    cat > "$OUT/tileset.json" <<EOF
{"asset":{"version":"1.0"},"geometricError":500,"root":{"transform":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],"boundingVolume":{"region":[1.0,0.5,0.001,1.01,0.51,0.002]},"geometricError":50,"refine":"ADD","content":{"uri":"L0/tile.b3dm"}}}
EOF
    printf 'b3d0' > "$OUT/L0/tile.b3dm"
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
exit "${FAKE_EXIT:-0}"
