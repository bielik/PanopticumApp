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
    elif effect_name == "insta":
        return _insta(frame)
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


def _insta(frame: np.ndarray) -> np.ndarray:
    """Sepia tones with warmth and brightness (Instagram-vintage style)."""
    # Classic sepia transformation matrix (BGR input → BGR output)
    sepia_kernel = np.array([
        [0.131, 0.534, 0.272],  # B out
        [0.168, 0.686, 0.349],  # G out
        [0.189, 0.769, 0.393],  # R out
    ], dtype=np.float32)

    sepia = cv2.transform(frame, sepia_kernel)
    sepia = np.clip(sepia, 0, 255).astype(np.uint8)

    # Slight brightness and contrast boost for a lively feel
    result = cv2.convertScaleAbs(sepia, alpha=1.1, beta=12)

    return result
