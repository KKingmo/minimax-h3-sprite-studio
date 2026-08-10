"""Video frame extraction and sprite-animation export helpers."""

from __future__ import annotations

import json
import math
import time
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError


MIN_FPS = 1.0
MAX_FPS = 30.0
MIN_FRAMES = 2
MAX_FRAMES = 240
MAX_VIDEO_BYTES = 1024 * 1024 * 1024
MAX_ATLAS_EDGE = 16_384
MAX_ATLAS_PIXELS = 100_000_000
PREVIEW_MAX_EDGE = 480
WEBP_ENCODING_METHOD = 4


ProgressCallback = Callable[[float, str], None]


@dataclass(frozen=True)
class VideoInfo:
    width: int
    height: int
    fps: float
    frame_count: int
    duration_seconds: float
    file_bytes: int


@dataclass(frozen=True)
class ExportResult:
    sprite_png_path: str
    sprite_webp_path: str
    animated_webp_path: str
    gif_path: str
    manifest_path: str
    package_path: str
    output_files: tuple[str, ...]
    frame_size: tuple[int, int]
    atlas_size: tuple[int, int]
    columns: int
    rows: int
    frame_duration_ms: int
    file_sizes: dict[str, int]


def _notify(progress: ProgressCallback | None, value: float, description: str) -> None:
    if progress is not None:
        progress(value, description)


def format_bytes(byte_count: int) -> str:
    if byte_count >= 1024 * 1024 * 1024:
        return f"{byte_count / (1024 * 1024 * 1024):.2f} GB"
    if byte_count >= 1024 * 1024:
        return f"{byte_count / (1024 * 1024):.1f} MB"
    if byte_count >= 1024:
        return f"{byte_count / 1024:.0f} KB"
    return f"{byte_count} B"


def safe_stem(path: str | Path) -> str:
    stem = Path(path).stem
    safe = "".join(char if char.isalnum() or char in "-_" else "-" for char in stem)
    return safe.strip("-_")[:64] or "video"


def _validate_video_path(video_path: str | Path) -> Path:
    path = Path(video_path)
    if not path.is_file():
        raise ValueError("영상 파일을 찾을 수 없습니다. 다시 올려 주세요.")
    if path.stat().st_size > MAX_VIDEO_BYTES:
        raise ValueError("영상은 1GB 이하 파일만 사용할 수 있습니다.")
    return path


def probe_video(video_path: str | Path) -> VideoInfo:
    path = _validate_video_path(video_path)
    capture = cv2.VideoCapture(str(path))
    try:
        if not capture.isOpened():
            raise ValueError("영상을 열 수 없습니다. MP4, MOV 또는 WebM 파일을 사용해 주세요.")

        fps = float(capture.get(cv2.CAP_PROP_FPS))
        frame_count = max(0, int(round(capture.get(cv2.CAP_PROP_FRAME_COUNT))))
        width = max(0, int(round(capture.get(cv2.CAP_PROP_FRAME_WIDTH))))
        height = max(0, int(round(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))))
        if not math.isfinite(fps) or fps <= 0:
            raise ValueError("영상의 FPS 정보를 읽을 수 없습니다.")
        duration = frame_count / fps if frame_count > 0 else 0.0
        return VideoInfo(
            width=width,
            height=height,
            fps=fps,
            frame_count=frame_count,
            duration_seconds=duration,
            file_bytes=path.stat().st_size,
        )
    finally:
        capture.release()


def extract_frames(
    video_path: str | Path,
    output_root: Path,
    target_fps: int | float,
    max_frames: int | float,
    progress: ProgressCallback | None = None,
) -> dict:
    path = _validate_video_path(video_path)
    normalized_fps = float(target_fps)
    normalized_max_frames = int(round(max_frames))
    if not MIN_FPS <= normalized_fps <= MAX_FPS:
        raise ValueError(f"추출 FPS는 {int(MIN_FPS)}-{int(MAX_FPS)} 사이로 설정해 주세요.")
    if not MIN_FRAMES <= normalized_max_frames <= MAX_FRAMES:
        raise ValueError(f"최대 프레임 수는 {MIN_FRAMES}-{MAX_FRAMES} 사이로 설정해 주세요.")

    info = probe_video(path)
    effective_fps = min(normalized_fps, info.fps)
    interval = info.fps / effective_fps
    job_name = f"{time.strftime('%Y%m%d-%H%M%S')}-{safe_stem(path)}-{uuid.uuid4().hex[:8]}"
    job_dir = Path(output_root) / job_name
    frame_dir = job_dir / "source-frames"
    frame_dir.mkdir(parents=True, exist_ok=False)

    capture = cv2.VideoCapture(str(path))
    frame_paths: list[str] = []
    frame_times: list[float] = []
    next_sample_index = 0.0
    source_index = 0
    first_size: tuple[int, int] | None = None
    estimated = min(
        normalized_max_frames,
        max(1, int(math.ceil(info.frame_count / interval))) if info.frame_count else normalized_max_frames,
    )

    try:
        if not capture.isOpened():
            raise ValueError("영상을 열 수 없습니다. MP4, MOV 또는 WebM 파일을 사용해 주세요.")
        _notify(progress, 0.01, "영상을 열고 있어요")

        while len(frame_paths) < normalized_max_frames:
            ok, frame = capture.read()
            if not ok:
                break

            if source_index + 1e-9 >= next_sample_index:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                image = Image.fromarray(rgb, mode="RGB")
                if first_size is None:
                    first_size = image.size
                elif image.size != first_size:
                    raise ValueError("영상 도중 프레임 크기가 바뀌어 처리할 수 없습니다.")

                output_path = frame_dir / f"frame-{len(frame_paths) + 1:04d}.png"
                image.save(output_path, format="PNG", compress_level=1)
                frame_paths.append(str(output_path))
                frame_times.append(source_index / info.fps)
                next_sample_index += interval
                _notify(
                    progress,
                    min(0.99, len(frame_paths) / estimated),
                    f"프레임 {len(frame_paths)}/{estimated}을 펼치고 있어요",
                )
            source_index += 1
    finally:
        capture.release()

    if len(frame_paths) < MIN_FRAMES or first_size is None:
        raise ValueError("애니메이션을 만들 프레임이 부족합니다. 더 긴 영상을 사용해 주세요.")

    sampled_duration = (frame_times[-1] - frame_times[0]) + (1 / effective_fps)
    _notify(progress, 1.0, f"{len(frame_paths)}개 프레임을 펼쳤어요")
    return {
        "job_dir": str(job_dir),
        "source_video_name": path.name,
        "source_video_bytes": info.file_bytes,
        "source_size": list(first_size),
        "source_fps": info.fps,
        "source_frame_count": info.frame_count,
        "source_duration_seconds": info.duration_seconds,
        "sample_fps": effective_fps,
        "sampled_duration_seconds": sampled_duration,
        "frame_paths": frame_paths,
        "frame_times": frame_times,
    }


def validate_job(job: dict | None, output_root: Path) -> dict:
    if not isinstance(job, dict) or not job.get("job_dir"):
        raise ValueError("먼저 영상을 올리고 프레임을 추출해 주세요.")

    root = Path(output_root).resolve()
    job_dir = Path(str(job["job_dir"])).resolve()
    if job_dir == root or root not in job_dir.parents:
        raise ValueError("작업 폴더가 올바르지 않습니다. 프레임을 다시 추출해 주세요.")

    frame_paths = [Path(str(item)).resolve() for item in job.get("frame_paths", [])]
    if len(frame_paths) < MIN_FRAMES:
        raise ValueError("추출된 프레임이 없습니다. 프레임을 다시 추출해 주세요.")
    if any(job_dir not in path.parents or not path.is_file() for path in frame_paths):
        raise ValueError("추출 프레임을 찾을 수 없습니다. 프레임을 다시 추출해 주세요.")
    return job


def gallery_items(frame_paths: Sequence[str], frame_times: Sequence[float]) -> list[tuple[str, str]]:
    return [
        (path, f"{index:04d} / {timestamp:.2f}s")
        for index, (path, timestamp) in enumerate(zip(frame_paths, frame_times), start=1)
    ]


def _load_rgba_frames(frame_paths: Sequence[str]) -> list[Image.Image]:
    frames: list[Image.Image] = []
    expected_size: tuple[int, int] | None = None
    for path in frame_paths:
        try:
            with Image.open(path) as opened:
                opened.load()
                frame = ImageOps.exif_transpose(opened).convert("RGBA")
        except (UnidentifiedImageError, OSError) as error:
            raise ValueError("처리된 프레임 중 읽을 수 없는 파일이 있습니다.") from error
        if expected_size is None:
            expected_size = frame.size
        elif frame.size != expected_size:
            raise ValueError("모든 프레임의 가로·세로 크기가 같아야 합니다.")
        frames.append(frame)
    if not frames:
        raise ValueError("내보낼 프레임이 없습니다.")
    return frames


def fit_frame_to_cell(frame: Image.Image, cell_size: int) -> Image.Image:
    contained = ImageOps.contain(
        frame.convert("RGBA"),
        (cell_size, cell_size),
        method=Image.Resampling.LANCZOS,
    )
    canvas = Image.new("RGBA", (cell_size, cell_size), (0, 0, 0, 0))
    x = (cell_size - contained.width) // 2
    y = (cell_size - contained.height) // 2
    canvas.alpha_composite(contained, (x, y))
    return canvas


def create_sprite_sheet(
    frames: Sequence[Image.Image],
    cell_size: int,
    columns: int,
) -> tuple[Image.Image, int, int]:
    normalized_columns = max(1, min(int(columns), len(frames)))
    rows = math.ceil(len(frames) / normalized_columns)
    atlas_width = normalized_columns * cell_size
    atlas_height = rows * cell_size
    if atlas_width > MAX_ATLAS_EDGE or atlas_height > MAX_ATLAS_EDGE:
        raise ValueError("스프라이트 시트 한 변은 16,384px를 넘을 수 없습니다.")
    if atlas_width * atlas_height > MAX_ATLAS_PIXELS:
        raise ValueError("스프라이트 시트가 너무 큽니다. 셀 크기나 프레임 수를 줄여 주세요.")

    atlas = Image.new("RGBA", (atlas_width, atlas_height), (0, 0, 0, 0))
    for index, frame in enumerate(frames):
        x = (index % normalized_columns) * cell_size
        y = (index // normalized_columns) * cell_size
        atlas.alpha_composite(frame, (x, y))
    return atlas, normalized_columns, rows


def _gif_frame(frame: Image.Image, colors: int, alpha_threshold: int = 127) -> Image.Image:
    rgba = frame.convert("RGBA")
    alpha = np.asarray(rgba.getchannel("A"))
    transparency_index = colors - 1
    indexed = rgba.convert("RGB").quantize(
        colors=transparency_index,
        method=Image.Quantize.MEDIANCUT,
        dither=Image.Dither.FLOYDSTEINBERG,
    )
    pixels = np.asarray(indexed).copy()
    pixels[alpha <= alpha_threshold] = transparency_index
    converted = Image.fromarray(pixels.astype(np.uint8), mode="P")
    palette = indexed.getpalette() or [0] * 768
    palette[transparency_index * 3 : transparency_index * 3 + 3] = [0, 0, 0]
    converted.putpalette(palette)
    converted.info["transparency"] = transparency_index
    converted.info["disposal"] = 2
    return converted


def save_optimized_gif(
    frames: Sequence[Image.Image],
    output_path: Path,
    frame_duration_ms: int,
    colors: int,
    progress: ProgressCallback | None = None,
) -> None:
    if colors not in {64, 128, 256}:
        raise ValueError("GIF 색상 수는 64, 128, 256 중 하나여야 합니다.")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    gif_frames: list[Image.Image] = []
    total = len(frames)
    for index, frame in enumerate(frames, start=1):
        gif_frames.append(_gif_frame(frame, colors))
        _notify(
            progress,
            (index / total) * 0.88,
            f"GIF 색상 최적화 {index}/{total}",
        )
    _notify(progress, 0.92, "GIF 파일을 저장하고 있어요")
    gif_frames[0].save(
        output_path,
        format="GIF",
        save_all=True,
        append_images=gif_frames[1:],
        duration=frame_duration_ms,
        loop=0,
        disposal=2,
        transparency=colors - 1,
        optimize=True,
    )
    _notify(progress, 1.0, "GIF 압축을 마쳤어요")


def build_motion_preview_gif(
    frame_paths: Sequence[str],
    output_dir: Path,
    sample_fps: float,
    max_edge: int = PREVIEW_MAX_EDGE,
    colors: int = 128,
    progress: ProgressCallback | None = None,
) -> str:
    """Build a lightweight, pre-cutout GIF for checking timing and motion."""

    if not MIN_FPS <= sample_fps <= MAX_FPS:
        raise ValueError("추출 FPS 정보가 올바르지 않습니다.")
    if not 64 <= max_edge <= 1024:
        raise ValueError("미리보기 GIF의 최대 크기는 64-1,024px 사이여야 합니다.")

    source_frames = _load_rgba_frames(frame_paths)
    preview_frames: list[Image.Image] = []
    total = len(source_frames)
    for index, frame in enumerate(source_frames, start=1):
        preview_frames.append(
            ImageOps.contain(
                frame,
                (max_edge, max_edge),
                method=Image.Resampling.LANCZOS,
            )
        )
        _notify(
            progress,
            0.05 + (index / total) * 0.70,
            f"GIF 미리보기 프레임 {index}/{total}을 준비하고 있어요",
        )

    output_path = Path(output_dir) / "motion-preview.gif"
    _notify(progress, 0.82, "움직임 확인용 GIF를 압축하고 있어요")
    save_optimized_gif(
        preview_frames,
        output_path,
        frame_duration_ms=max(1, int(round(1000 / sample_fps))),
        colors=colors,
        progress=lambda value, description: _notify(
            progress,
            0.82 + value * 0.18,
            description,
        ),
    )
    _notify(progress, 1.0, "움직임 확인용 GIF를 만들었어요")
    return str(output_path)


def build_exports(
    frame_paths: Sequence[str],
    frame_times: Sequence[float],
    output_dir: Path,
    source_video_name: str,
    sample_fps: float,
    cell_size: int | float,
    columns: int | float,
    webp_quality: int | float,
    gif_colors: int | float,
    progress: ProgressCallback | None = None,
) -> ExportResult:
    normalized_cell_size = int(round(cell_size))
    normalized_columns = int(round(columns))
    normalized_quality = int(round(webp_quality))
    normalized_gif_colors = int(round(gif_colors))
    if not 64 <= normalized_cell_size <= 512:
        raise ValueError("프레임 셀 크기는 64-512px 사이로 설정해 주세요.")
    if not 1 <= normalized_columns <= 20:
        raise ValueError("열 수는 1-20 사이로 설정해 주세요.")
    if not 20 <= normalized_quality <= 95:
        raise ValueError("WebP 품질은 20-95 사이로 설정해 주세요.")
    if not MIN_FPS <= sample_fps <= MAX_FPS:
        raise ValueError("추출 FPS 정보가 올바르지 않습니다.")

    target_dir = Path(output_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    _notify(progress, 0.03, "투명 프레임을 불러오고 있어요")
    source_frames = _load_rgba_frames(frame_paths)
    frames = [fit_frame_to_cell(frame, normalized_cell_size) for frame in source_frames]

    _notify(progress, 0.20, "스프라이트 시트를 만들고 있어요")
    atlas, normalized_columns, rows = create_sprite_sheet(
        frames,
        normalized_cell_size,
        normalized_columns,
    )
    sprite_png_path = target_dir / "sprite-atlas.png"
    sprite_webp_path = target_dir / "sprite-atlas.webp"
    atlas.save(sprite_png_path, format="PNG", optimize=True)
    atlas.save(
        sprite_webp_path,
        format="WEBP",
        quality=normalized_quality,
        method=WEBP_ENCODING_METHOD,
        exact=True,
    )

    frame_duration_ms = max(1, int(round(1000 / sample_fps)))
    animated_webp_path = target_dir / "sprite-animation.webp"
    _notify(
        progress,
        0.45,
        f"애니메이션 WebP 압축 중 · {len(frames)}프레임 · {normalized_cell_size}px",
    )
    frames[0].save(
        animated_webp_path,
        format="WEBP",
        save_all=True,
        append_images=frames[1:],
        duration=frame_duration_ms,
        loop=0,
        quality=normalized_quality,
        method=WEBP_ENCODING_METHOD,
        minimize_size=False,
        exact=True,
    )

    gif_path = target_dir / "sprite-animation.gif"
    _notify(progress, 0.67, "GIF 팔레트와 투명도를 최적화하고 있어요")
    save_optimized_gif(
        frames,
        gif_path,
        frame_duration_ms=frame_duration_ms,
        colors=normalized_gif_colors,
        progress=lambda value, description: _notify(
            progress,
            0.67 + value * 0.16,
            description,
        ),
    )

    manifest_path = target_dir / "sprite-manifest.json"
    manifest = {
        "schemaVersion": 1,
        "image": sprite_webp_path.name,
        "fallbackImage": sprite_png_path.name,
        "sourceVideo": Path(source_video_name).name,
        "frameCount": len(frames),
        "frameRate": round(sample_fps, 4),
        "frameDurationMs": frame_duration_ms,
        "frameWidth": normalized_cell_size,
        "frameHeight": normalized_cell_size,
        "columns": normalized_columns,
        "rows": rows,
        "atlasWidth": atlas.width,
        "atlasHeight": atlas.height,
        "loop": True,
        "frames": [
            {
                "index": index,
                "x": (index % normalized_columns) * normalized_cell_size,
                "y": (index // normalized_columns) * normalized_cell_size,
                "width": normalized_cell_size,
                "height": normalized_cell_size,
                "durationMs": frame_duration_ms,
                "sourceTimeSeconds": round(float(frame_times[index]), 6),
            }
            for index in range(len(frames))
        ],
    }
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    output_files = (
        str(sprite_webp_path),
        str(animated_webp_path),
        str(gif_path),
        str(sprite_png_path),
        str(manifest_path),
    )
    package_path = target_dir / "sprite-animation-package.zip"
    _notify(progress, 0.86, "프레임과 결과 파일을 한 묶음으로 만들고 있어요")
    with zipfile.ZipFile(package_path, "w", compression=zipfile.ZIP_STORED) as archive:
        for file_path in output_files:
            path = Path(file_path)
            archive.write(path, arcname=path.name)
        for index, frame_path in enumerate(frame_paths, start=1):
            archive.write(frame_path, arcname=f"frames/frame-{index:04d}.png")

    all_files = (*output_files, str(package_path))
    file_sizes = {Path(path).name: Path(path).stat().st_size for path in all_files}
    _notify(progress, 1.0, "스프라이트 애니메이션을 모두 만들었어요")
    return ExportResult(
        sprite_png_path=str(sprite_png_path),
        sprite_webp_path=str(sprite_webp_path),
        animated_webp_path=str(animated_webp_path),
        gif_path=str(gif_path),
        manifest_path=str(manifest_path),
        package_path=str(package_path),
        output_files=all_files,
        frame_size=(normalized_cell_size, normalized_cell_size),
        atlas_size=atlas.size,
        columns=normalized_columns,
        rows=rows,
        frame_duration_ms=frame_duration_ms,
        file_sizes=file_sizes,
    )
