export const MODEL = "MiniMax-H3";
export const MODES = Object.freeze({
  REFERENCE_IMAGE: "reference-image",
  FRAMES: "frames",
});
export const IMAGE_ROLES = Object.freeze({
  REFERENCE: "reference_image",
  FIRST: "first_frame",
  LAST: "last_frame",
});
export const RESOLUTIONS = Object.freeze(["768P", "2K"]);
export const RATIOS = Object.freeze(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
export const DURATIONS = Object.freeze(Array.from({ length: 12 }, (_, index) => index + 4));
export const SPRITE_CHARACTER_HEIGHTS = Object.freeze([60, 70, 80]);
export const SPRITE_FOOT_ANCHORS = Object.freeze([84, 88, 92]);
export const SPRITE_DEFAULTS = Object.freeze({
  enabled: false,
  characterHeightPercent: 70,
  footAnchorPercent: 88,
});
export const SPRITE_PROMPT_TEMPLATE = `[static]

[Sprite animation consistency constraints]
Create a square 1:1 sprite-animation source with one character and a locked, motionless camera. Preserve the same character identity, body proportions, face, hairstyle, costume, colors, outline, and full-body silhouette in every frame. Keep the character horizontally centered. Keep the full-body bounding-box height at approximately {characterHeightPercent}% of the canvas in every frame. Keep both feet anchored to a stable ground line at {footAnchorPercent}% of the canvas height. Keep the full body visible with stable margins. Do not zoom, pan, tilt, truck, dolly, track, shake, crop, reframe, resize the character, change perspective, cut scenes, morph the body, alter proportions, or add or remove body parts. Only animate the action requested above.`;
export const DEFAULTS = Object.freeze({
  model: MODEL,
  mode: MODES.REFERENCE_IMAGE,
  resolution: "2K",
  ratio: "1:1",
  duration: 6,
});

export const LIMITS = Object.freeze({
  promptCharacters: 7_000,
  referenceImages: 9,
  imageBytes: 30 * 1024 * 1024,
  requestBytes: 64 * 1024 * 1024,
  minDimension: 256,
  maxDimension: 5_760,
  minAspectRatio: 0.4,
  maxAspectRatio: 2.5,
  frameRatioTolerance: 0.02,
});

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const ROLE_SET = new Set(Object.values(IMAGE_ROLES));
const DATA_URL_PATTERN = /^data:(image\/(?:jpeg|png|webp|heic|heif));base64,([a-zA-Z0-9+/=\s]+)$/;

export class H3ValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "H3ValidationError";
    this.details = details;
    this.statusCode = 400;
  }
}

function assert(condition, message, details = []) {
  if (!condition) throw new H3ValidationError(message, details);
}

function normalizedInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isInteger(number) ? number : Number.NaN;
}

function base64ByteLength(base64) {
  const compact = base64.replace(/\s/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function validateImage(rawImage, index) {
  assert(rawImage && typeof rawImage === "object", `이미지 ${index + 1} 정보가 올바르지 않습니다.`);

  const role = String(rawImage.role ?? "");
  assert(ROLE_SET.has(role), `이미지 ${index + 1}의 역할이 올바르지 않습니다.`);

  const name = String(rawImage.name ?? `image-${index + 1}`).slice(0, 180);
  const type = String(rawImage.type ?? "").toLowerCase();
  assert(ALLOWED_IMAGE_TYPES.has(type), `${name}: 지원하지 않는 이미지 형식입니다.`);

  const dataUrl = String(rawImage.dataUrl ?? "");
  const match = DATA_URL_PATTERN.exec(dataUrl);
  assert(match, `${name}: Base64 이미지 데이터가 올바르지 않습니다.`);
  assert(match[1] === type, `${name}: 파일 형식과 데이터 형식이 일치하지 않습니다.`);

  const bytes = base64ByteLength(match[2]);
  assert(bytes > 0, `${name}: 비어 있는 이미지입니다.`);
  assert(bytes <= LIMITS.imageBytes, `${name}: 이미지 크기는 30MB 이하여야 합니다.`);

  const width = normalizedInteger(rawImage.width, Number.NaN);
  const height = normalizedInteger(rawImage.height, Number.NaN);
  assert(
    Number.isInteger(width) && width >= LIMITS.minDimension && width <= LIMITS.maxDimension,
    `${name}: 너비는 ${LIMITS.minDimension}~${LIMITS.maxDimension}px여야 합니다.`,
  );
  assert(
    Number.isInteger(height) && height >= LIMITS.minDimension && height <= LIMITS.maxDimension,
    `${name}: 높이는 ${LIMITS.minDimension}~${LIMITS.maxDimension}px여야 합니다.`,
  );

  const aspectRatio = width / height;
  assert(
    aspectRatio >= LIMITS.minAspectRatio && aspectRatio <= LIMITS.maxAspectRatio,
    `${name}: 가로세로 비율은 2:5~5:2 범위여야 합니다.`,
  );

  return { role, name, type, dataUrl, width, height, bytes, aspectRatio };
}

export function buildSpriteConsistencyPrompt({
  characterHeightPercent = SPRITE_DEFAULTS.characterHeightPercent,
  footAnchorPercent = SPRITE_DEFAULTS.footAnchorPercent,
} = {}) {
  const height = normalizedInteger(characterHeightPercent, SPRITE_DEFAULTS.characterHeightPercent);
  const footAnchor = normalizedInteger(footAnchorPercent, SPRITE_DEFAULTS.footAnchorPercent);
  assert(SPRITE_CHARACTER_HEIGHTS.includes(height), "캐릭터 높이는 60%, 70%, 80% 중에서 선택해 주세요.");
  assert(SPRITE_FOOT_ANCHORS.includes(footAnchor), "발 기준선은 84%, 88%, 92% 중에서 선택해 주세요.");
  return SPRITE_PROMPT_TEMPLATE
    .replace("{characterHeightPercent}", String(height))
    .replace("{footAnchorPercent}", String(footAnchor));
}

function normalizeSpriteOptions(rawSprite) {
  if (rawSprite === undefined || rawSprite === null) return { ...SPRITE_DEFAULTS };
  assert(rawSprite && typeof rawSprite === "object" && !Array.isArray(rawSprite), "스프라이트 일관성 설정이 올바르지 않습니다.");
  assert(typeof rawSprite.enabled === "boolean", "스프라이트 일관성 사용 여부가 올바르지 않습니다.");

  const characterHeightPercent = normalizedInteger(
    rawSprite.characterHeightPercent,
    SPRITE_DEFAULTS.characterHeightPercent,
  );
  const footAnchorPercent = normalizedInteger(rawSprite.footAnchorPercent, SPRITE_DEFAULTS.footAnchorPercent);
  assert(SPRITE_CHARACTER_HEIGHTS.includes(characterHeightPercent), "캐릭터 높이는 60%, 70%, 80% 중에서 선택해 주세요.");
  assert(SPRITE_FOOT_ANCHORS.includes(footAnchorPercent), "발 기준선은 84%, 88%, 92% 중에서 선택해 주세요.");

  return { enabled: rawSprite.enabled, characterHeightPercent, footAnchorPercent };
}

export function normalizeGenerationRequest(input) {
  assert(input && typeof input === "object" && !Array.isArray(input), "요청 본문이 올바르지 않습니다.");

  const mode = String(input.mode ?? DEFAULTS.mode);
  assert(Object.values(MODES).includes(mode), "지원하지 않는 생성 방식입니다.");

  const userPrompt = String(input.prompt ?? "").trim();
  assert(userPrompt.length > 0, "프롬프트를 입력해 주세요.");

  const resolution = String(input.resolution ?? DEFAULTS.resolution).toUpperCase();
  assert(RESOLUTIONS.includes(resolution), "해상도는 768P 또는 2K만 사용할 수 있습니다.");

  const duration = normalizedInteger(input.duration, DEFAULTS.duration);
  assert(DURATIONS.includes(duration), "재생 시간은 4~15초 사이의 정수여야 합니다.");

  const imagesInput = Array.isArray(input.images) ? input.images : [];
  const images = imagesInput.map(validateImage);
  const sprite = normalizeSpriteOptions(input.sprite);

  let ratio = String(input.ratio ?? DEFAULTS.ratio);

  if (mode === MODES.REFERENCE_IMAGE) {
    assert(images.length >= 1 && images.length <= LIMITS.referenceImages, "참고 이미지는 1~9장 필요합니다.");
    assert(images.every((image) => image.role === IMAGE_ROLES.REFERENCE), "참고 이미지 모드에는 reference_image만 사용할 수 있습니다.");
    assert(RATIOS.includes(ratio), "지원하지 않는 화면 비율입니다.");
    if (sprite.enabled) assert(ratio === "1:1", "스프라이트 일관성은 1:1 비율에서만 사용할 수 있습니다.");
  } else {
    assert(images.length >= 1 && images.length <= 2, "시작 또는 종료 프레임을 한 장 이상 추가해 주세요.");
    assert(images.every((image) => image.role === IMAGE_ROLES.FIRST || image.role === IMAGE_ROLES.LAST), "프레임 모드에는 시작/종료 프레임만 사용할 수 있습니다.");
    assert(new Set(images.map((image) => image.role)).size === images.length, "시작 프레임과 종료 프레임은 각각 한 장만 사용할 수 있습니다.");
    ratio = "adaptive";

    if (images.length === 2) {
      const difference = Math.abs(images[0].aspectRatio - images[1].aspectRatio);
      const baseline = Math.max(images[0].aspectRatio, images[1].aspectRatio);
      assert(difference / baseline <= LIMITS.frameRatioTolerance, "시작 프레임과 종료 프레임의 비율이 서로 다릅니다.");
    }

    if (sprite.enabled) {
      assert(
        images.every((image) => Math.abs(image.aspectRatio - 1) <= LIMITS.frameRatioTolerance),
        "스프라이트 일관성은 1:1 시작/종료 프레임만 사용할 수 있습니다.",
      );
    }
  }

  const spritePrompt = sprite.enabled ? buildSpriteConsistencyPrompt(sprite) : "";
  const prompt = spritePrompt ? `${userPrompt}\n\n${spritePrompt}` : userPrompt;
  assert(prompt.length <= LIMITS.promptCharacters, "자동 스프라이트 제약을 포함한 프롬프트는 7,000자 이하여야 합니다.");

  return { model: MODEL, mode, userPrompt, prompt, resolution, duration, ratio, images, sprite };
}

export function buildH3Payload(input) {
  const request = normalizeGenerationRequest(input);
  const content = [
    { type: "text", text: request.prompt },
    ...request.images.map((image) => ({
      type: "image_url",
      image_url: { url: image.dataUrl },
      role: image.role,
    })),
  ];

  const payload = {
    model: MODEL,
    content,
    resolution: request.resolution,
    duration: request.duration,
  };

  if (request.mode === MODES.REFERENCE_IMAGE) payload.ratio = request.ratio;

  return payload;
}

export function estimateCost({ resolution = DEFAULTS.resolution, duration = DEFAULTS.duration, imageCount = 0 } = {}) {
  assert(RESOLUTIONS.includes(resolution), "비용을 계산할 수 없는 해상도입니다.");
  assert(DURATIONS.includes(Number(duration)), "비용을 계산할 수 없는 재생 시간입니다.");
  const normalizedImageCount = Math.max(0, Number(imageCount) || 0);
  const outputRate = resolution === "2K" ? 0.13 : 0.08;
  const inputImageCost = Math.max(0, normalizedImageCount - 5) * 0.04;
  return Number((outputRate * Number(duration) + inputImageCost).toFixed(2));
}

export function publicConfig({ envKeyConfigured = false } = {}) {
  return {
    model: MODEL,
    defaults: DEFAULTS,
    modes: MODES,
    imageRoles: IMAGE_ROLES,
    resolutions: RESOLUTIONS,
    ratios: RATIOS,
    durations: DURATIONS,
    sprite: {
      defaults: SPRITE_DEFAULTS,
      characterHeights: SPRITE_CHARACTER_HEIGHTS,
      footAnchors: SPRITE_FOOT_ANCHORS,
      promptTemplate: SPRITE_PROMPT_TEMPLATE,
    },
    limits: {
      promptCharacters: LIMITS.promptCharacters,
      referenceImages: LIMITS.referenceImages,
      imageBytes: LIMITS.imageBytes,
      requestBytes: LIMITS.requestBytes,
      minDimension: LIMITS.minDimension,
      maxDimension: LIMITS.maxDimension,
      minAspectRatio: LIMITS.minAspectRatio,
      maxAspectRatio: LIMITS.maxAspectRatio,
    },
    pricing: { "768P": 0.08, "2K": 0.13, extraImage: 0.04, freeImages: 5 },
    envKeyConfigured,
  };
}
