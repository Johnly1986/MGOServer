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
  tiles)
    mkdir -p "$OUT/L0"
    echo '{"asset":{"version":"1.0"}}' > "$OUT/tileset.json"
    printf 'b3d0' > "$OUT/L0/tile.b3dm"
    echo "[TilesConverter] Done: 1 tile(s) -> $OUT/tileset.json"
    ;;
  osgb)
    mkdir -p "$OUT/L0"
    echo '{"asset":{"version":"1.0"}}' > "$OUT/tileset.json"
    printf 'b3d0' > "$OUT/L0/tile.b3dm"
    echo "[OSGBConverter] Done: 1 tile(s) -> $OUT/tileset.json"
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
