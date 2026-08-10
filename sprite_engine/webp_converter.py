"""PNG-to-WebP conversion helpers shared by the GUI and cutout engine."""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError


MAX_PIXELS = 80_000_000
MAX_FILE_BYTES = 80 * 1024 * 1024
MIN_WEBP_QUALITY = 20
MAX_WEBP_QUALITY = 95


@dataclass(frozen=True)
class WebPConversionResult:
    output_path: str
    original_size: tuple[int, int]
    original_bytes: int
    output_bytes: int
    quality: int

    @property
    def reduction_percent(self) -> float:
        if self.original_bytes == 0:
            return 0.0
        return (1 - self.output_bytes / self.original_bytes) * 100


def validate_webp_quality(quality: int | float) -> int:
    normalized = int(round(quality))
    if not MIN_WEBP_QUALITY <= normalized <= MAX_WEBP_QUALITY:
        raise ValueError(
            f"WebP 품질은 {MIN_WEBP_QUALITY}~{MAX_WEBP_QUALITY} 사이로 설정해 주세요."
        )
    return normalized


def prepare_for_webp(image: Image.Image) -> Image.Image:
    """Return an RGB/RGBA image while retaining transparency when present."""
    if image.mode in {"RGBA", "LA"} or (
        image.mode == "P" and "transparency" in image.info
    ):
        return image.convert("RGBA")
    return image.convert("RGB")


def save_as_webp(image: Image.Image, output_path: Path, quality: int | float) -> None:
    normalized_quality = validate_webp_quality(quality)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    prepare_for_webp(image).save(
        output_path,
        format="WEBP",
        quality=normalized_quality,
        method=6,
    )


def _safe_stem(image_path: str) -> str:
    stem = Path(image_path).stem
    safe = "".join(char if char.isalnum() or char in "-_" else "-" for char in stem)
    return safe.strip("-_")[:64] or "image"


def _load_png(image_path: str) -> Image.Image:
    path = Path(image_path)
    if not path.is_file():
        raise ValueError("PNG 파일을 찾을 수 없습니다. 다시 올려 주세요.")
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("파일이 너무 큽니다. 80MB 이하 PNG를 사용해 주세요.")

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with Image.open(path) as opened:
            if opened.format != "PNG":
                raise ValueError("PNG 파일만 WebP로 변환할 수 있어요.")
            if getattr(opened, "is_animated", False):
                raise ValueError("움직이는 PNG는 아직 지원하지 않아요. 정지 PNG를 사용해 주세요.")
            opened.verify()

        with Image.open(path) as opened:
            image = ImageOps.exif_transpose(opened)
            image.load()
    except ValueError:
        raise
    except (UnidentifiedImageError, OSError) as error:
        raise ValueError("올바른 PNG 파일이 아닙니다. 다른 파일을 올려 주세요.") from error

    if image.width * image.height > MAX_PIXELS:
        raise ValueError("이미지 해상도가 너무 큽니다. 8,000만 픽셀 이하 PNG를 사용해 주세요.")
    return image


def convert_png_to_webp(
    image_path: str,
    output_dir: Path,
    quality: int | float,
) -> WebPConversionResult:
    if not image_path:
        raise ValueError("먼저 PNG를 올려 주세요.")

    normalized_quality = validate_webp_quality(quality)
    image = _load_png(image_path)
    source_path = Path(image_path)
    stamp = f"{time.strftime('%Y%m%d-%H%M%S')}-{time.time_ns() % 1_000_000:06d}"
    output_path = output_dir / f"{_safe_stem(image_path)}-q{normalized_quality}-{stamp}.webp"
    save_as_webp(image, output_path, normalized_quality)

    return WebPConversionResult(
        output_path=str(output_path),
        original_size=image.size,
        original_bytes=source_path.stat().st_size,
        output_bytes=output_path.stat().st_size,
        quality=normalized_quality,
    )
