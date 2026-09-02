#!/usr/bin/env python3
"""NAV homepage — three animated 2D pixel-art GIFs (STEP 01/02/03).

Deterministic, hand-drawn pixel art in the exact site palette. Logical grid
80x48, rendered x2 -> 160x96 intrinsic so the <img class="h-24"> (96 CSS px)
displays at a perfect 1:1 (and 2x on retina) with image-rendering: pixelated.
Seamless loops, transparent background, GIF palette built by hand (no dither).
"""
import math
from PIL import Image

W, H, SCALE, F = 80, 48, 2, 32          # logical size, upscale, frames
DELAY = 80                               # ms per frame

# palette: index 0 = transparent
PAL = {
    "T":  (0, 0, 0),        # transparent slot
    "K":  (0x0c, 0x11, 0x16),  # ink
    "K2": (0x14, 0x19, 0x1f),
    "K3": (0x24, 0x2c, 0x34),
    "MD": (0x56, 0x6a, 0x7f),  # metal dark
    "MM": (0x93, 0xa4, 0xb1),  # metal mid
    "ML": (0xc9, 0xd2, 0xd8),  # metal light
    "MW": (0xf5, 0xf7, 0xf8),  # silver white
    "GD": (0x7a, 0x61, 0x12),  # gold dark
    "G":  (0xc9, 0xa2, 0x27),  # gold
    "GL": (0xe8, 0xc9, 0x5a),  # gold light
    "GW": (0xff, 0xf3, 0xb0),  # gold pale
    "RD": (0x00, 0x7a, 0x1c),  # green dark
    "R":  (0x00, 0xc8, 0x05),  # robinhood green
    "RL": (0x7d, 0xff, 0x9a),  # green light
    "WH": (0xff, 0xff, 0xff),
}
KEYS = list(PAL)
IDX = {k: i for i, k in enumerate(KEYS)}
FLAT = [c for k in KEYS for c in PAL[k]]


class Grid:
    def __init__(self):
        self.g = [[0] * W for _ in range(H)]

    def px(self, x, y, k):
        x, y = int(x), int(y)
        if 0 <= x < W and 0 <= y < H:
            self.g[y][x] = IDX[k]

    def rect(self, x0, y0, x1, y1, k):
        for y in range(int(y0), int(y1) + 1):
            for x in range(int(x0), int(x1) + 1):
                self.px(x, y, k)

    def hline(self, x0, x1, y, k):
        self.rect(x0, y, x1, y, k)

    def vline(self, x, y0, y1, k):
        self.rect(x, y0, x, y1, k)

    def disc(self, cx, cy, r, k):
        for y in range(int(cy - r), int(cy + r) + 1):
            for x in range(int(cx - r), int(cx + r) + 1):
                if (x - cx) ** 2 + (y - cy) ** 2 <= r * r + 0.4:
                    self.px(x, y, k)

    def ring(self, cx, cy, r0, r1, k):
        for y in range(int(cy - r1), int(cy + r1) + 1):
            for x in range(int(cx - r1), int(cx + r1) + 1):
                d = (x - cx) ** 2 + (y - cy) ** 2
                if r0 * r0 <= d <= r1 * r1 + 0.4:
                    self.px(x, y, k)

    def to_image(self):
        im = Image.new("P", (W, H), 0)
        im.putpalette(FLAT + [0] * (768 - len(FLAT)))
        for y in range(H):
            for x in range(W):
                im.putpixel((x, y), self.g[y][x])
        return im.resize((W * SCALE, H * SCALE), Image.NEAREST)


def save_gif(name, frames):
    frames[0].save(
        name, save_all=True, append_images=frames[1:], loop=0,
        duration=DELAY, transparency=0, disposal=2, optimize=False,
    )
    print("wrote", name, len(frames), "frames")


def sparkle(g, x, y, ph):
    """4-phase twinkle: dot -> plus -> bright plus -> dot."""
    ph %= 1.0
    if ph < 0.18:
        g.px(x, y, "GL")
    elif ph < 0.42:
        for dx, dy in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)):
            g.px(x + dx, y + dy, "GW")
        g.px(x, y, "WH")
    elif ph < 0.6:
        g.px(x, y, "GW")
    # else: off


def coin(g, cx, cy, r, spin, small=False):
    """Gold coin; spin in [0,1) -> width |cos|. Face shows a tick mark."""
    w = abs(math.cos(math.pi * spin))
    half = max(1, round(r * w))
    if half <= 1:                       # edge-on
        g.vline(cx, cy - r + 1, cy + r - 1, "GD")
        g.vline(cx, cy - r + 2, cy + r - 2, "G")
        g.px(cx, cy - r + 2, "GL")
        return
    for y in range(-r, r + 1):
        span = round(half * math.sqrt(max(0.0, 1 - (y / r) ** 2)))
        if span == 0 and abs(y) == r:
            continue
        g.hline(cx - span, cx + span, cy + y, "G")
    # rim
    for y in range(-r, r + 1):
        span = round(half * math.sqrt(max(0.0, 1 - (y / r) ** 2)))
        g.px(cx - span, cy + y, "GD")
        g.px(cx + span, cy + y, "GD")
    g.hline(cx - half + 1, cx - max(0, half - 2), cy - r + 1, "GL")
    if half >= r - 1 and not small:     # near face-on: $ tick
        g.vline(cx, cy - 2, cy + 2, "GD")
        g.hline(cx - 1, cx + 1, cy - 2, "GD")
        g.hline(cx - 1, cx + 1, cy + 2, "GD")
        g.px(cx - 1, cy - 1, "GD"), g.px(cx + 1, cy + 1, "GD")
        g.px(cx, cy - 3, "GL")


def bezier(t, p0, p1, p2):
    u = 1 - t
    return (u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
            u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1])


# ---------------------------------------------------------------- STEP 01
def frame_coins(f):
    g = Grid()
    t0 = f / F
    # fee intake port (right): brushed-metal plate with green slot mouth
    g.rect(60, 12, 77, 36, "MD")            # frame shadow
    g.rect(59, 11, 76, 35, "ML")            # plate
    g.rect(59, 11, 76, 12, "MW")            # top sheen
    g.vline(59, 11, 35, "MW")
    for y in range(14, 34, 3):              # brushed texture
        g.px(74, y, "MM"), g.px(62, y + 1, "MM")
    g.rect(62, 18, 66, 30, "K")             # slot mouth (coins enter here)
    g.vline(62, 18, 30, "K2")
    g.rect(69, 15, 73, 17, "K2")            # LED housing
    # 80/15/5 split bars etched on plate
    g.hline(69, 73, 21, "RD"), g.hline(69, 71, 24, "RD"), g.hline(69, 70, 27, "RD")
    # coins flying a rising arc into the slot
    entering = False
    for i in range(6):
        t = (t0 + i / 6) % 1.0
        x, y = bezier(t, (4, 40), (26, 0), (63, 23))
        if x >= 61:                          # swallowed by the slot
            if x < 66:
                entering = True
            continue
        coin(g, round(x), round(y), 4, t * 2.0 + i * 0.17)
    # LED flashes green when a coin drops in
    led = "RL" if entering else ("R" if (f % 8) < 5 else "RD")
    g.rect(70, 16, 72, 16, led)
    # 1% fee tick rising from the path start
    ty = 38 - round(6 * ((t0 * 2) % 1.0))
    if (t0 * 2) % 1.0 < 0.75:
        g.px(8, ty, "RD"), g.px(10, ty - 2, "RD"), g.px(9, ty - 1, "R")
    # twinkles along the arc
    sparkle(g, 22, 10, t0 + 0.00)
    sparkle(g, 40, 8, t0 + 0.45)
    sparkle(g, 12, 26, t0 + 0.7)
    return g.to_image()


# ---------------------------------------------------------------- STEP 02
def frame_vault(f):
    g = Grid()
    t0 = f / F
    cx, cy, r = 40, 24, 21
    # hinges (left) + frame tabs
    g.rect(15, 14, 19, 18, "MD"), g.rect(15, 30, 19, 34, "MD")
    g.rect(16, 15, 18, 17, "MM"), g.rect(16, 31, 18, 33, "MM")
    # door: outer rim -> face
    g.disc(cx, cy, r, "MD")                 # rim shadow ring
    g.disc(cx, cy, r - 1, "MM")
    g.disc(cx, cy, r - 3, "ML")             # face
    # top-left sheen arc on the face
    for a in range(150, 260, 6):
        x = cx + (r - 4) * math.cos(math.radians(a))
        y = cy + (r - 4) * math.sin(math.radians(a))
        g.px(round(x), round(y), "MW")
    # brushed face texture
    for y in range(int(cy - r + 5), int(cy + r - 4), 4):
        for x in range(int(cx - r + 6), int(cx + r - 5), 5):
            if (x - cx) ** 2 + (y - cy) ** 2 < (r - 5) ** 2:
                g.px(x, y, "MM")
    # 8 rim bolts
    for i in range(8):
        a = math.radians(i * 45 + 22.5)
        bx, by = cx + (r - 2) * math.cos(a), cy + (r - 2) * math.sin(a)
        g.px(round(bx), round(by), "K3")
        g.px(round(bx), round(by) - 1, "MW")
    # groove ring
    g.ring(cx, cy, r - 8, r - 7, "MM")
    # rotating 4-spoke wheel (90 deg per loop -> seamless)
    ang = math.radians(90 * t0 + 45)
    for i in range(4):
        a = ang + i * math.pi / 2
        for rr in range(3, 11):
            x, y = cx + rr * math.cos(a), cy + rr * math.sin(a)
            g.px(round(x), round(y), "MD")
            g.px(round(x) + 1, round(y), "MD")
        ex, ey = cx + 10 * math.cos(a), cy + 10 * math.sin(a)
        g.px(round(ex), round(ey), "K3")    # spoke tip cap
    g.ring(cx, cy, 10, 11, "MD")            # wheel outer ring
    # gold hub
    g.disc(cx, cy, 3, "GD")
    g.disc(cx, cy, 2, "G")
    g.px(cx - 1, cy - 1, "GL")
    # glint sweeping the face once per loop (45deg bright line)
    s = -20 + 48 * t0
    for d in range(-(r - 5), r - 4):
        x = cx + d
        y = cy - d + round(s)
        for yy in (y, y - 1):
            if (x - cx) ** 2 + (yy - cy) ** 2 < (r - 5) ** 2:
                dx, dy = x - cx, yy - cy
                rr = math.hypot(dx, dy)
                if rr > 11 or rr < 3:       # keep glint off the wheel
                    g.px(x, yy, "MW")
    # status LED block (top right)
    g.rect(63, 6, 69, 10, "K2")
    g.rect(64, 7, 65, 9, "R" if t0 % 0.5 < 0.3 else "RD")
    g.rect(67, 7, 68, 9, "G")
    return g.to_image()


# ---------------------------------------------------------------- STEP 03
def frame_wallet(f):
    g = Grid()
    t0 = f / F
    bobA = round(2.4 * math.sin(2 * math.pi * t0))
    bobB = round(2.4 * math.sin(2 * math.pi * t0 + 2.2))

    def cert(x, ytop, bob, tall):
        y = ytop + bob
        g.rect(x, y, x + 13, y + tall, "MW")         # sheet
        g.rect(x, y, x + 13, y, "WH")
        for xx in range(x, x + 14):                   # ink border
            g.px(xx, y - 1, "K3")
        g.vline(x - 1, y, y + tall, "K3"), g.vline(x + 14, y, y + tall, "K3")
        g.rect(x + 2, y + 2, x + 11, y + 3, "R")      # green header
        g.px(x + 2, y + 2, "RL")
        for i, ly in enumerate(range(y + 6, y + tall - 1, 3)):  # text lines
            g.hline(x + 2, x + 11 - (i % 2) * 3, ly, "MM")

    # certificates rising from the wallet (drawn first, wallet covers below)
    cert(24, 6, bobA, 26)
    cert(42, 10, bobB, 24)
    # flipping gold coin
    coin(g, 66, 12 + round(1.5 * math.sin(2 * math.pi * t0 + 1.1)), 5,
         t0 * 2.0)
    # wallet body
    g.rect(18, 28, 62, 45, "K2")                     # leather
    g.rect(18, 28, 62, 29, "K3")                     # top edge light
    g.rect(18, 44, 62, 45, "K")
    g.vline(18, 28, 45, "K3"), g.vline(62, 28, 45, "K")
    g.rect(20, 30, 60, 31, "K")                      # slot mouth shadow
    for x in range(21, 60, 3):                       # green stitching
        g.px(x, 33, "RD"), g.px(x + 1, 42, "RD")
    # clasp: gold NAV button
    g.rect(37, 36, 43, 40, "GD")
    g.rect(38, 37, 42, 39, "G")
    g.px(38, 37, "GL")
    g.px(40, 38, "GD")
    # led corner stub on wallet
    g.px(59, 34, "R" if (f % 10) < 6 else "RD")
    # twinkles
    sparkle(g, 22, 4, t0 + 0.2)
    sparkle(g, 58, 6, t0 + 0.65)
    sparkle(g, 72, 24, t0 + 0.05)
    return g.to_image()


if __name__ == "__main__":
    import os
    out = os.path.join(os.path.dirname(__file__), "..", "src", "assets")
    save_gif(os.path.join(out, "coins.gif"), [frame_coins(f) for f in range(F)])
    save_gif(os.path.join(out, "vault.gif"), [frame_vault(f) for f in range(F)])
    save_gif(os.path.join(out, "wallet.gif"), [frame_wallet(f) for f in range(F)])
    # 4-frame contact sheets (x4) for visual QA
    for name, fn in (("coins", frame_coins), ("vault", frame_vault), ("wallet", frame_wallet)):
        frames = [fn(f) for f in (0, 8, 16, 24)]
        sheet = Image.new("RGB", (W * SCALE * 4 * 2, H * SCALE * 2), (245, 247, 248))
        for i, fr in enumerate(frames):
            fr2 = fr.convert("RGBA")
            px = fr2.load()
            for y in range(fr2.height):
                for x in range(fr2.width):
                    if fr.getpixel((x, y)) == 0:
                        px[x, y] = (245, 247, 248, 255)
            fr2 = fr2.resize((W * SCALE * 2, H * SCALE * 2), Image.NEAREST)
            sheet.paste(fr2.convert("RGB"), (i * W * SCALE * 2, 0))
        sheet.save(f"/home/user/floor_qa2/sheet_{name}.png")
        print("sheet", name)
