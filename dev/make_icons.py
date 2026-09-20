#!/usr/bin/env python3
"""生成扩展图标（16/32/48/128）。设计：靛蓝→紫罗兰渐变圆角方块 + 白色对话气泡 + AI 字样。"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
SS = 8  # 超采样倍数，先画大图再缩小，边缘才干净

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial Bold.ttf",
]

def load_font(px):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, px)
            except Exception:
                continue
    return ImageFont.load_default()

def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))

def draw_icon(size):
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # --- 渐变底 ---
    grad = Image.new("RGBA", (S, S))
    gd = grad.load()
    c1, c2 = (99, 102, 241), (139, 92, 246)  # indigo-500 -> violet-500
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * (S - 1)) if S > 1 else 0
            gd[x, y] = lerp(c1, c2, t) + (255,)

    # 圆角遮罩
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)

    # --- 对话气泡 ---
    pad = S * 0.21
    bx0, by0, bx1, by1 = pad, pad * 1.06, S - pad, S - pad * 1.34
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=int(S * 0.13), fill=(255, 255, 255, 255))

    # 气泡尾巴（左下角三角）
    tail_w = S * 0.13
    d.polygon(
        [
            (bx0 + S * 0.12, by1 - S * 0.02),
            (bx0 + S * 0.12 + tail_w, by1 - S * 0.02),
            (bx0 + S * 0.09, by1 + S * 0.145),
        ],
        fill=(255, 255, 255, 255),
    )

    # --- AI 字样 ---
    f = load_font(int((by1 - by0) * 0.60))
    text = "AI"
    tb = d.textbbox((0, 0), text, font=f)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    d.text(
        ((bx0 + bx1) / 2 - tw / 2 - tb[0], (by0 + by1) / 2 - th / 2 - tb[1]),
        text,
        font=f,
        fill=(79, 70, 229, 255),
    )

    return img.resize((size, size), Image.LANCZOS)

os.makedirs(OUT, exist_ok=True)
for s in (16, 32, 48, 128):
    p = os.path.join(OUT, f"icon{s}.png")
    draw_icon(s).save(p, "PNG")
    print("wrote", os.path.relpath(p), os.path.getsize(p), "bytes")
