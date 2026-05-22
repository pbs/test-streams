#!/usr/bin/env python3
"""Generate a SMPTE-style color bars test video with PBS brand colors.

Edit the CONFIG section below to change colors, resolution, duration, etc.
Frames are streamed to ffmpeg via stdin (raw RGB) — no PNG sequence on disk.
"""
import random
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------

OUTPUT      = Path("pbs-bars.mp4")
WIDTH       = 3840
HEIGHT      = 2160
DURATION    = 90.0     # seconds (>60 so the first drop-frame jump is visible)

# NTSC frame rate: 30000/1001 ≈ 29.97
FPS_NUM     = 30000
FPS_DEN     = 1001

# Label shown in the bottom row:
#   "timecode"  -> SMPTE-style HH:MM:SS:FF / HH:MM:SS;FF (see TIMECODE_DROP_FRAME)
#   None        -> no label
#   any string  -> static text
LABEL                = "timecode"
LABEL_FONT_FRACTION  = 1 / 10   # font height as fraction of video height
# Drop-frame timecode is the US broadcast standard for 29.97/59.94 fps.
# At the start of every minute whose minutes-digit isn't 0 (i.e. minutes
# 01–09, 11–19, …, but NOT 00/10/20/30/40/50), the count skips frame numbers
# :00 and :01 — jumping directly to :02. Defined in SMPTE 12M; uses ';'
# before the frames field instead of ':'.
TIMECODE_DROP_FRAME  = True

# Audio: filtered noise with slow volume swells.
ENABLE_AUDIO    = True
NOISE_COLOR     = "brown"   # white, pink, brown, blue, violet
NOISE_AMPLITUDE = 0.5
LOWPASS_HZ      = 4000     # 0 to disable
SWELL_HZ        = 0.15     # >=0.1
SWELL_DEPTH     = 0.06     # 0..1 — keep low for a barely-there swell

# Loudness normalization (EBU R128). -23 LUFS is the EU broadcast target;
# US ATSC A/85 / CALM Act uses -24 LKFS. Set TARGET_LUFS = None to disable.
TARGET_LUFS    = -23.0
LOUDNESS_RANGE = 7.0
TRUE_PEAK_DB   = -2.0
SAVE_PNG       = None   # e.g. Path("pbs-bars.png") to also save the first frame

# Sidecar WebVTT caption file with one cue per second, anchored near the top.
WRITE_VTT = True

# PBS brand palette
TEAL        = "#48D3CD"
WHITE       = "#FFFFFF"
YELLOW      = "#FFCF00"
CORAL       = "#FE704E"
LIGHT_BLUE  = "#486CD8"
MEDIUM_BLUE = "#0F1E8C"
NAVY_BLUE   = "#0A145A"
PBS_BLUE    = "#2638C4"

# 7 vertical bars across the top 2/3
TOP_BARS = [MEDIUM_BLUE, PBS_BLUE, LIGHT_BLUE, WHITE, TEAL, YELLOW, CORAL]

# 7 bars in the reverse-blue strip (middle 1/12)
MID_BARS = [YELLOW, NAVY_BLUE, CORAL, NAVY_BLUE, LIGHT_BLUE, NAVY_BLUE, TEAL]

# Solid color for the bottom 1/4
BOTTOM_COLOR = PBS_BLUE

# Per-second random color swap. One position in the top or middle row is
# reassigned every full second under these rules:
#   - PBS_BLUE is never used in the middle row
#   - NAVY_BLUE positions in the middle row are locked
#   - the incoming color must not already be present in that row
#   - a middle-row color must not match the color directly above it
#   - a location may not immediately revert to its previous color
SWAP_EVERY_SECOND = True
RANDOM_SEED       = 42   # None for non-reproducible
PALETTE = [TEAL, WHITE, YELLOW, CORAL, LIGHT_BLUE, MEDIUM_BLUE,
           NAVY_BLUE, PBS_BLUE]

# ---------------------------------------------------------------------------

_FONT_CANDIDATES = [
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/Monaco.ttf",
    "/System/Library/Fonts/Courier.ttc",
    "/System/Library/Fonts/Supplemental/Courier New.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]


def load_label_font(size: int):
    for path in _FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def render_bars(top_bars: list[str], mid_bars: list[str]) -> Image.Image:
    img = Image.new("RGB", (WIDTH, HEIGHT), "black")
    draw = ImageDraw.Draw(img)

    top_h = int(HEIGHT * 2 / 3)
    mid_h = int(HEIGHT / 12)
    bar_w = WIDTH / 7

    for i, color in enumerate(top_bars):
        draw.rectangle([int(i * bar_w), 0, int((i + 1) * bar_w), top_h], fill=color)

    for i, color in enumerate(mid_bars):
        draw.rectangle(
            [int(i * bar_w), top_h, int((i + 1) * bar_w), top_h + mid_h],
            fill=color,
        )

    draw.rectangle([0, top_h + mid_h, WIDTH, HEIGHT], fill=BOTTOM_COLOR)
    return img


def draw_label_on(img: Image.Image, text: str) -> None:
    draw = ImageDraw.Draw(img)
    font = load_label_font(int(HEIGHT * LABEL_FONT_FRACTION))
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    pad = int(HEIGHT / 60)
    top_h = int(HEIGHT * 2 / 3)
    mid_h = int(HEIGHT / 12)
    bottom_h = HEIGHT - top_h - mid_h
    cx = WIDTH // 2
    cy = top_h + mid_h + bottom_h // 2
    draw.rectangle(
        [cx - tw // 2 - pad, cy - th // 2 - pad,
         cx + tw // 2 + pad, cy + th // 2 + pad],
        fill="black",
    )
    draw.text((cx - tw // 2, cy - th // 2 - bbox[1]),
              text, fill="white", font=font)


def format_timecode(frame: int, fps_int: int, drop_frame: bool = False) -> str:
    """Format a frame index as SMPTE timecode.

    Non-drop counts every frame `:00..:fps_int-1` and drifts vs wall clock at
    fractional rates. Drop-frame (SMPTE 12M) skips frame *numbers* :00 and
    :01 at the start of every minute except those divisible by 10, so the
    count stays in sync with wall-clock time. Drop is only defined at
    29.97 (drop 2 numbers/minute) and 59.94 (drop 4 numbers/minute).
    """
    if drop_frame:
        if fps_int == 30:
            drop = 2
        elif fps_int == 60:
            drop = 4
        else:
            raise ValueError(
                f"drop-frame timecode is not defined for fps_int={fps_int}"
            )
        frames_per_min    = fps_int * 60 - drop
        frames_per_10_min = fps_int * 600 - drop * 9

        d = frame // frames_per_10_min
        m = frame %  frames_per_10_min
        if m > drop:
            n = frame + drop * 9 * d + drop * ((m - drop) // frames_per_min)
        else:
            n = frame + drop * 9 * d

        f = n %  fps_int
        s = (n // fps_int) % 60
        mm = (n // (fps_int * 60)) % 60
        h = n // (fps_int * 3600)
        return f"{h:02d}:{mm:02d}:{s:02d};{f:02d}"

    seconds = frame // fps_int
    frames = frame % fps_int
    return (f"{seconds // 3600:02d}:"
            f"{(seconds // 60) % 60:02d}:"
            f"{seconds % 60:02d}:"
            f"{frames:02d}")


def write_vtt(path: Path, duration_seconds: int) -> None:
    """Emit per-second cues like HH:MM:SS, positioned near the top."""
    def fmt(s: int) -> str:
        return f"{s // 3600:02d}:{(s // 60) % 60:02d}:{s % 60:02d}.000"

    lines = ["WEBVTT", ""]
    for s in range(duration_seconds):
        lines.append(f"{fmt(s)} --> {fmt(s + 1)} line:10% align:center")
        lines.append(f"{s // 3600:02d}:{(s // 60) % 60:02d}:{s % 60:02d}")
        lines.append("")
    path.write_text("\n".join(lines))


def apply_swap(
    top: list[str], mid: list[str],
    prev_top: list[str | None], prev_mid: list[str | None],
    rng: random.Random,
) -> tuple[list[str], list[str], list[str | None], list[str | None]]:
    choices: list[tuple[str, int, str]] = []

    top_used = set(top)
    top_candidates = [c for c in PALETTE if c not in top_used]
    for pos, current in enumerate(top):
        for color in top_candidates:
            if color == current or color == mid[pos] or color == prev_top[pos]:
                continue
            choices.append(("top", pos, color))

    mid_used = set(mid)
    mid_candidates = [c for c in PALETTE
                      if c not in mid_used and c != PBS_BLUE]
    for pos, current in enumerate(mid):
        if current == NAVY_BLUE:
            continue
        for color in mid_candidates:
            if color == current or color == top[pos] or color == prev_mid[pos]:
                continue
            choices.append(("mid", pos, color))

    if not choices:
        return top, mid, prev_top, prev_mid

    row, pos, color = rng.choice(choices)
    new_top = list(top)
    new_mid = list(mid)
    new_prev_top = list(prev_top)
    new_prev_mid = list(prev_mid)
    if row == "top":
        new_prev_top[pos] = top[pos]
        new_top[pos] = color
    else:
        new_prev_mid[pos] = mid[pos]
        new_mid[pos] = color
    return new_top, new_mid, new_prev_top, new_prev_mid


def encode_video(frames_iter, total_frames: int) -> None:
    audio_duration = total_frames * FPS_DEN / FPS_NUM
    fps_str = f"{FPS_NUM}/{FPS_DEN}"

    cmd = [
        "ffmpeg", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{WIDTH}x{HEIGHT}",
        "-r", fps_str,
        "-i", "-",
    ]

    if ENABLE_AUDIO and NOISE_AMPLITUDE > 0:
        cmd += [
            "-f", "lavfi", "-t", f"{audio_duration:.6f}",
            "-i", (f"anoisesrc=color={NOISE_COLOR}"
                   f":sample_rate=48000:amplitude={NOISE_AMPLITUDE}"),
        ]
        steps: list[str] = []
        if LOWPASS_HZ > 0:
            steps.append(f"lowpass=f={LOWPASS_HZ}")
        if SWELL_HZ > 0 and SWELL_DEPTH > 0:
            steps.append(f"tremolo=f={SWELL_HZ}:d={SWELL_DEPTH}")
        if TARGET_LUFS is not None:
            steps.append(
                f"loudnorm=I={TARGET_LUFS}"
                f":LRA={LOUDNESS_RANGE}"
                f":TP={TRUE_PEAK_DB}"
            )
        chain = "[1:a]" + (",".join(steps) if steps else "anull") + "[aout]"
        cmd += [
            "-filter_complex", chain,
            "-map", "0:v", "-map", "[aout]",
            "-c:a", "aac", "-b:a", "192k",
        ]

    cmd += [
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-r", fps_str,
        str(OUTPUT),
    ]

    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    try:
        for img in frames_iter:
            proc.stdin.write(img.tobytes())
    finally:
        if proc.stdin:
            proc.stdin.close()
    proc.wait()
    if proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, cmd)


def main() -> int:
    if not shutil.which("ffmpeg"):
        print("error: ffmpeg not found in PATH", file=sys.stderr)
        return 1

    rng = random.Random(RANDOM_SEED)
    fps_int = -(-FPS_NUM // FPS_DEN)   # ceil — frames-per-timecode-second
    total_frames = max(1, round(DURATION * FPS_NUM / FPS_DEN))

    state = {
        "top": list(TOP_BARS),
        "mid": list(MID_BARS),
        "prev_top": [None] * len(TOP_BARS),
        "prev_mid": [None] * len(MID_BARS),
        "bars_img": render_bars(TOP_BARS, MID_BARS),
    }

    def frames():
        for f in range(total_frames):
            if f > 0 and SWAP_EVERY_SECOND and f % fps_int == 0:
                state["top"], state["mid"], state["prev_top"], state["prev_mid"] = \
                    apply_swap(state["top"], state["mid"],
                               state["prev_top"], state["prev_mid"], rng)
                state["bars_img"] = render_bars(state["top"], state["mid"])

            if LABEL is None:
                out_img = state["bars_img"]
            else:
                text = (format_timecode(f, fps_int, TIMECODE_DROP_FRAME)
                        if LABEL == "timecode" else LABEL)
                out_img = state["bars_img"].copy()
                draw_label_on(out_img, text)

            if f == 0 and SAVE_PNG:
                out_img.save(SAVE_PNG)
            yield out_img

    encode_video(frames(), total_frames)
    print(f"wrote {OUTPUT}")

    if WRITE_VTT:
        vtt_path = OUTPUT.with_suffix(".vtt")
        write_vtt(vtt_path, max(1, int(DURATION)))
        print(f"wrote {vtt_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
