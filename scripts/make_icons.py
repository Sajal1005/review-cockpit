"""Regenerates icons/icon{16,48,128}.png using only the Python standard library.

    python scripts/make_icons.py
"""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"
TOP, BOTTOM = (0x9A, 0x6C, 0xF7), (0x5B, 0x2F, 0xC9)  # purple gradient
CHECK = [(0.27, 0.53), (0.43, 0.68), (0.74, 0.35)]  # checkmark polyline, unit square
STROKE = 0.12
RADIUS = 0.24


def in_rounded_rect(x, y):
    cx = min(max(x, RADIUS), 1 - RADIUS)
    cy = min(max(y, RADIUS), 1 - RADIUS)
    return (x - cx) ** 2 + (y - cy) ** 2 <= RADIUS**2


def segment_distance(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def on_check(x, y):
    return any(
        segment_distance(x, y, *CHECK[i], *CHECK[i + 1]) <= STROKE / 2 for i in range(len(CHECK) - 1)
    )


def render(size, ss=4):
    rows = []
    samples = ss * ss
    for py in range(size):
        t = py / max(1, size - 1)
        base = [TOP[i] + (BOTTOM[i] - TOP[i]) * t for i in range(3)]
        row = bytearray([0])  # PNG filter type: none
        for px in range(size):
            inside = check = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) / size
                    y = (py + (sy + 0.5) / ss) / size
                    if in_rounded_rect(x, y):
                        inside += 1
                        check += on_check(x, y)
            if not inside:
                row += bytes(4)
                continue
            mix = check / inside
            row += bytes([round(c * (1 - mix) + 255 * mix) for c in base] + [round(255 * inside / samples)])
        rows.append(bytes(row))
    return b"".join(rows)


def write_png(path, size, pixels):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(pixels, 9)) + chunk(b"IEND", b"")
    )


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for size in (16, 48, 128):
        write_png(OUT / f"icon{size}.png", size, render(size))
        print(f"wrote icons/icon{size}.png")
