"""
Turn change.png into the curved brand master.

The uploaded change.png is a white rounded-corner app tile sitting on a grey
canvas with a soft drop shadow. This script removes that extra background:

  1. find the tile edges. The tile's white edge pixels read >= 253 while the
     drop shadow hugging them reads <= 245, so a ">=253 pixel immediately
     followed by a <=245 pixel" marks the edge exactly — scanning each
     row/column inward from the canvas border, the first such match is the
     tile's boundary. (A plain brightness threshold cannot work here: the
     grey canvas ~248-252, the tile fill ~249-252 and the shadow's soft band
     ~246-252 all overlap — but the shadow's dark core is a hard wall.)
  2. x0/y0 = the left/top matches' supported minimum, x1/y1 = the
     right/bottom matches' supported maximum, where "supported" means at
     least MIN_SUPPORT scans agree within +-3 px. That discards one-off
     speckle matches and the rows/columns where the artwork (the red ring,
     the text) pokes near the edge.
  3. fit the corner radius on the top-left/bottom-left arcs (the left-edge
     matches along the corner rows) with an inlier-trimmed least squares
     against the circle model inset(d) = r - sqrt(2*r*d - d*d).
  4. stamp a rounded-rectangle alpha mask on the ORIGINAL pixels, crop to
     the tile, and save.

The original upload is preserved once as change-original.png. Refuses to run
if change.png already has transparent corners (already processed).
Usage:  python scripts/process-logo.py [source.png]
"""
import shutil
import sys
from collections import Counter
from math import sqrt
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "change.png"
BACKUP = ROOT / "change-original.png"

EDGE_WHITE = 253        # the tile's white edge reads >= 253
EDGE_DARK = 245         # the shadow hugging the edge reads <= 245
MIN_SUPPORT = 20        # scans that must agree on an edge value
SUPPORT_TOL = 3         # ...within this many px
SCAN_BAND = (150, 1104)  # rows/columns scanned (clear of the canvas corners)
MAX_RADIUS = 500        # corner-radius search ceiling (tile side is ~1100)
BORDER_MARGIN = 5       # sanity: the detected tile must not touch the canvas edge
MIN_SIDE = 400          # sanity: the detected tile must be a sane size
MAX_ASPECT_SKEW = 0.03  # the tile is square; allow 3%


def edge_matches(px, w, h):
    """First (>=EDGE_WHITE immediately followed by <=EDGE_DARK) match per
    row/column, scanning inward from each canvas border. lefts is a list of
    (row, x) pairs (also used for the corner-arc fit); the rest are values."""
    y_lo, y_hi = SCAN_BAND
    lefts, rights, tops, bottoms = [], [], [], []
    for y in range(y_lo, y_hi):
        for x in range(1, w):
            if px[x, y] >= EDGE_WHITE and px[x - 1, y] <= EDGE_DARK:
                lefts.append((y, x))
                break
        for x in range(w - 2, -1, -1):
            if px[x, y] >= EDGE_WHITE and px[x + 1, y] <= EDGE_DARK:
                rights.append(x + 1)
                break
    for x in range(y_lo, y_hi):
        for y in range(1, h):
            if px[x, y] >= EDGE_WHITE and px[x, y - 1] <= EDGE_DARK:
                tops.append(y)
                break
        for y in range(h - 2, -1, -1):
            if px[x, y] >= EDGE_WHITE and px[x, y + 1] <= EDGE_DARK:
                bottoms.append(y + 1)
                break
    return lefts, rights, tops, bottoms


def supported_extreme(values, want_max):
    """The edge value: the largest cluster of >= MIN_SUPPORT agreeing scans
    (within SUPPORT_TOL of an extreme value), reported as that cluster's
    median. Returns (value, support) or (None, 0)."""
    if not values:
        return None, 0
    counts = Counter(values)
    for v in sorted(counts, reverse=want_max):
        group = sorted(mv for mv in values if abs(mv - v) <= SUPPORT_TOL)
        if len(group) >= MIN_SUPPORT:
            n = len(group)
            median = group[n // 2] if n % 2 else (group[n // 2 - 1] + group[n // 2]) // 2
            return median, len(group)
    return None, 0


def fit_radius(lefts, x0, y0, x1, y1):
    """Inlier-trimmed least-squares corner radius from the left-edge matches
    along the top-left and bottom-left arcs."""
    points = []
    for y, x in lefts:
        if y0 <= y <= y0 + MAX_RADIUS:
            points.append((y - y0, x - x0))
        elif y1 - MAX_RADIUS <= y <= y1:
            points.append((y1 - y, x - x0))
    points = [(d, inset) for d, inset in points if 0 <= inset <= MAX_RADIUS]
    if not points:
        return None
    # RANSAC-lite: the candidate radius with the most inliers, ...
    best_r, best_pts = None, []
    for r in range(20, MAX_RADIUS + 1, 2):
        inliers = []
        for d, inset in points:
            predicted = r - sqrt(max(0.0, 2 * r * d - d * d)) if d < r else 0.0
            if abs(inset - predicted) <= 4:
                inliers.append((d, inset))
        if len(inliers) > len(best_pts):
            best_r, best_pts = r, inliers
    if not best_pts:
        return None
    # ... then a least-squares refine over those inliers.
    best_r2, best_err = best_r, None
    for r in range(max(20, best_r - 4), min(MAX_RADIUS, best_r + 5)):
        err = 0
        for d, inset in best_pts:
            predicted = r - sqrt(max(0.0, 2 * r * d - d * d)) if d < r else 0.0
            err += (inset - predicted) ** 2
        if best_err is None or err < best_err:
            best_r2, best_err = r, err
    return best_r2


def main():
    source_path = Path(sys.argv[1]) if len(sys.argv) > 1 else SOURCE
    if not source_path.is_absolute():
        source_path = ROOT / source_path
    if not source_path.exists():
        print("ERROR: source not found: " + str(source_path))
        return 1

    im = Image.open(source_path).convert("RGBA")

    # Guard: a fully transparent corner pixel means this file was already
    # processed — running again would re-fit a smaller tile.
    if im.getchannel("A").getextrema()[0] == 0:
        print("ERROR: {} already has transparent corners (already processed).".format(source_path.name))
        print("Restore the original upload first if you want to re-run.")
        return 1

    if not BACKUP.exists():
        shutil.copyfile(str(source_path), str(BACKUP))
        print("Backup: {} (original upload preserved)".format(BACKUP.name))

    # 1-2. edges from the white-meets-shadow signature.
    px = im.convert("L").load()
    w, h = im.size
    lefts, rights, tops, bottoms = edge_matches(px, w, h)
    x0, sup_l = supported_extreme([x for _, x in lefts], want_max=False)
    x1, sup_r = supported_extreme(rights, want_max=True)
    y0, sup_t = supported_extreme(tops, want_max=False)
    y1, sup_b = supported_extreme(bottoms, want_max=True)
    if None in (x0, x1, y0, y1):
        print("ERROR: could not detect all four edges (need >= {} agreeing scans)".format(MIN_SUPPORT))
        return 1
    if x0 < BORDER_MARGIN or y0 < BORDER_MARGIN or x1 > w - BORDER_MARGIN or y1 > h - BORDER_MARGIN:
        print("ERROR: detected tile touches the canvas border: ({}, {}, {}, {})".format(x0, y0, x1, y1))
        return 1
    if x1 - x0 < MIN_SIDE or y1 - y0 < MIN_SIDE:
        print("ERROR: detected tile too small: {}x{}".format(x1 - x0, y1 - y0))
        return 1
    if abs((x1 - x0) - (y1 - y0)) > MAX_ASPECT_SKEW * (x1 - x0):
        print("ERROR: detected tile is not square: {}x{}".format(x1 - x0, y1 - y0))
        return 1
    print("Tile edges: x {}..{}, y {}..{} ({}x{} tile on {}x{} canvas; support {}/{}/{}/{})".format(
        x0, x1, y0, y1, x1 - x0, y1 - y0, w, h, sup_l, sup_r, sup_t, sup_b))

    # 3. corner radius from the left-edge corner arcs.
    best_r = fit_radius(lefts, x0, y0, x1, y1)
    if best_r is None:
        print("ERROR: no corner boundary points found")
        return 1
    print("Fitted corner radius: {}px ({:.1f}% of the {}px side)".format(
        best_r, 100.0 * best_r / (x1 - x0), x1 - x0))

    # 4. rounded-rect alpha mask, crop, save.
    alpha = Image.new("L", im.size, 0)
    ImageDraw.Draw(alpha).rounded_rectangle([x0, y0, x1 - 1, y1 - 1], radius=best_r, fill=255)
    out = im.copy()
    out.putalpha(alpha)
    out = out.crop((x0, y0, x1, y1))
    out.save(str(source_path), "PNG")
    print("Saved curved master: {} -> {}x{} (transparent corners)".format(
        source_path.name, out.width, out.height))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
