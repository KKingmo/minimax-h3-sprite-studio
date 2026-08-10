from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from webp_converter import (
    convert_png_to_webp,
    save_as_webp,
    validate_webp_quality,
)


class WebPConverterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_png_is_converted_and_reduces_photo_like_file_size(self) -> None:
        random = np.random.default_rng(42)
        pixels = random.integers(0, 256, size=(240, 320, 3), dtype=np.uint8)
        source_path = self.root / "photo.png"
        Image.fromarray(pixels, mode="RGB").save(source_path, format="PNG")

        result = convert_png_to_webp(source_path.as_posix(), self.root, quality=72)

        self.assertTrue(result.output_path.endswith(".webp"))
        self.assertEqual(result.original_size, (320, 240))
        self.assertLess(result.output_bytes, result.original_bytes)
        self.assertGreater(result.reduction_percent, 0)
        with Image.open(result.output_path) as converted:
            self.assertEqual(converted.format, "WEBP")
            self.assertEqual(converted.size, (320, 240))

    def test_transparent_alpha_channel_is_preserved(self) -> None:
        source = Image.new("RGBA", (16, 12), (210, 40, 30, 0))
        for x in range(8):
            for y in range(12):
                source.putpixel((x, y), (210, 40, 30, 192))
        output_path = self.root / "transparent.webp"

        save_as_webp(source, output_path, quality=80)

        with Image.open(output_path) as converted:
            rgba = converted.convert("RGBA")
            self.assertEqual(rgba.size, source.size)
            self.assertEqual(rgba.getpixel((2, 2))[3], 192)
            self.assertEqual(rgba.getpixel((12, 2))[3], 0)

    def test_non_png_input_is_rejected(self) -> None:
        source_path = self.root / "photo.jpg"
        Image.new("RGB", (32, 32), "red").save(source_path, format="JPEG")

        with self.assertRaisesRegex(ValueError, "PNG 파일만"):
            convert_png_to_webp(source_path.as_posix(), self.root, quality=80)

    def test_quality_is_bounded(self) -> None:
        self.assertEqual(validate_webp_quality(79.6), 80)
        with self.assertRaises(ValueError):
            validate_webp_quality(10)


if __name__ == "__main__":
    unittest.main()
