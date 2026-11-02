"""
Generate the full PNG icon set from the master brand mark.

Usage:  python scripts/generate-icons.py [source.png]     (default: change.png)

change.png is expected to be the CURVED master produced by process-logo.py:
the white rounded-corner tile with the grey surround removed and the corners
transparent (RGBA). Outputs (LANCZOS resampling; Pillow is the only dependency):

  favicon.png            48x48    browser-tab icon (<link rel="icon">) —
                                  transparent corners preserved
  icon-192.png          192x192   PWA install icon (manifest.json, "any") —
                                  transparent corners preserved
  icon-512.png          512x512   PWA install/splash icon ("any")
  logo.png              512x512   in-page login-family / print logo
                                  (transparent corners preserved)
  apple-touch-icon.png  180x180   iOS home-screen icon — flattened onto the
                                  tile fill colour (iOS wants a filled canvas)
  icon-maskable-512.png 512x512   Android adaptive icon ("maskable") — tile
                                  fill background with the mark at the 80%
                                  safe zone so the OS can crop it freely
  nbg.png                        in-repo mirror of the master (same bytes)
"""
import shutil
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT / "change.png"

SQUARE_SIZES = {
    "favicon.png": 48,
    "icon-192.png": 192,
    "icon-512.png": 512,
    "logo.png": 512,
}
APPLE_TOUCH_SIZE = 180
MASKABLE_SIZE = 512
MASKABLE_SCALE = 0.80  # mark occupies 80% of the canvas -> Android safe zone


def tile_fill_color(master):
    """Sample the tile's fill colour from its top white margin."""
    px = master.convert("RGB").getpixel((master.width // 2, min(3, master.height - 1)))
    return px if min(px) >= 250 else (255, 255, 255)


def main():
    source_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SOURCE
    if not source_path.is_absolute():
        source_path = ROOT / source_path
    if not source_path.exists():
        print("ERROR: source not found: " + str(source_path))
        return 1

    master = Image.open(source_path).convert("RGBA")
    print("Source: {} ({}x{})".format(source_path.name, master.width, master.height))

    # Keep nbg.png in sync with the master brand mark.
    shutil.copyfile(str(source_path), str(ROOT / "nbg.png"))
    print("Refreshed: nbg.png")

    # Icons that keep the transparent rounded corners.
    for name, size in SQUARE_SIZES.items():
        master.resize((size, size), Image.LANCZOS).save(str(ROOT / name), "PNG")
        print("Wrote: {} ({}x{})".format(name, size, size))

    fill = tile_fill_color(master)
    print("Tile fill colour: {}".format(fill))

    # apple-touch-icon: flatten onto the fill colour (filled canvas for iOS).
    flat = Image.new("RGB", master.size, fill)
    flat.paste(master, (0, 0), master)
    flat.resize((APPLE_TOUCH_SIZE, APPLE_TOUCH_SIZE), Image.LANCZOS).save(
        str(ROOT / "apple-touch-icon.png"), "PNG")
    print("Wrote: apple-touch-icon.png ({}x{}, filled)".format(APPLE_TOUCH_SIZE, APPLE_TOUCH_SIZE))

    # Maskable: fill-coloured canvas with the mark at the 80% safe zone. The
    # mark's own transparent corners blend into the same fill, so the OS can
    # crop to any shape without ever clipping the artwork.
    canvas = Image.new("RGB", (MASKABLE_SIZE, MASKABLE_SIZE), fill)
    mark_size = round(MASKABLE_SIZE * MASKABLE_SCALE)
    mark = master.resize((mark_size, mark_size), Image.LANCZOS)
    offset = ((MASKABLE_SIZE - mark_size) // 2, (MASKABLE_SIZE - mark_size) // 2)
    canvas.paste(mark, offset, mark)
    canvas.save(str(ROOT / "icon-maskable-512.png"), "PNG")
    print("Wrote: icon-maskable-512.png ({}x{}, mark {}px on {})".format(
        MASKABLE_SIZE, MASKABLE_SIZE, mark_size, fill))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
