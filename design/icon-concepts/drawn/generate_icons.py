from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


SIZE = 1024
SCALE = 2
CANVAS = SIZE * SCALE
OUT_DIR = Path(__file__).resolve().parent


def c(hex_color: str, alpha: int = 255) -> tuple[int, int, int, int]:
    hex_color = hex_color.removeprefix("#")
    return tuple(int(hex_color[i : i + 2], 16) for i in (0, 2, 4)) + (alpha,)


def s(value):
    if isinstance(value, tuple):
        return tuple(int(round(v * SCALE)) for v in value)
    return int(round(value * SCALE))


def lerp_color(a, b, t):
    return tuple((a[i] + (b[i] - a[i]) * t).astype(np.uint8) for i in range(4))


def gradient(size: int, top, bottom, glows=()):
    y = np.linspace(0, 1, size, dtype=np.float32)[:, None]
    x = np.linspace(0, 1, size, dtype=np.float32)[None, :]
    t = np.clip(y * 0.92 + x * 0.16, 0, 1)
    arr = np.zeros((size, size, 4), dtype=np.float32)
    for channel in range(4):
        arr[:, :, channel] = top[channel] * (1 - t) + bottom[channel] * t

    for gx, gy, color, strength, radius in glows:
        dist = np.sqrt((x - gx) ** 2 + (y - gy) ** 2)
        glow = np.clip(1 - dist / radius, 0, 1) ** 2 * strength
        for channel in range(4):
            arr[:, :, channel] = arr[:, :, channel] * (1 - glow) + color[channel] * glow

    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA")


def squircle_mask(size: int, inset: int = 58, exponent: float = 4.8):
    y, x = np.ogrid[:size, :size]
    left = inset * SCALE
    top = (inset - 8) * SCALE
    right = size - inset * SCALE
    bottom = size - (inset + 8) * SCALE
    cx = (left + right) / 2
    cy = (top + bottom) / 2
    rx = (right - left) / 2
    ry = (bottom - top) / 2
    equation = np.abs((x - cx) / rx) ** exponent + np.abs((y - cy) / ry) ** exponent
    return Image.fromarray((equation <= 1).astype(np.uint8) * 255, "L")


def base_icon(top: str, bottom: str, primary: str, secondary: str):
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    mask = squircle_mask(CANVAS)

    shadow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    shadow_alpha = mask.filter(ImageFilter.GaussianBlur(s(24)))
    shadow_layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 128))
    shadow_layer.putalpha(shadow_alpha)
    shadow.alpha_composite(shadow_layer, (0, s(22)))
    canvas.alpha_composite(shadow)

    bg = gradient(
        CANVAS,
        c(top),
        c(bottom),
        (
            (0.22, 0.08, c(primary), 0.36, 0.72),
            (0.86, 0.82, c(secondary), 0.18, 0.54),
        ),
    )
    clipped = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    clipped.paste(bg, (0, 0), mask)
    canvas.alpha_composite(clipped)

    gloss = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    gloss_draw = ImageDraw.Draw(gloss)
    gloss_draw.ellipse(s((90, -240, 934, 534)), fill=(255, 255, 255, 34))
    gloss.putalpha(Image.composite(gloss.getchannel("A"), Image.new("L", (CANVAS, CANVAS), 0), mask))
    canvas.alpha_composite(gloss)

    rim = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    rim_draw = ImageDraw.Draw(rim)
    rim_draw.rounded_rectangle(s((64, 58, 960, 950)), radius=s(205), outline=(255, 255, 255, 34), width=s(3))
    rim.putalpha(Image.composite(rim.getchannel("A"), Image.new("L", (CANVAS, CANVAS), 0), mask))
    canvas.alpha_composite(rim)
    return canvas


def shadowed_round(draw_layer, box, radius, fill, outline=None, width=2, shadow_alpha=72):
    shadow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle(s((box[0], box[1] + 16, box[2], box[3] + 16)), radius=s(radius), fill=(0, 0, 0, shadow_alpha))
    draw_layer.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(s(16))))
    d = ImageDraw.Draw(draw_layer)
    d.rounded_rectangle(s(box), radius=s(radius), fill=fill, outline=outline, width=s(width))


def browser_window(layer, box, accent=(255, 255, 255, 110), fill=(255, 255, 255, 30)):
    d = ImageDraw.Draw(layer)
    x1, y1, x2, y2 = box
    shadowed_round(layer, box, 44, fill, accent, 2, 60)
    d.rounded_rectangle(s((x1 + 18, y1 + 18, x2 - 18, y1 + 102)), radius=s(26), fill=(255, 255, 255, 34))
    for index, color in enumerate(((255, 95, 86, 218), (255, 189, 68, 205), (48, 209, 88, 205))):
        cx = x1 + 58 + index * 42
        cy = y1 + 60
        d.ellipse(s((cx - 11, cy - 11, cx + 11, cy + 11)), fill=color)
    d.line(s((x1 + 26, y1 + 123, x2 - 26, y1 + 123)), fill=(255, 255, 255, 42), width=s(2))


def cursor(layer, x, y, scale=1.0, fill=(255, 255, 255, 238), outline=(8, 14, 28, 205)):
    d = ImageDraw.Draw(layer)
    outer = [(x, y), (x + 80 * scale, y + 188 * scale), (x + 116 * scale, y + 116 * scale), (x + 198 * scale, y + 102 * scale)]
    inner = [(x + 19 * scale, y + 26 * scale), (x + 78 * scale, y + 160 * scale), (x + 106 * scale, y + 96 * scale), (x + 174 * scale, y + 86 * scale)]
    d.polygon([s((px, py)) for px, py in outer], fill=outline)
    d.polygon([s((px, py)) for px, py in inner], fill=fill)


def cubic_points(p0, p1, p2, p3, steps=90):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        x = (1 - t) ** 3 * p0[0] + 3 * (1 - t) ** 2 * t * p1[0] + 3 * (1 - t) * t**2 * p2[0] + t**3 * p3[0]
        y = (1 - t) ** 3 * p0[1] + 3 * (1 - t) ** 2 * t * p1[1] + 3 * (1 - t) * t**2 * p2[1] + t**3 * p3[1]
        pts.append((x, y))
    return pts


def glow_path(layer, points, color, width=16, blur=14):
    glow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.line([s(p) for p in points], fill=color, width=s(width), joint="curve")
    layer.alpha_composite(glow.filter(ImageFilter.GaussianBlur(s(blur))))
    d = ImageDraw.Draw(layer)
    d.line([s(p) for p in points], fill=color, width=s(max(3, width * 0.42)), joint="curve")


def hexagon(cx, cy, radius, rotation=math.pi / 6):
    return [(cx + math.cos(rotation + i * math.tau / 6) * radius, cy + math.sin(rotation + i * math.tau / 6) * radius) for i in range(6)]


def star(layer, cx, cy, radius, color):
    d = ImageDraw.Draw(layer)
    pts = [(cx, cy - radius), (cx + radius * 0.28, cy - radius * 0.28), (cx + radius, cy), (cx + radius * 0.28, cy + radius * 0.28), (cx, cy + radius), (cx - radius * 0.28, cy + radius * 0.28), (cx - radius, cy), (cx - radius * 0.28, cy - radius * 0.28)]
    d.polygon([s(p) for p in pts], fill=color)


def icon_capture_lens():
    img = base_icon("#1f2b4c", "#050711", "#35d9ff", "#ffad45")
    layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    browser_window(layer, (166, 238, 858, 734), accent=(205, 242, 255, 104))
    for y, alpha in ((404, 46), (486, 60), (568, 42)):
        d.rounded_rectangle(s((282, y, 610, y + 18)), radius=s(9), fill=(120, 229, 255, alpha))
    for x, height, alpha in ((300, 84, 95), (354, 142, 120), (408, 106, 98), (462, 196, 130), (516, 132, 100)):
        d.rounded_rectangle(s((x, 574 - height / 2, x + 18, 574 + height / 2)), radius=s(9), fill=(65, 219, 255, alpha))

    ring = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    rd.ellipse(s((366, 350, 676, 660)), fill=(255, 68, 86, 44), outline=(255, 122, 124, 142), width=s(5))
    rd.ellipse(s((438, 422, 604, 588)), fill=(255, 55, 74, 232))
    rd.ellipse(s((477, 461, 565, 549)), fill=(255, 190, 182, 225))
    layer.alpha_composite(ring.filter(ImageFilter.GaussianBlur(s(0.3))))
    cursor(layer, 578, 484, 0.78)
    for cx, cy, radius, color in ((720, 316, 8, "#ffd16a"), (770, 388, 6, "#ff9b42"), (694, 286, 4, "#fff0aa"), (812, 454, 5, "#ffd16a")):
        d.ellipse(s((cx - radius, cy - radius, cx + radius, cy + radius)), fill=c(color, 224))
    img.alpha_composite(layer)
    return img


def icon_forge_token():
    img = base_icon("#261f3c", "#070811", "#ff9b42", "#45e5ff")
    layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    browser_window(layer, (208, 184, 724, 548), accent=(255, 218, 178, 82), fill=(255, 255, 255, 24))
    d.rounded_rectangle(s((300, 350, 612, 366)), radius=s(8), fill=(255, 176, 92, 66))
    d.rounded_rectangle(s((300, 406, 560, 422)), radius=s(8), fill=(255, 176, 92, 48))
    d.polygon([s(p) for p in ((330, 620), (690, 620), (752, 664), (268, 664))], fill=(105, 123, 146, 236))
    d.rounded_rectangle(s((284, 654, 736, 744)), radius=s(28), fill=(55, 69, 91, 255), outline=(225, 238, 255, 82), width=s(3))
    d.polygon([s(p) for p in ((438, 742), (586, 742), (630, 830), (394, 830))], fill=(36, 47, 67, 255))
    d.rounded_rectangle(s((340, 812, 684, 866)), radius=s(22), fill=(27, 35, 52, 255))
    token = hexagon(512, 598, 98)
    glow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.polygon([s(p) for p in token], fill=(69, 229, 255, 126))
    layer.alpha_composite(glow.filter(ImageFilter.GaussianBlur(s(18))))
    d.polygon([s(p) for p in token], fill=(57, 221, 255, 178), outline=(245, 255, 255, 170))
    inner = hexagon(512, 598, 56)
    d.polygon([s(p) for p in inner], fill=(255, 255, 255, 48), outline=(255, 255, 255, 92))
    d.line(s((512, 500, 512, 696)), fill=(255, 255, 255, 62), width=s(3))
    for cx, cy, radius, color in ((384, 590, 5, "#fff1a6"), (642, 566, 7, "#ffd16a"), (690, 626, 8, "#ff9b42"), (354, 548, 4, "#ffd16a")):
        d.ellipse(s((cx - radius, cy - radius, cx + radius, cy + radius)), fill=c(color, 230))
    hammer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hammer)
    hd.rounded_rectangle(s((484, 232, 532, 578)), radius=s(22), fill=(130, 84, 54, 255), outline=(255, 196, 126, 82), width=s(2))
    hd.rounded_rectangle(s((378, 210, 642, 300)), radius=s(28), fill=(158, 181, 203, 255), outline=(255, 255, 255, 102), width=s(3))
    hd.rounded_rectangle(s((344, 236, 410, 286)), radius=s(18), fill=(119, 146, 173, 255))
    hd.rounded_rectangle(s((610, 236, 682, 286)), radius=s(18), fill=(215, 227, 238, 255))
    layer.alpha_composite(hammer.rotate(-31, resample=Image.Resampling.BICUBIC, center=(CANVAS // 2, CANVAS // 2)))
    img.alpha_composite(layer)
    return img


def icon_artifact_flow():
    img = base_icon("#112743", "#051014", "#58f0ce", "#69a6ff")
    layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for index, (dx, dy, alpha) in enumerate(((0, 54, 40), (28, 28, 54), (56, 0, 78))):
        shadowed_round(layer, (176 + dx, 300 + dy, 472 + dx, 520 + dy), 30, (255, 255, 255, alpha), (220, 255, 248, alpha + 30), 2, 38)
        d.rounded_rectangle(s((218 + dx, 358 + dy, 400 + dx, 372 + dy)), radius=s(7), fill=(120, 255, 220, alpha + 36))
        d.rounded_rectangle(s((218 + dx, 410 + dy, 362 + dx, 424 + dy)), radius=s(7), fill=(120, 255, 220, alpha + 22))
    points = cubic_points((430, 458), (520, 356), (612, 596), (724, 468), 110)
    glow_path(layer, points, (87, 245, 211, 220), 22, 16)
    for cx, cy in (points[0], points[34], points[72], points[-1]):
        d.ellipse(s((cx - 18, cy - 18, cx + 18, cy + 18)), fill=(80, 247, 210, 232), outline=(255, 255, 255, 145), width=s(2))
    outer = hexagon(744, 466, 152)
    inner = hexagon(744, 466, 82)
    glow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.polygon([s(p) for p in outer], fill=(77, 220, 255, 92))
    layer.alpha_composite(glow.filter(ImageFilter.GaussianBlur(s(18))))
    d.polygon([s(p) for p in outer], fill=(35, 199, 237, 96), outline=(204, 255, 250, 164))
    d.polygon([s(p) for p in inner], fill=(255, 255, 255, 42), outline=(255, 255, 255, 92))
    for p in inner[::2]:
        d.line(s((744, 466, p[0], p[1])), fill=(255, 255, 255, 58), width=s(2))
    cursor(layer, 260, 522, 0.52, fill=(255, 255, 255, 232), outline=(0, 28, 34, 190))
    img.alpha_composite(layer)
    return img


def icon_replay_agent():
    img = base_icon("#171f47", "#070711", "#9a7cff", "#48e6ff")
    layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    browser_window(layer, (172, 226, 852, 746), accent=(228, 218, 255, 112), fill=(255, 255, 255, 28))
    arc_layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    ad = ImageDraw.Draw(arc_layer)
    ad.arc(s((304, 344, 732, 714)), start=200, end=518, fill=(151, 122, 255, 92), width=s(48))
    layer.alpha_composite(arc_layer.filter(ImageFilter.GaussianBlur(s(14))))
    d.arc(s((304, 344, 732, 714)), start=200, end=518, fill=(162, 139, 255, 230), width=s(22))
    d.polygon([s(p) for p in ((695, 376), (772, 409), (704, 458))], fill=(170, 149, 255, 238))
    d.polygon([s(p) for p in ((466, 426), (466, 622), (626, 524))], fill=(82, 230, 255, 226), outline=(255, 255, 255, 105))
    cursor(layer, 570, 518, 0.73, fill=(255, 255, 255, 238), outline=(16, 13, 40, 202))
    for cx, cy, radius, alpha in ((340, 404, 13, 190), (710, 650, 10, 160), (390, 696, 8, 145)):
        d.ellipse(s((cx - radius, cy - radius, cx + radius, cy + radius)), fill=(97, 234, 255, alpha), outline=(255, 255, 255, 82), width=s(2))
    star(layer, 732, 318, 18, (255, 255, 255, 190))
    img.alpha_composite(layer)
    return img


def save_icon(name: str, image: Image.Image):
    path = OUT_DIR / name
    image.resize((SIZE, SIZE), Image.Resampling.LANCZOS).save(path)
    return path


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    icons = [
        ("browser-forge-drawn-01-capture-lens.png", icon_capture_lens()),
        ("browser-forge-drawn-02-forge-token.png", icon_forge_token()),
        ("browser-forge-drawn-03-artifact-flow.png", icon_artifact_flow()),
        ("browser-forge-drawn-04-agent-replay.png", icon_replay_agent()),
    ]
    paths = [save_icon(name, image) for name, image in icons]

    tile = 360
    gap = 56
    sheet = Image.new("RGBA", (tile * 2 + gap * 3, tile * 2 + gap * 3), (13, 16, 25, 255))
    for index, path in enumerate(paths):
        icon = Image.open(path).convert("RGBA").resize((tile, tile), Image.Resampling.LANCZOS)
        x = gap + (index % 2) * (tile + gap)
        y = gap + (index // 2) * (tile + gap)
        sheet.alpha_composite(icon, (x, y))
    sheet_path = OUT_DIR / "browser-forge-drawn-contact-sheet.png"
    sheet.save(sheet_path)
    for path in [*paths, sheet_path]:
        print(path)


if __name__ == "__main__":
    main()
