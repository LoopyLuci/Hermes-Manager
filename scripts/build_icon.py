"""Generate build/icon.png and build/icon.ico for Hermes Manager (no deps).

Rounded dark tile with a white "H" mark; PNGs are wrapped into a multi-size
.ico. Rasterised with 4x4 supersampling for clean edges.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build"

BG = (27, 35, 56, 255)  # deep indigo tile
FG = (245, 247, 255, 255)  # near-white H
ACCENT = (94, 234, 212, 255)  # teal underline


def _in_rounded_rect(x: float, y: float, size: float) -> bool:
    radius = size * 0.22
    if x < 0 or y < 0 or x >= size or y >= size:
        return False
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius


def _in_h(x: float, y: float, size: float) -> bool:
    """H mark scaled to the tile."""
    u, v = x / size, y / size
    bar_w, bar_gap = 0.13, 0.11
    top, bottom = 0.24, 0.74
    bar1 = 0.26 <= u < 0.26 + bar_w
    bar2 = 0.61 <= u < 0.61 + bar_w
    cross = 0.26 <= u < 0.74 and 0.455 <= v < 0.545
    vertical = top <= v <= bottom and (bar1 or bar2)
    return vertical or cross


def _in_accent(x: float, y: float, size: float) -> bool:
    u, v = x / size, y / size
    return 0.26 <= u < 0.74 and 0.795 <= v < 0.845


def render(size: int) -> bytes:
    rows: list[bytes] = []
    samples = 4
    step = 1.0 / samples
    for py in range(size):
        row = bytearray()
        row.append(0)  # filter: none
        for px in range(size):
            bg_hits = fg_hits = ac_hits = 0
            for sy in range(samples):
                for sx in range(samples):
                    x = px + (sx + 0.5) * step
                    y = py + (sy + 0.5) * step
                    if not _in_rounded_rect(x, y, size):
                        continue
                    bg_hits += 1
                    if _in_h(x, y, size):
                        fg_hits += 1
                    elif _in_accent(x, y, size):
                        ac_hits += 1
            total = samples * samples
            if bg_hits == 0:
                row += bytes((0, 0, 0, 0))
                continue
            if fg_hits * 2 >= bg_hits:
                color = FG
                alpha = round(255 * fg_hits / total)
            elif ac_hits * 2 >= bg_hits:
                color = ACCENT
                alpha = round(255 * ac_hits / total)
            else:
                color = BG
                alpha = round(255 * bg_hits / total)
            row += bytes((color[0], color[1], color[2], max(alpha, color[3] if bg_hits == total else 0)))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    return png


def build_ico(pngs: dict[int, bytes]) -> bytes:
    entries = sorted(pngs, reverse=True)
    header = struct.pack("<HHH", 0, 1, len(entries))
    directory = b""
    blobs = b""
    offset = 6 + 16 * len(entries)
    for size in entries:
        data = pngs[size]
        side = 0 if size >= 256 else size
        directory += struct.pack(
            "<BBBBHHII", side, side, 0, 0, 1, 32, len(data), offset
        )
        blobs += data
        offset += len(data)
    return header + directory + blobs


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    pngs = {size: render(size) for size in sizes}
    (OUT / "icon.png").write_bytes(pngs[256])
    (OUT / "icon.ico").write_bytes(build_ico(pngs))
    print(f"wrote {OUT / 'icon.png'} and {OUT / 'icon.ico'} ({', '.join(map(str, sizes))} px)")


if __name__ == "__main__":
    main()
