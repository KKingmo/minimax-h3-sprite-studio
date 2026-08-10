"""Foreground refinement adapted from ZhengPeng7/BiRefNet.

Source:
https://github.com/ZhengPeng7/BiRefNet/blob/main/image_proc.py

The original project is MIT licensed. See THIRD_PARTY_NOTICES.md.
Only the CPU refinement path needed by this GUI is included here.
"""

from __future__ import annotations

import cv2
import numpy as np
from PIL import Image


def _blur_fusion(
    image: np.ndarray,
    foreground: np.ndarray,
    background: np.ndarray,
    alpha: np.ndarray,
    radius: int,
) -> tuple[np.ndarray, np.ndarray]:
    blurred_alpha = cv2.blur(alpha, (radius, radius))[:, :, None]

    blurred_foreground_alpha = cv2.blur(foreground * alpha, (radius, radius))
    blurred_foreground = blurred_foreground_alpha / (blurred_alpha + 1e-5)

    blurred_background_alpha = cv2.blur(background * (1 - alpha), (radius, radius))
    blurred_background = blurred_background_alpha / ((1 - blurred_alpha) + 1e-5)

    estimated_foreground = blurred_foreground + alpha * (
        image
        - alpha * blurred_foreground
        - (1 - alpha) * blurred_background
    )
    return np.clip(estimated_foreground, 0, 1), blurred_background


def refine_foreground(
    image: Image.Image,
    mask: Image.Image,
    radius: int = 90,
) -> Image.Image:
    """Reduce background color spill around a soft alpha edge."""

    if mask.size != image.size:
        mask = mask.resize(image.size, Image.Resampling.LANCZOS)

    image_array = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
    alpha = np.asarray(mask.convert("L"), dtype=np.float32) / 255.0
    alpha = alpha[:, :, None]

    foreground, blurred_background = _blur_fusion(
        image_array,
        image_array,
        image_array,
        alpha,
        radius,
    )
    foreground, _ = _blur_fusion(
        image_array,
        foreground,
        blurred_background,
        alpha,
        6,
    )
    result = (foreground * 255.0).astype(np.uint8)
    return Image.fromarray(np.ascontiguousarray(result), mode="RGB")
