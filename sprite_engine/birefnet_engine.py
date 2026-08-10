"""Local BiRefNet inference and image compositing."""

from __future__ import annotations

import gc
import os
import threading
import time
from contextlib import nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np
import torch
from PIL import Image, ImageColor, ImageOps
from torchvision import transforms
from transformers import AutoModelForImageSegmentation

from official_refinement import refine_foreground
from webp_converter import save_as_webp, validate_webp_quality


MODEL_PRESETS = {
    "정밀 · 다양한 사진 (권장)": {
        "repo": "ZhengPeng7/BiRefNet_dynamic",
        "revision": "280306042f57b7a33854319da62fd86aaa89ec4c",
        "size": 1536,
        "dynamic": True,
        "note": "비율을 유지해 처리해요. 상품, 동물, 사물 등 대부분의 사진에 권장합니다.",
    },
    "빠르게 · 일반 사진": {
        "repo": "ZhengPeng7/BiRefNet_lite",
        "revision": "7838f1c3472f827cd8ce13ab5ccc2ce48077360f",
        "size": 1024,
        "dynamic": False,
        "note": "가벼운 모델로 먼저 결과를 확인할 때 적합해요.",
    },
    "인물 · 머리카락": {
        "repo": "ZhengPeng7/BiRefNet-portrait",
        "revision": "ecdeb6240ef23557dbd48ff27c59c1a88cbcb755",
        "size": 1024,
        "dynamic": False,
        "note": "사람과 머리카락 경계에 맞춰 학습된 모델이에요.",
    },
    "고해상도 · 섬세한 경계": {
        "repo": "ZhengPeng7/BiRefNet_HR-matting",
        "revision": "5d6b6f8adcb5b417c871b1d84ceaae9871355b7f",
        "size": 2048,
        "dynamic": False,
        "note": "큰 이미지와 반투명한 경계에 유리하지만 메모리와 시간이 더 필요해요.",
    },
}

BACKGROUND_PRESETS = {
    "투명": None,
    "투명 (PNG)": None,
    "흰색": "#FFFFFF",
    "검정": "#111318",
    "직접 선택": "custom",
}

MAX_PIXELS = 80_000_000
MAX_FILE_BYTES = 80 * 1024 * 1024


@dataclass(frozen=True)
class ProcessingResult:
    output_path: str
    mask_path: str
    original_size: tuple[int, int]
    input_bytes: int
    output_bytes: int
    output_format: str
    webp_quality: int | None
    model_name: str
    device_name: str
    elapsed_seconds: float


@dataclass(frozen=True)
class BatchProcessingResult:
    output_paths: tuple[str, ...]
    original_size: tuple[int, int]
    model_name: str
    device_name: str
    elapsed_seconds: float


class BiRefNetEngine:
    """Load one official BiRefNet model at a time and reuse it."""

    def __init__(self, output_dir: Path) -> None:
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self._model = None
        self._model_repo: str | None = None
        self._device = self._pick_device()
        self._lock = threading.Lock()

    @staticmethod
    def _pick_device() -> torch.device:
        forced = os.getenv("BIREFNET_DEVICE", "").strip().lower()
        if forced:
            if forced == "mps" and not torch.backends.mps.is_available():
                raise RuntimeError("BIREFNET_DEVICE=mps로 설정했지만 MPS를 사용할 수 없습니다.")
            if forced == "cuda" and not torch.cuda.is_available():
                raise RuntimeError("BIREFNET_DEVICE=cuda로 설정했지만 CUDA를 사용할 수 없습니다.")
            return torch.device(forced)
        if torch.cuda.is_available():
            return torch.device("cuda")
        if torch.backends.mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")

    @property
    def device_label(self) -> str:
        return {
            "cuda": "NVIDIA GPU",
            "mps": "Apple Silicon GPU",
            "cpu": "CPU",
        }.get(self._device.type, self._device.type.upper())

    def _release_model(self) -> None:
        self._model = None
        self._model_repo = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()

    def _load_model(self, repo: str, revision: str):
        if self._model is not None and self._model_repo == repo:
            return self._model

        self._release_model()
        try:
            model = AutoModelForImageSegmentation.from_pretrained(
                repo,
                revision=revision,
                trust_remote_code=True,
            )
            model.to(self._device)
            model.eval()
        except Exception:
            self._release_model()
            raise

        self._model = model
        self._model_repo = repo
        return model

    @staticmethod
    def _safe_stem(image_path: str) -> str:
        stem = Path(image_path).stem
        safe = "".join(char if char.isalnum() or char in "-_" else "-" for char in stem)
        return safe.strip("-_")[:64] or "image"

    @staticmethod
    def _validate_image(image_path: str) -> Image.Image:
        path = Path(image_path)
        if not path.is_file():
            raise ValueError("이미지 파일을 찾을 수 없습니다. 다시 올려 주세요.")
        if path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError("파일이 너무 큽니다. 80MB 이하 이미지를 사용해 주세요.")

        Image.MAX_IMAGE_PIXELS = MAX_PIXELS
        try:
            with Image.open(path) as opened:
                opened.verify()
            with Image.open(path) as opened:
                image = ImageOps.exif_transpose(opened).convert("RGB")
        except Exception as error:
            raise ValueError("지원되는 이미지 파일이 아닙니다. JPG, PNG 또는 WEBP를 사용해 주세요.") from error

        if image.width * image.height > MAX_PIXELS:
            raise ValueError("이미지 해상도가 너무 큽니다. 8,000만 픽셀 이하 이미지를 사용해 주세요.")
        return image

    @staticmethod
    def _dynamic_size(image: Image.Image, max_edge: int) -> tuple[int, int]:
        ratio = min(max_edge / max(image.size), 1.0)
        width = max(32, int(round(image.width * ratio / 32)) * 32)
        height = max(32, int(round(image.height * ratio / 32)) * 32)
        return width, height

    def _predict_mask(
        self,
        image: Image.Image,
        model,
        preset: dict,
    ) -> Image.Image:
        if preset["dynamic"]:
            target_size = self._dynamic_size(image, preset["size"])
        else:
            target_size = (preset["size"], preset["size"])

        transform = transforms.Compose(
            [
                transforms.Resize(
                    (target_size[1], target_size[0]),
                    interpolation=transforms.InterpolationMode.BILINEAR,
                    antialias=True,
                ),
                transforms.ToTensor(),
                transforms.Normalize(
                    [0.485, 0.456, 0.406],
                    [0.229, 0.224, 0.225],
                ),
            ]
        )
        tensor = transform(image).unsqueeze(0).to(self._device)

        use_half = self._device.type == "cuda"
        autocast_context = (
            torch.autocast(device_type="cuda", dtype=torch.float16)
            if use_half
            else nullcontext()
        )
        with torch.inference_mode(), autocast_context:
            prediction = model(tensor)[-1].sigmoid().to(torch.float32).cpu()

        mask_array = prediction[0].squeeze().clamp(0, 1).numpy()
        mask = Image.fromarray((mask_array * 255).astype(np.uint8), mode="L")
        return mask.resize(image.size, Image.Resampling.LANCZOS)

    @staticmethod
    def _compose(
        image: Image.Image,
        mask: Image.Image,
        background_mode: str,
        custom_color: str,
        refine_edges: bool,
    ) -> Image.Image:
        foreground = refine_foreground(image, mask) if refine_edges else image
        rgba = foreground.convert("RGBA")
        rgba.putalpha(mask)

        selected = BACKGROUND_PRESETS.get(background_mode)
        if selected is None:
            return rgba

        color = custom_color if selected == "custom" else selected
        try:
            rgb = ImageColor.getrgb(color or "#FFFFFF")
        except ValueError as error:
            raise ValueError("배경색을 확인해 주세요.") from error
        background = Image.new("RGBA", rgba.size, (*rgb, 255))
        return Image.alpha_composite(background, rgba).convert("RGB")

    def process(
        self,
        image_path: str,
        model_name: str,
        background_mode: str,
        custom_color: str,
        refine_edges: bool,
        output_format: str = "PNG",
        webp_quality: int | float = 80,
        progress: Callable[[float, str], None] | None = None,
    ) -> ProcessingResult:
        if not image_path:
            raise ValueError("먼저 이미지를 올려 주세요.")
        if model_name not in MODEL_PRESETS:
            raise ValueError("모델 선택을 확인해 주세요.")
        if background_mode not in BACKGROUND_PRESETS:
            raise ValueError("배경 선택을 확인해 주세요.")
        if output_format not in {"PNG", "WebP"}:
            raise ValueError("결과 파일 형식을 확인해 주세요.")
        normalized_quality = (
            validate_webp_quality(webp_quality) if output_format == "WebP" else None
        )

        notify = progress or (lambda _value, _description: None)
        started = time.perf_counter()

        with self._lock:
            notify(0.04, "이미지를 확인하고 있어요")
            image = self._validate_image(image_path)
            preset = MODEL_PRESETS[model_name]

            notify(0.12, "BiRefNet 모델을 준비하고 있어요 · 첫 실행은 다운로드가 필요해요")
            model = self._load_model(preset["repo"], preset["revision"])

            notify(0.30, "피사체와 배경을 나누고 있어요")
            mask = self._predict_mask(image, model, preset)

            notify(0.82, "가장자리와 투명도를 정리하고 있어요")
            output = self._compose(
                image,
                mask,
                background_mode,
                custom_color,
                refine_edges,
            )

            stamp = time.strftime("%Y%m%d-%H%M%S")
            stem = self._safe_stem(image_path)
            suffix = "webp" if output_format == "WebP" else "png"
            output_path = self.output_dir / f"{stem}-cutout-{stamp}.{suffix}"
            mask_path = self.output_dir / f"{stem}-mask-{stamp}.png"
            if output_format == "WebP":
                save_as_webp(output, output_path, normalized_quality or 80)
            else:
                output.save(output_path, format="PNG", optimize=True)
            mask.save(mask_path, format="PNG", optimize=True)

            notify(1.0, "완료했어요")
            return ProcessingResult(
                output_path=str(output_path),
                mask_path=str(mask_path),
                original_size=image.size,
                input_bytes=Path(image_path).stat().st_size,
                output_bytes=output_path.stat().st_size,
                output_format=output_format,
                webp_quality=normalized_quality,
                model_name=model_name,
                device_name=self.device_label,
                elapsed_seconds=time.perf_counter() - started,
            )

    def process_batch_to_png(
        self,
        image_paths: list[str] | tuple[str, ...],
        output_dir: Path,
        model_name: str,
        refine_edges: bool,
        progress: Callable[[float, str], None] | None = None,
    ) -> BatchProcessingResult:
        """Remove backgrounds from ordered frames while loading the model once."""

        if not image_paths:
            raise ValueError("배경을 제거할 프레임이 없습니다.")
        if model_name not in MODEL_PRESETS:
            raise ValueError("모델 선택을 확인해 주세요.")

        notify = progress or (lambda _value, _description: None)
        started = time.perf_counter()
        target_dir = Path(output_dir)
        target_dir.mkdir(parents=True, exist_ok=True)
        output_paths: list[str] = []
        original_size: tuple[int, int] | None = None

        with self._lock:
            preset = MODEL_PRESETS[model_name]
            notify(0.02, "BiRefNet 모델을 준비하고 있어요")
            model = self._load_model(preset["repo"], preset["revision"])

            total = len(image_paths)
            for index, image_path in enumerate(image_paths, start=1):
                notify(
                    0.08 + ((index - 1) / total) * 0.88,
                    f"프레임 {index}/{total}의 배경을 지우고 있어요",
                )
                image = self._validate_image(image_path)
                if original_size is None:
                    original_size = image.size
                elif image.size != original_size:
                    raise ValueError("모든 프레임의 가로·세로 크기가 같아야 합니다.")

                mask = self._predict_mask(image, model, preset)
                output = self._compose(
                    image,
                    mask,
                    background_mode="투명",
                    custom_color="#FFFFFF",
                    refine_edges=refine_edges,
                )
                output_path = target_dir / f"frame-{index:04d}.png"
                output.save(output_path, format="PNG", optimize=True)
                output_paths.append(str(output_path))

        notify(1.0, "모든 프레임의 배경을 제거했어요")
        return BatchProcessingResult(
            output_paths=tuple(output_paths),
            original_size=original_size or (0, 0),
            model_name=model_name,
            device_name=self.device_label,
            elapsed_seconds=time.perf_counter() - started,
        )
