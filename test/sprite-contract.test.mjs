import assert from "node:assert/strict";
import test from "node:test";

import {
  SPRITE_MODELS,
  normalizeExportSettings,
  normalizeExtractionSettings,
  publicSpriteConfig,
  safeVideoFilename,
} from "../lib/sprite-contract.mjs";

test("video filenames are reduced to a safe supported basename", () => {
  assert.equal(safeVideoFilename("../../나의 영상 final.MP4"), "나의-영상-final.mp4");
  assert.throws(() => safeVideoFilename("secret.env"), /MP4, MOV 또는 WebM/);
});

test("sprite settings enforce bounded extraction and export values", () => {
  assert.deepEqual(normalizeExtractionSettings({ targetFps: 12, maxFrames: 80 }), {
    targetFps: 12,
    maxFrames: 80,
  });
  assert.throws(() => normalizeExtractionSettings({ targetFps: 31 }), /1-30/);
  assert.throws(() => normalizeExportSettings({ columns: 21 }), /1-20/);
  assert.throws(() => normalizeExportSettings({ modelName: "arbitrary remote code" }), /지원하지 않는/);
});

test("public sprite config exposes pinned model revisions without local paths", () => {
  const config = publicSpriteConfig({ installed: true });
  assert.equal(config.installed, true);
  assert.equal(config.officialSupport, "macOS Apple Silicon");
  assert.equal(config.models.length, 4);
  for (const model of SPRITE_MODELS) assert.match(model.revision, /^[a-f0-9]{40}$/);
  assert.equal(JSON.stringify(config).includes("/Users/"), false);
});
