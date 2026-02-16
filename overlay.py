"""
overlay.py — Surveillance-style visual overlay for the camera feed.

Draws timestamp, REC indicator, camera label, and AI description text
with fade-in/fade-out on the live video frame.
"""

import time
import textwrap
from datetime import datetime

import cv2
import numpy as np


# OpenCV font
FONT = cv2.FONT_HERSHEY_SIMPLEX
FONT_THIN = cv2.FONT_HERSHEY_PLAIN


def draw_overlay(frame, state, config):
    """Draw the full surveillance overlay on a frame. Returns a new image."""
    display = frame.copy()
    h, w = display.shape[:2]
    ov = config["overlay"]
    color = tuple(ov["color"])  # BGR

    # --- Top bar: timestamp + REC + camera label ---
    if ov["show_timestamp"]:
        timestamp = datetime.now().strftime("%Y-%m-%d  %H:%M:%S")
        _put_text(display, timestamp, (10, 30), FONT, 0.6, color, 1)

    if ov["show_recording_dot"]:
        # Blink every 0.5 seconds
        if int(time.time() * 2) % 2 == 0:
            cv2.circle(display, (w - 70, 25), 7, (0, 0, 255), -1)
        _put_text(display, "REC", (w - 55, 32), FONT, 0.55, (0, 0, 255), 1)

    _put_text(display, "CAM-01", (w - 100, h - 15), FONT_THIN, 1.0, color, 1)

    # --- Description overlay with fade ---
    with state.lock:
        desc = state.latest_description
        desc_time = state.description_timestamp

    if desc:
        elapsed = time.time() - desc_time
        alpha = _calculate_alpha(elapsed, config["timing"])
        if alpha > 0.0:
            _draw_description_box(display, desc, alpha, ov, h, w)

    # --- Speaking indicator ---
    with state.lock:
        speaking = state.is_speaking
    if speaking:
        _put_text(display, "[AUDIO]", (10, h - 15), FONT_THIN, 1.0, (0, 200, 255), 1)

    return display


def _calculate_alpha(elapsed, timing_cfg):
    """Calculate text opacity based on elapsed time since description arrived."""
    fade_in = timing_cfg["fade_in"]
    fade_out = timing_cfg["fade_out"]
    duration = timing_cfg["overlay_duration"]

    if elapsed < fade_in:
        return elapsed / fade_in
    elif elapsed < duration - fade_out:
        return 1.0
    elif elapsed < duration:
        return (duration - elapsed) / fade_out
    else:
        return 0.0


def _draw_description_box(display, text, alpha, overlay_cfg, h, w):
    """Draw a semi-transparent box with the description text."""
    color = tuple(overlay_cfg["color"])
    bg_opacity = overlay_cfg["background_opacity"] * alpha
    font_scale = overlay_cfg["font_scale"]

    # Wrap text to fit the frame width
    max_chars = max(30, int(w / (font_scale * 18)))
    lines = textwrap.wrap(text, width=max_chars)
    if not lines:
        return

    line_height = int(30 * font_scale) + 5
    padding = 12
    box_height = len(lines) * line_height + padding * 2

    # Position
    pos = overlay_cfg["position"]
    if pos == "top":
        y_start = 50
    elif pos == "center":
        y_start = (h - box_height) // 2
    else:  # bottom
        y_start = h - box_height - 40

    # Draw semi-transparent background
    overlay_img = display.copy()
    cv2.rectangle(
        overlay_img,
        (10, y_start),
        (w - 10, y_start + box_height),
        (0, 0, 0),
        -1,
    )
    cv2.addWeighted(overlay_img, bg_opacity, display, 1 - bg_opacity, 0, display)

    # Draw text lines with alpha
    text_alpha = max(0.0, min(1.0, alpha))
    faded_color = tuple(int(c * text_alpha) for c in color)

    for i, line in enumerate(lines):
        y = y_start + padding + (i + 1) * line_height
        _put_text(display, line, (20, y), FONT, font_scale, faded_color, 1)


def _put_text(img, text, org, font, scale, color, thickness):
    """Draw text with a dark shadow for readability."""
    # Shadow
    cv2.putText(img, text, (org[0] + 1, org[1] + 1), font, scale, (0, 0, 0), thickness + 1, cv2.LINE_AA)
    # Main text
    cv2.putText(img, text, org, font, scale, color, thickness, cv2.LINE_AA)


def create_no_signal_frame(width, height):
    """Generate a 'NO SIGNAL' static noise frame."""
    noise = np.random.randint(0, 60, (height, width, 3), dtype=np.uint8)
    text = "NO SIGNAL"
    text_size = cv2.getTextSize(text, FONT, 1.5, 2)[0]
    x = (width - text_size[0]) // 2
    y = (height + text_size[1]) // 2
    _put_text(noise, text, (x, y), FONT, 1.5, (0, 0, 200), 2)
    return noise
