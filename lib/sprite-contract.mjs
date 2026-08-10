export const SPRITE_MODELS = Object.freeze([
  Object.freeze({
    name: "정밀 · 다양한 사진 (권장)",
    repo: "ZhengPeng7/BiRefNet_dynamic",
    revision: "280306042f57b7a33854319da62fd86aaa89ec4c",
    note: "비율을 유지해 처리합니다. 상품, 동물, 사물 등 대부분의 영상에 권장합니다.",
  }),
  Object.freeze({
    name: "빠르게 · 일반 사진",
    repo: "ZhengPeng7/BiRefNet_lite",
    revision: "7838f1c3472f827cd8ce13ab5ccc2ce48077360f",
    note: "가벼운 모델로 먼저 결과를 확인할 때 적합합니다.",
  }),
  Object.freeze({
    name: "인물 · 머리카락",
    repo: "ZhengPeng7/BiRefNet-portrait",
    revision: "ecdeb6240ef23557dbd48ff27c59c1a88cbcb755",
    note: "사람과 머리카락 경계에 맞춰 학습된 모델입니다.",
  }),
  Object.freeze({
    name: "고해상도 · 섬세한 경계",
    repo: "ZhengPeng7/BiRefNet_HR-matting",
    revision: "5d6b6f8adcb5b417c871b1d84ceaae9871355b7f",
    note: "큰 영상과 반투명한 경계에 유리하지만 메모리와 시간이 더 필요합니다.",
  }),
]);

export const SPRITE_DEFAULTS = Object.freeze({
  targetFps: 15,
  maxFrames: 120,
  cellSize: 256,
  columns: 10,
  modelName: "빠르게 · 일반 사진",
  refineEdges: true,
  webpQuality: 80,
  gifColors: 128,
});

export const SPRITE_LIMITS = Object.freeze({
  maxVideoBytes: 1024 * 1024 * 1024,
  minFps: 1,
  maxFps: 30,
  minFrames: 2,
  maxFrames: 240,
  cellSizes: Object.freeze([64, 96, 128, 160, 192, 256, 320, 384, 512]),
  minColumns: 1,
  maxColumns: 20,
  minWebpQuality: 20,
  maxWebpQuality: 95,
  gifColors: Object.freeze([64, 128, 256]),
});

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm"]);
const MODEL_NAMES = new Set(SPRITE_MODELS.map((model) => model.name));

function integer(value, fallback) {
  const normalized = value === undefined || value === null || value === "" ? fallback : Number(value);
  return Number.isInteger(normalized) ? normalized : Number.NaN;
}

function assert(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  }
}

export function safeVideoFilename(value, fallback = "video.mp4") {
  const raw = String(value || fallback).split(/[\\/]/).pop() || fallback;
  const extension = raw.includes(".") ? raw.split(".").pop().toLowerCase() : "";
  assert(VIDEO_EXTENSIONS.has(extension), "MP4, MOV 또는 WebM 영상만 사용할 수 있습니다.");
  const stem = raw.slice(0, -(extension.length + 1));
  const safeStem = stem.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "video";
  return `${safeStem}.${extension}`;
}

export function normalizeExtractionSettings(input = {}) {
  const targetFps = integer(input.targetFps, SPRITE_DEFAULTS.targetFps);
  const maxFrames = integer(input.maxFrames, SPRITE_DEFAULTS.maxFrames);
  assert(targetFps >= SPRITE_LIMITS.minFps && targetFps <= SPRITE_LIMITS.maxFps, "추출 FPS는 1-30 사이여야 합니다.");
  assert(maxFrames >= SPRITE_LIMITS.minFrames && maxFrames <= SPRITE_LIMITS.maxFrames, "최대 프레임 수는 2-240 사이여야 합니다.");
  return { targetFps, maxFrames };
}

export function normalizeExportSettings(input = {}) {
  const cellSize = integer(input.cellSize, SPRITE_DEFAULTS.cellSize);
  const columns = integer(input.columns, SPRITE_DEFAULTS.columns);
  const webpQuality = integer(input.webpQuality, SPRITE_DEFAULTS.webpQuality);
  const gifColors = integer(input.gifColors, SPRITE_DEFAULTS.gifColors);
  const modelName = String(input.modelName || SPRITE_DEFAULTS.modelName);
  const refineEdges = input.refineEdges === undefined ? SPRITE_DEFAULTS.refineEdges : input.refineEdges;

  assert(SPRITE_LIMITS.cellSizes.includes(cellSize), "지원하지 않는 셀 크기입니다.");
  assert(columns >= SPRITE_LIMITS.minColumns && columns <= SPRITE_LIMITS.maxColumns, "atlas 열 수는 1-20 사이여야 합니다.");
  assert(webpQuality >= SPRITE_LIMITS.minWebpQuality && webpQuality <= SPRITE_LIMITS.maxWebpQuality, "WebP 품질은 20-95 사이여야 합니다.");
  assert(SPRITE_LIMITS.gifColors.includes(gifColors), "GIF 색상 수는 64, 128, 256 중 하나여야 합니다.");
  assert(MODEL_NAMES.has(modelName), "지원하지 않는 BiRefNet 모델입니다.");
  assert(typeof refineEdges === "boolean", "가장자리 정제 설정이 올바르지 않습니다.");

  return { cellSize, columns, webpQuality, gifColors, modelName, refineEdges };
}

export function publicSpriteConfig({ installed = false } = {}) {
  return {
    installed,
    defaults: SPRITE_DEFAULTS,
    limits: SPRITE_LIMITS,
    models: SPRITE_MODELS,
    setupCommand: "pnpm setup:sprite",
    officialSupport: "macOS Apple Silicon",
  };
}
