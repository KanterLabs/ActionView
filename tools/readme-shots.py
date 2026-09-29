#!/usr/bin/env python3
"""Turn `make smoke` renders (real gnome-shell, sanitized fixtures) into README images.

Usage: make smoke && tools/readme-shots.py [smoke-dir] [out-dir]
Needs Pillow + numpy.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "build/smoke")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "docs/assets")
PANEL_H = 32


def load(name: str) -> Image.Image:
    return Image.open(SRC / f"{name}.png").convert("RGB")


def bbox(img: Image.Image, region: tuple[int, int, int, int], pad: int = 0) -> tuple[int, int, int, int]:
    """Bounding box of everything in `region` that differs from the wallpaper."""
    a = np.asarray(img).astype(int)
    bg = a[img.height - 10, 10]
    x0, y0, x1, y1 = region
    mask = np.abs(a[y0:y1, x0:x1] - bg).sum(axis=2) > 30
    ys, xs = np.nonzero(mask)
    return (max(0, x0 + xs.min() - pad), max(0, y0 + ys.min() - pad),
            min(img.width, x0 + xs.max() + 1 + pad), min(img.height, y0 + ys.max() + 1 + pad))


def font(size: int) -> ImageFont.ImageFont:
    for path in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                 "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf"):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def menu(name: str) -> Image.Image:
    img = load(name)
    # Menu hangs from the panel on the right; include the panel strip above it.
    # Measure below the notification banner so a banner can't widen the crop.
    x0, _, x1, _ = bbox(img, (700, 200, img.width, img.height), pad=1)
    _, _, _, y1 = bbox(img, (x0, PANEL_H + 4, x1, img.height), pad=10)
    return img.crop((x0, 0, min(img.width, x1 + 8), y1))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    menu("base-to-queued").save(OUT / "menu.png")
    menu("base-to-concluded-failure").save(OUT / "failure.png")
    menu("base-to-offline").save(OUT / "offline.png")

    # Notification banner (captured with the menu closed).
    img = load("base-to-queued-panel")
    x0, y0, x1, y1 = bbox(img, (0, PANEL_H + 2, 1000, 260), pad=12)
    img.crop((x0, max(y0, PANEL_H), x1, y1)).save(OUT / "notification.png")

    # Preferences window.
    img = load("prefs")
    img.crop(bbox(img, (250, 160, 1030, img.height), pad=14)).save(OUT / "prefs.png")

    # Badge states: the right end of the real panel, one row per state.
    states = [
        ("base", "Idle"),
        ("base-to-running", "Running"),
        ("base-to-queued", "Running + queued"),
        ("base-to-concluded-failure", "Unseen failure"),
        ("base-to-alert", "Critical alert"),
        ("collector-hung", "Stale data"),
        ("base-to-offline", "Unreachable"),
    ]
    crops = [load(f"{step}-panel").crop((1040, 0, 1240, PANEL_H)) for step, _ in states]
    scale = 2
    label_w, gap = 220, 10
    w = (crops[0].width + label_w) * scale
    h = (PANEL_H + gap) * len(crops) * scale + gap * scale
    sheet = Image.new("RGB", (w, h), (24, 24, 27))
    draw = ImageDraw.Draw(sheet)
    f = font(15 * scale)
    for i, ((_, label), crop) in enumerate(zip(states, crops)):
        y = (gap + i * (PANEL_H + gap)) * scale
        sheet.paste(crop.resize((crop.width * scale, PANEL_H * scale), Image.LANCZOS), (0, y))
        draw.text(((crop.width + 16) * scale, y + 7 * scale), label, fill=(230, 232, 236), font=f)
    sheet.save(OUT / "badges.png")

    for p in sorted(OUT.glob("*.png")):
        print(f"{p}  {Image.open(p).size}")


if __name__ == "__main__":
    main()
