import assert from "node:assert/strict";
import test from "node:test";

import {
  H3ValidationError,
  IMAGE_ROLES,
  MODES,
  buildSpriteConsistencyPrompt,
  buildH3Payload,
  estimateCost,
  normalizeGenerationRequest,
  publicConfig,
} from "../lib/h3-contract.mjs";

function image(role, overrides = {}) {
  return {
    role,
    name: `${role}.png`,
    type: "image/png",
    dataUrl: `data:image/png;base64,${Buffer.from("fake-image").toString("base64")}`,
    width: 1024,
    height: 1024,
    ...overrides,
  };
}

test("reference image request uses MiniMax-H3 and keeps selected ratio", () => {
  const payload = buildH3Payload({
    mode: MODES.REFERENCE_IMAGE,
    prompt: "Keep the character consistent.",
    resolution: "2K",
    duration: 6,
    ratio: "1:1",
    images: [image(IMAGE_ROLES.REFERENCE), image(IMAGE_ROLES.REFERENCE)],
  });

  assert.equal(payload.model, "MiniMax-H3");
  assert.equal(payload.resolution, "2K");
  assert.equal(payload.duration, 6);
  assert.equal(payload.ratio, "1:1");
  assert.deepEqual(payload.content.map((item) => item.role).filter(Boolean), ["reference_image", "reference_image"]);
});

test("sprite consistency appends a locked 1:1 framing prompt", () => {
  const payload = buildH3Payload({
    mode: MODES.REFERENCE_IMAGE,
    prompt: "The character waves once.",
    ratio: "1:1",
    sprite: { enabled: true, characterHeightPercent: 70, footAnchorPercent: 88 },
    images: [image(IMAGE_ROLES.REFERENCE)],
  });

  const prompt = payload.content[0].text;
  assert.match(prompt, /^The character waves once\./);
  assert.match(prompt, /\[static\]/);
  assert.match(prompt, /approximately 70%/);
  assert.match(prompt, /at 88% of the canvas height/);
  assert.match(prompt, /Do not zoom, pan, tilt/);
});

test("sprite prompt is omitted when the option is disabled", () => {
  const request = normalizeGenerationRequest({
    mode: MODES.REFERENCE_IMAGE,
    prompt: "Only the requested action.",
    sprite: { enabled: false, characterHeightPercent: 60, footAnchorPercent: 84 },
    ratio: "16:9",
    images: [image(IMAGE_ROLES.REFERENCE)],
  });

  assert.equal(request.prompt, "Only the requested action.");
  assert.equal(request.sprite.enabled, false);
});

test("sprite consistency rejects non-square output and frame inputs", () => {
  assert.throws(() => normalizeGenerationRequest({
    mode: MODES.REFERENCE_IMAGE,
    prompt: "Wave.",
    ratio: "16:9",
    sprite: { enabled: true, characterHeightPercent: 70, footAnchorPercent: 88 },
    images: [image(IMAGE_ROLES.REFERENCE)],
  }), /1:1 비율/);

  assert.throws(() => normalizeGenerationRequest({
    mode: MODES.FRAMES,
    prompt: "Wave.",
    sprite: { enabled: true, characterHeightPercent: 70, footAnchorPercent: 88 },
    images: [image(IMAGE_ROLES.FIRST, { width: 1280, height: 720 })],
  }), /1:1 시작\/종료 프레임/);
});

test("sprite constraint counts toward the H3 7000-character prompt limit", () => {
  const constraint = buildSpriteConsistencyPrompt();
  assert.throws(() => normalizeGenerationRequest({
    mode: MODES.REFERENCE_IMAGE,
    prompt: "x".repeat(7_000 - constraint.length),
    ratio: "1:1",
    sprite: { enabled: true, characterHeightPercent: 70, footAnchorPercent: 88 },
    images: [image(IMAGE_ROLES.REFERENCE)],
  }), /7,000자/);
});

test("first and last frame request omits ratio because H3 derives it from frames", () => {
  const payload = buildH3Payload({
    mode: MODES.FRAMES,
    prompt: "Move naturally between the two poses.",
    resolution: "768P",
    duration: 8,
    ratio: "1:1",
    images: [image(IMAGE_ROLES.FIRST), image(IMAGE_ROLES.LAST)],
  });

  assert.equal(payload.ratio, undefined);
  assert.deepEqual(payload.content.map((item) => item.role).filter(Boolean), ["first_frame", "last_frame"]);
});

test("a frame request can use only the last frame", () => {
  const request = normalizeGenerationRequest({
    mode: MODES.FRAMES,
    prompt: "End at this composition.",
    images: [image(IMAGE_ROLES.LAST)],
  });

  assert.equal(request.ratio, "adaptive");
  assert.equal(request.images.length, 1);
});

test("reference and frame roles cannot be mixed", () => {
  assert.throws(
    () => buildH3Payload({
      mode: MODES.REFERENCE_IMAGE,
      prompt: "Invalid mixed request",
      images: [image(IMAGE_ROLES.REFERENCE), image(IMAGE_ROLES.FIRST)],
    }),
    H3ValidationError,
  );
});

test("first and last frame aspect ratios must match", () => {
  assert.throws(
    () => buildH3Payload({
      mode: MODES.FRAMES,
      prompt: "Invalid ratio transition",
      images: [
        image(IMAGE_ROLES.FIRST, { width: 1024, height: 1024 }),
        image(IMAGE_ROLES.LAST, { width: 1920, height: 1080 }),
      ],
    }),
    /비율이 서로 다릅니다/,
  );
});

test("prompt, duration, resolution, count and image limits are enforced", () => {
  assert.throws(() => normalizeGenerationRequest({ mode: MODES.REFERENCE_IMAGE, prompt: "", images: [image(IMAGE_ROLES.REFERENCE)] }), /프롬프트/);
  assert.throws(() => normalizeGenerationRequest({ mode: MODES.REFERENCE_IMAGE, prompt: "ok", duration: 16, images: [image(IMAGE_ROLES.REFERENCE)] }), /4~15초/);
  assert.throws(() => normalizeGenerationRequest({ mode: MODES.REFERENCE_IMAGE, prompt: "ok", resolution: "1080P", images: [image(IMAGE_ROLES.REFERENCE)] }), /768P 또는 2K/);
  assert.throws(() => normalizeGenerationRequest({ mode: MODES.REFERENCE_IMAGE, prompt: "ok", images: [] }), /1~9장/);
  assert.throws(() => normalizeGenerationRequest({
    mode: MODES.REFERENCE_IMAGE,
    prompt: "ok",
    images: [image(IMAGE_ROLES.REFERENCE, { width: 128 })],
  }), /너비/);
});

test("cost estimate follows H3 output pricing and extra image pricing", () => {
  assert.equal(estimateCost({ resolution: "2K", duration: 6, imageCount: 2 }), 0.78);
  assert.equal(estimateCost({ resolution: "768P", duration: 10, imageCount: 5 }), 0.8);
  assert.equal(estimateCost({ resolution: "2K", duration: 6, imageCount: 7 }), 0.86);
});

test("public config exposes controls without secrets", () => {
  const config = publicConfig({ envKeyConfigured: true });
  assert.equal(config.model, "MiniMax-H3");
  assert.equal(config.defaults.ratio, "1:1");
  assert.equal(config.defaults.resolution, "2K");
  assert.equal(config.sprite.defaults.enabled, false);
  assert.deepEqual(config.sprite.characterHeights, [60, 70, 80]);
  assert.match(config.sprite.promptTemplate, /\{characterHeightPercent\}/);
  assert.equal(config.envKeyConfigured, true);
  assert.equal("apiKey" in config, false);
});
