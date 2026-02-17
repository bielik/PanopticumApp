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
    elif effect_name == "nightvision":
        return _nightvision(frame)
    elif effect_name == "noir":
        return _noir(frame)
    else:
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


def _nightvision(frame: np.ndarray) -> np.ndarray:
    """Green-channel boost, zero red/blue, noise."""
    h, w = frame.shape[:2]
    result = frame.copy()

    # Zero red and blue, boost green
    result[:, :, 0] = 0   # Blue
    result[:, :, 2] = 0   # Red
    result[:, :, 1] = cv2.add(
        result[:, :, 1],
        np.full((h, w), 40, dtype=np.uint8),
    )

    # Add green-tinted noise
    noise = np.zeros((h, w, 3), dtype=np.uint8)
    noise[:, :, 1] = np.random.randint(0, 20, (h, w), dtype=np.uint8)
    result = cv2.add(result, noise)

    return result


def _noir(frame: np.ndarray) -> np.ndarray:
    """High-contrast grayscale + vignette + grain."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape

    # CLAHE for high contrast
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    contrast = clahe.apply(gray)

    # Vignette: Gaussian kernel mask
    sigma_x = w / 3
    sigma_y = h / 3
    kernel_x = cv2.getGaussianKernel(w, int(sigma_x))
    kernel_y = cv2.getGaussianKernel(h, int(sigma_y))
    vignette_mask = (kernel_y @ kernel_x.T)
    vignette_mask = vignette_mask / vignette_mask.max()
    vignetted = (contrast * vignette_mask).astype(np.uint8)

    # Film grain
    grain = np.random.randint(-15, 15, (h, w), dtype=np.int16)
    result = np.clip(vignetted.astype(np.int16) + grain, 0, 255).astype(np.uint8)

    return cv2.cvtColor(result, cv2.COLOR_GRAY2BGR)
