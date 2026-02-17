"""
effects.py — Display-only video effects for the camera feed.

Effects are applied to the display frame only. The analysis thread
always receives the raw, unprocessed frame.
"""

import cv2
import numpy as np


def apply_effect(frame: np.ndarray, effect_name: str) -> np.ndarray:
    """Apply a named visual effect to a frame. Returns a new array."""
    if effect_name == "cctv":
        return _cctv(frame)
    elif effect_name == "bright":
        return _bright(frame)
    else:
        # "natural" or any unknown → passthrough
        return frame


def _cctv(frame: np.ndarray) -> np.ndarray:
    """Grayscale + pixelation + noise + scanlines."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape

    # Pixelation: downscale then upscale
    small = cv2.resize(gray, (w // 4, h // 4), interpolation=cv2.INTER_LINEAR)
    pixelated = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)

    # Add noise
    noise = np.random.randint(0, 25, (h, w), dtype=np.uint8)
    noisy = cv2.add(pixelated, noise)

    # Scanlines: darken every other row
    noisy[::2, :] = (noisy[::2, :] * 0.7).astype(np.uint8)

    return cv2.cvtColor(noisy, cv2.COLOR_GRAY2BGR)


def _bright(frame: np.ndarray) -> np.ndarray:
    """Warm tones, increased brightness and saturation."""
    # Convert to HSV for saturation/brightness boost
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV).astype(np.float32)

    # Boost saturation by 30%
    hsv[:, :, 1] = np.clip(hsv[:, :, 1] * 1.3, 0, 255)
    # Boost brightness by 20%
    hsv[:, :, 2] = np.clip(hsv[:, :, 2] * 1.2 + 15, 0, 255)

    result = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)

    # Warm color grade: boost yellow/orange tones
    # Slightly increase red and green channels, reduce blue
    b, g, r = cv2.split(result)
    r = np.clip(r.astype(np.float32) * 1.08 + 8, 0, 255).astype(np.uint8)
    g = np.clip(g.astype(np.float32) * 1.04 + 4, 0, 255).astype(np.uint8)
    b = np.clip(b.astype(np.float32) * 0.92, 0, 255).astype(np.uint8)

    return cv2.merge([b, g, r])
