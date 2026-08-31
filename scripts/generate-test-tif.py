#!/usr/bin/env python3
"""Generate a minimal GeoTIFF for testing TerrainConverter.

Creates a 64x64 float32 elevation grid with a Gaussian hill,
georeferenced as EPSG:4326 (geographic WGS84).

Usage:  python3 scripts/generate-test-tif.py [out-dir|out.tif]
        default: <repo>/test/fixtures/test_terrain.tif — the fixture the
        e2e / UI tests upload (`npm run fixture:terrain`)
"""
import struct
import math
import os
import sys

_FIXTURE = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), os.pardir, "test", "fixtures", "test_terrain.tif"))
_arg = sys.argv[1] if len(sys.argv) > 1 else ""
OUT_PATH = _arg if _arg.lower().endswith((".tif", ".tiff")) \
    else os.path.join(_arg or os.path.dirname(_FIXTURE), "test_terrain.tif")

WIDTH = 64
HEIGHT = 64

# Geographic bounds: small area around lat 30, lon 120
WEST = 120.0
EAST = 120.01
SOUTH = 30.0
NORTH = 30.01

PIXEL_SCALE_X = (EAST - WEST) / WIDTH
PIXEL_SCALE_Y = (NORTH - SOUTH) / HEIGHT

def generate_elevation():
    """Gaussian hill centered at grid center."""
    elev = []
    cx, cy = (WIDTH - 1) / 2.0, (HEIGHT - 1) / 2.0
    sigma = WIDTH / 4.0
    for r in range(HEIGHT):
        for c in range(WIDTH):
            dx = c - cx
            dy = r - cy
            h = 100.0 * math.exp(-(dx*dx + dy*dy) / (2 * sigma * sigma))
            elev.append(h)
    return elev

def pack_le_u16(v): return struct.pack('<H', v)
def pack_le_u32(v): return struct.pack('<I', v)
def pack_le_f32(v): return struct.pack('<f', v)
def pack_le_f64(v): return struct.pack('<d', v)

def build_tiff(elev):
    # TIFF structure:
    #   [0..7]   Header: 'II' + 42 + offset to IFD
    #   [8..N]   Image data (float32 strip)
    #   [N..M]   GeoTIFF double params (ModelPixelScale, ModelTiepoint)
    #   [M..P]   GeoKey directory
    #   [P..Q]   IFD

    num_entries = 13
    ifd_size = 2 + num_entries * 12 + 4  # count + entries + next-IFD offset

    # Layout
    header_size = 8
    strip_size = WIDTH * HEIGHT * 4  # float32
    pixel_scale_size = 3 * 8  # 3 doubles (ScaleX, ScaleY, ScaleZ)
    tiepoint_size = 6 * 8     # 6 doubles (I, J, K, X, Y, Z)
    # GeoKey directory: 4 shorts header + 4 shorts per key
    # We have 1 key (GeographicTypeGeoKey=4326), so 2 entries * 4 shorts * 2 bytes = 16 bytes
    geokey_dir_size = (1 + 1) * 4 * 2  # (header + 1 key) * 4 shorts * 2 bytes = 16

    # Offsets
    strip_offset = header_size
    pixel_scale_offset = strip_offset + strip_size
    tiepoint_offset = pixel_scale_offset + pixel_scale_size
    geokey_offset = tiepoint_offset + tiepoint_size
    ifd_offset = geokey_offset + geokey_dir_size

    buf = bytearray()

    # Header
    buf += b'II'                          # little-endian
    buf += pack_le_u16(42)                # TIFF magic
    buf += pack_le_u32(ifd_offset)        # offset to first IFD

    # Image data (strip)
    for h in elev:
        buf += pack_le_f32(h)

    # ModelPixelScale (3 doubles: ScaleX, ScaleY, ScaleZ)
    buf += pack_le_f64(PIXEL_SCALE_X)
    buf += pack_le_f64(-PIXEL_SCALE_Y)    # negative = north-up
    buf += pack_le_f64(0.0)

    # ModelTiepoint (6 doubles: I, J, K, X, Y, Z)
    buf += pack_le_f64(0.0)   # I (raster col)
    buf += pack_le_f64(0.0)   # J (raster row)
    buf += pack_le_f64(0.0)   # K
    buf += pack_le_f64(WEST)  # X (model easting/lon)
    buf += pack_le_f64(NORTH) # Y (model northing/lat)
    buf += pack_le_f64(0.0)   # Z

    # GeoKeyDirectory (4 shorts per entry: KeyId, TIFFTagLocation, Count, Value_Offset)
    # Header: version=1, keyRev=1, minorRev=0, numKeys=1
    buf += pack_le_u16(1)    # KeyDirVersion
    buf += pack_le_u16(1)    # KeyRev
    buf += pack_le_u16(0)    # MinorRev
    buf += pack_le_u16(1)    # NumberOfKeys
    # Key 1: GeographicTypeGeoKey (2048) = EPSG:4326
    buf += pack_le_u16(2048) # KeyId
    buf += pack_le_u16(0)    # TIFFTagLocation (0 = value inline)
    buf += pack_le_u16(1)    # Count
    buf += pack_le_u16(4326) # Value_Offset (EPSG:4326)

    # IFD
    buf += pack_le_u16(num_entries)

    def ifd_entry(tag, typ, count, value):
        return pack_le_u16(tag) + pack_le_u16(typ) + pack_le_u32(count) + pack_le_u32(value)

    # Types: 1=BYTE, 2=ASCII, 3=SHORT, 4=LONG, 11=FLOAT, 12=DOUBLE
    entries = []
    entries.append(ifd_entry(256, 3, 1, WIDTH))           # ImageWidth (SHORT)
    entries.append(ifd_entry(257, 3, 1, HEIGHT))          # ImageLength (SHORT)
    entries.append(ifd_entry(258, 3, 1, 32))              # BitsPerSample (SHORT)
    entries.append(ifd_entry(259, 3, 1, 1))               # Compression = None
    entries.append(ifd_entry(262, 3, 1, 1))               # PhotometricInterpretation
    entries.append(ifd_entry(273, 4, 1, strip_offset))    # StripOffsets (LONG)
    entries.append(ifd_entry(277, 3, 1, 1))               # SamplesPerPixel
    entries.append(ifd_entry(278, 3, 1, HEIGHT))          # RowsPerStrip
    entries.append(ifd_entry(279, 4, 1, strip_size))      # StripByteCounts
    entries.append(ifd_entry(339, 3, 1, 3))               # SampleFormat = IEEEFP
    # GeoTIFF tags (type 12 = DOUBLE, type 3 = SHORT)
    entries.append(ifd_entry(33550, 12, 3, pixel_scale_offset))  # ModelPixelScale
    entries.append(ifd_entry(33922, 12, 6, tiepoint_offset))     # ModelTiepoint
    entries.append(ifd_entry(34735, 3, 8, geokey_offset))        # GeoKeyDirectory (8 shorts = 4 header + 1 key)

    # Sort entries by tag (TIFF requires sorted IFD)
    # They're already in ascending order above, but let's be safe
    # Actually we need to pack them in tag order
    # The entries above are already in tag order

    for e in entries:
        buf += e

    # Next IFD offset (0 = no more IFDs)
    buf += pack_le_u32(0)

    with open(OUT_PATH, 'wb') as f:
        f.write(buf)

    print(f"Wrote {OUT_PATH}: {len(buf)} bytes")
    print(f"  Grid: {WIDTH}x{HEIGHT} float32")
    print(f"  Bounds: W={WEST} S={SOUTH} E={EAST} N={NORTH}")
    print(f"  PixelScale: ({PIXEL_SCALE_X}, {-PIXEL_SCALE_Y})")
    print(f"  EPSG: 4326 (geographic)")

if __name__ == "__main__":
    elev = generate_elevation()
    build_tiff(elev)
