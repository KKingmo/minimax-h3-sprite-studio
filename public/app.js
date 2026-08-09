const state = {
  config: null,
  mode: "reference-image",
  resolution: "2K",
  ratio: "1:1",
  duration: 6,
  sprite: {
    enabled: false,
    characterHeightPercent: 70,
    footAnchorPercent: 88,
  },
  apiKey: "",
  referenceImages: [],
  frames: { first: null, last: null },
  tasks: [],
  activeTaskId: null,
  pollControllers: new Map(),
};

const elements = {
  connectionStatus: document.querySelector("#connection-status"),
  connectionLabel: document.querySelector("#connection-label"),
  openSettings: document.querySelector("#open-settings"),
  settingsDialog: document.querySelector("#settings-dialog"),
  envKeyNotice: document.querySelector("#env-key-notice"),
  apiKey: document.querySelector("#api-key"),
  toggleKey: document.querySelector("#toggle-key"),
  applyKey: document.querySelector("#apply-key"),
  modeTabs: [...document.querySelectorAll(".mode-tab")],
  referencePanel: document.querySelector("#reference-panel"),
  framesPanel: document.querySelector("#frames-panel"),
  referenceGrid: document.querySelector("#reference-grid"),
  referenceDropzone: document.querySelector("#reference-dropzone"),
  referenceInput: document.querySelector("#reference-input"),
  referenceCount: document.querySelector("#reference-count"),
  firstFrameInput: document.querySelector("#first-frame-input"),
  lastFrameInput: document.querySelector("#last-frame-input"),
  firstFrameSlot: document.querySelector("#first-frame-slot"),
  lastFrameSlot: document.querySelector("#last-frame-slot"),
  swapFrames: document.querySelector("#swap-frames"),
  prompt: document.querySelector("#prompt"),
  promptCount: document.querySelector("#prompt-count"),
  spriteToggle: document.querySelector("#sprite-toggle"),
  spriteControls: document.querySelector("#sprite-controls"),
  spriteHeightOptions: document.querySelector("#sprite-height-options"),
  spriteFootOptions: document.querySelector("#sprite-foot-options"),
  spriteSummaryText: document.querySelector("#sprite-summary-text"),
  spritePromptPreview: document.querySelector("#sprite-prompt-preview"),
  ratioOptions: document.querySelector("#ratio-options"),
  ratioNote: document.querySelector("#ratio-note"),
  resolutionOptions: document.querySelector("#resolution-options"),
  durationOptions: document.querySelector("#duration-options"),
  formMessage: document.querySelector("#form-message"),
  estimatedCost: document.querySelector("#estimated-cost"),
  costDetail: document.querySelector("#cost-detail"),
  generateButton: document.querySelector("#generate-button"),
  resultStatus: document.querySelector("#result-status"),
  previewEmpty: document.querySelector("#preview-empty"),
  resultVideo: document.querySelector("#result-video"),
  activeTask: document.querySelector("#active-task"),
  activeTaskLabel: document.querySelector("#active-task-label"),
  activeTaskId: document.querySelector("#active-task-id"),
  downloadButton: document.querySelector("#download-button"),
  historyBody: document.querySelector("#history-body"),
  toast: document.querySelector("#toast"),
};

const STATUS_LABELS = {
  submitting: "요청 중",
  queued: "대기 중",
  running: "생성 중",
  succeeded: "완료",
  failed: "실패",
  cancelled: "취소됨",
};

const MODE_LABELS = {
  "reference-image": "참고 이미지",
  frames: "시작/종료 프레임",
};

let toastTimer;

function createElement(tag, { className, text, attributes } = {}) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (value !== undefined && value !== null) element.setAttribute(name, String(value));
  }
  return element;
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 4_000);
}

function setFormMessage(message = "") {
  elements.formMessage.textContent = message;
}

function updateConnectionStatus() {
  const ready = Boolean(state.config?.envKeyConfigured || state.apiKey);
  elements.connectionStatus.classList.toggle("is-ready", ready);
  elements.connectionLabel.textContent = ready ? "API 키 준비됨" : "API 키 입력 필요";
}

function spriteConstraintPrompt() {
  if (!state.sprite.enabled || !state.config?.sprite) return "";
  return state.config.sprite.promptTemplate
    .replace("{characterHeightPercent}", String(state.sprite.characterHeightPercent))
    .replace("{footAnchorPercent}", String(state.sprite.footAnchorPercent));
}

function userPromptLimit() {
  const constraint = spriteConstraintPrompt();
  return state.config ? state.config.limits.promptCharacters - (constraint ? constraint.length + 2 : 0) : 7_000;
}

function updatePromptCount() {
  const limit = userPromptLimit();
  elements.prompt.maxLength = limit;
  elements.promptCount.textContent = `${elements.prompt.value.length}/${limit}`;
}

function currentImages() {
  if (state.mode === "reference-image") return state.referenceImages;
  return [state.frames.first, state.frames.last].filter(Boolean);
}

function estimateCost({
  resolution = state.resolution,
  duration = state.duration,
  imageCount = currentImages().length,
} = {}) {
  const pricing = state.config?.pricing ?? { "2K": 0.13, "768P": 0.08, extraImage: 0.04, freeImages: 5 };
  const outputRate = pricing[resolution];
  const inputImageCost = Math.max(0, imageCount - pricing.freeImages) * pricing.extraImage;
  return Number((outputRate * duration + inputImageCost).toFixed(2));
}

function updateCost() {
  const imageCount = currentImages().length;
  elements.estimatedCost.textContent = `$${estimateCost().toFixed(2)}`;
  elements.costDetail.textContent = `${state.resolution} · ${state.duration}초 · 이미지 ${imageCount}장`;
}

function buildSegmentButtons(container, options, selectedValue, onSelect, {
  disabled = false,
  disabledOption = () => false,
  formatter = String,
} = {}) {
  const fragment = document.createDocumentFragment();
  for (const option of options) {
    const value = String(option);
    const button = createElement("button", {
      className: `segment-button${value === String(selectedValue) ? " is-selected" : ""}`,
      text: formatter(option),
      attributes: {
        type: "button",
        "aria-pressed": value === String(selectedValue),
      },
    });
    button.disabled = disabled || disabledOption(option);
    button.addEventListener("click", () => onSelect(option));
    fragment.append(button);
  }
  container.replaceChildren(fragment);
}

function renderRatioOptions() {
  if (state.mode === "frames") {
    buildSegmentButtons(elements.ratioOptions, ["adaptive"], "adaptive", () => {}, {
      disabled: true,
      formatter: () => "원본 비율",
    });
    elements.ratioNote.textContent = state.sprite.enabled
      ? "1:1 시작/종료 프레임을 그대로 사용해."
      : "프레임 이미지의 원본 비율을 사용해.";
    return;
  }

  buildSegmentButtons(elements.ratioOptions, state.config.ratios, state.ratio, (ratio) => {
    state.ratio = ratio;
    renderRatioOptions();
  }, { disabledOption: (ratio) => state.sprite.enabled && ratio !== "1:1" });
  elements.ratioNote.textContent = state.sprite.enabled
    ? "스프라이트 일관성 사용 중에는 1:1로 고정돼."
    : "참고 이미지 모드의 출력 비율이야.";
}

function renderSpriteOptions() {
  if (!state.config?.sprite) return;
  elements.spriteToggle.checked = state.sprite.enabled;
  elements.spriteControls.hidden = !state.sprite.enabled;
  buildSegmentButtons(
    elements.spriteHeightOptions,
    state.config.sprite.characterHeights,
    state.sprite.characterHeightPercent,
    (height) => {
      state.sprite.characterHeightPercent = height;
      renderSpriteOptions();
    },
    { formatter: (height) => `${height}%` },
  );
  buildSegmentButtons(
    elements.spriteFootOptions,
    state.config.sprite.footAnchors,
    state.sprite.footAnchorPercent,
    (footAnchor) => {
      state.sprite.footAnchorPercent = footAnchor;
      renderSpriteOptions();
    },
    { formatter: (footAnchor) => `${footAnchor}%` },
  );
  elements.spriteSummaryText.textContent = `중앙 고정 · 높이 ${state.sprite.characterHeightPercent}% · 발 ${state.sprite.footAnchorPercent}%`;
  elements.spritePromptPreview.textContent = spriteConstraintPrompt();
  updatePromptCount();
}

function setSpriteEnabled(enabled) {
  state.sprite.enabled = enabled;
  if (enabled && state.mode === "reference-image") state.ratio = "1:1";
  setFormMessage();
  renderSpriteOptions();
  renderRatioOptions();
}

function renderSettings() {
  renderRatioOptions();
  buildSegmentButtons(elements.resolutionOptions, state.config.resolutions, state.resolution, (resolution) => {
    state.resolution = resolution;
    renderSettings();
    updateCost();
  });
  buildSegmentButtons(elements.durationOptions, state.config.durations, state.duration, (duration) => {
    state.duration = duration;
    renderSettings();
    updateCost();
  }, { formatter: (duration) => `${duration}s` });
}

function setMode(mode) {
  if (!Object.values(state.config.modes).includes(mode)) return;
  state.mode = mode;
  for (const tab of elements.modeTabs) {
    const selected = tab.dataset.mode === mode;
    tab.classList.toggle("is-active", selected);
    tab.setAttribute("aria-selected", String(selected));
  }
  elements.referencePanel.hidden = mode !== "reference-image";
  elements.framesPanel.hidden = mode !== "frames";
  setFormMessage();
  renderRatioOptions();
  updateCost();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`${file.name}: 파일을 읽지 못했습니다.`));
    reader.readAsDataURL(file);
  });
}

function imageDimensions(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const dimensions = { width: image.naturalWidth, height: image.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(dimensions);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`${file.name}: 브라우저에서 이미지 크기를 확인하지 못했습니다. JPG, PNG 또는 WEBP로 변환해 주세요.`));
    };
    image.src = url;
  });
}

async function prepareImage(file, role) {
  const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
  if (!allowedTypes.has(file.type.toLowerCase())) throw new Error(`${file.name}: 지원하지 않는 이미지 형식입니다.`);
  if (file.size > state.config.limits.imageBytes) throw new Error(`${file.name}: 이미지 크기는 30MB 이하여야 합니다.`);

  const { width, height } = await imageDimensions(file);
  const ratio = width / height;
  if (width < 256 || width > 5760 || height < 256 || height > 5760) {
    throw new Error(`${file.name}: 가로와 세로는 각각 256~5760px여야 합니다.`);
  }
  if (ratio < 0.4 || ratio > 2.5) throw new Error(`${file.name}: 가로세로 비율은 2:5~5:2 범위여야 합니다.`);

  return {
    id: crypto.randomUUID(),
    role,
    name: file.name,
    type: file.type.toLowerCase(),
    size: file.size,
    width,
    height,
    dataUrl: await fileToDataUrl(file),
    previewUrl: URL.createObjectURL(file),
  };
}

function disposeImage(image) {
  if (image?.previewUrl) URL.revokeObjectURL(image.previewUrl);
}

function iconPath(pathData) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathData);
  svg.append(path);
  return svg;
}

function tileAction(label, icon, onClick, disabled = false) {
  const button = createElement("button", {
    className: "tile-action",
    attributes: { type: "button", "aria-label": label },
  });
  button.disabled = disabled;
  button.append(iconPath(icon));
  button.addEventListener("click", onClick);
  return button;
}

function moveReferenceImage(index, direction) {
  const target = index + direction;
  if (target < 0 || target >= state.referenceImages.length) return;
  [state.referenceImages[index], state.referenceImages[target]] = [state.referenceImages[target], state.referenceImages[index]];
  renderReferenceImages();
}

function removeReferenceImage(index) {
  const [removed] = state.referenceImages.splice(index, 1);
  disposeImage(removed);
  renderReferenceImages();
  updateCost();
}

function renderReferenceImages() {
  const fragment = document.createDocumentFragment();
  for (const [index, image] of state.referenceImages.entries()) {
    const tile = createElement("article", { className: "image-tile" });
    const preview = createElement("img", { attributes: { src: image.previewUrl, alt: `${image.name} 미리보기` } });
    const actions = createElement("div", { className: "tile-actions" });
    actions.append(
      tileAction("왼쪽으로 이동", "M15 18l-6-6 6-6", () => moveReferenceImage(index, -1), index === 0),
      tileAction("오른쪽으로 이동", "m9 18 6-6-6-6", () => moveReferenceImage(index, 1), index === state.referenceImages.length - 1),
      tileAction("이미지 제거", "m6 6 12 12M18 6 6 18", () => removeReferenceImage(index)),
    );
    const footer = createElement("div", { className: "image-tile-footer", text: image.name });
    tile.append(preview, actions, footer);
    fragment.append(tile);
  }

  if (state.referenceImages.length < state.config.limits.referenceImages) fragment.append(elements.referenceDropzone);
  elements.referenceGrid.replaceChildren(fragment);
  elements.referenceCount.textContent = `${state.referenceImages.length}/${state.config.limits.referenceImages}`;
}

async function addReferenceFiles(files) {
  const available = state.config.limits.referenceImages - state.referenceImages.length;
  const selected = [...files].slice(0, available);
  if (files.length > available) showToast(`참고 이미지는 최대 ${state.config.limits.referenceImages}장까지 추가할 수 있어.`);

  for (const file of selected) {
    try {
      state.referenceImages.push(await prepareImage(file, state.config.imageRoles.REFERENCE));
      renderReferenceImages();
      updateCost();
    } catch (error) {
      setFormMessage(error.message);
    }
  }
}

function frameSlotContents(slot, image, label, key) {
  const labelBadge = createElement("span", { className: "frame-label", text: label });
  if (!image) {
    const empty = createElement("span", { className: "frame-empty" });
    empty.append(iconPath("M12 5v14M5 12h14"), document.createTextNode("이미지 선택"));
    slot.replaceChildren(labelBadge, empty);
    return;
  }

  const preview = createElement("img", { attributes: { src: image.previewUrl, alt: `${label}: ${image.name}` } });
  const remove = createElement("button", {
    className: "frame-remove",
    attributes: { type: "button", "aria-label": `${label} 제거` },
  });
  remove.append(iconPath("m6 6 12 12M18 6 6 18"));
  remove.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    disposeImage(state.frames[key]);
    state.frames[key] = null;
    renderFrames();
    updateCost();
  });
  const filename = createElement("span", { className: "frame-file-name", text: image.name });
  slot.replaceChildren(preview, labelBadge, remove, filename);
}

function renderFrames() {
  frameSlotContents(elements.firstFrameSlot, state.frames.first, "시작 프레임", "first");
  frameSlotContents(elements.lastFrameSlot, state.frames.last, "종료 프레임", "last");
  elements.swapFrames.disabled = !(state.frames.first && state.frames.last);
}

async function setFrame(key, file) {
  if (!file) return;
  const role = key === "first" ? state.config.imageRoles.FIRST : state.config.imageRoles.LAST;
  try {
    const image = await prepareImage(file, role);
    disposeImage(state.frames[key]);
    state.frames[key] = image;
    renderFrames();
    updateCost();
    setFormMessage();
  } catch (error) {
    setFormMessage(error.message);
  }
}

function swapFrames() {
  if (!state.frames.first || !state.frames.last) return;
  [state.frames.first, state.frames.last] = [state.frames.last, state.frames.first];
  state.frames.first.role = state.config.imageRoles.FIRST;
  state.frames.last.role = state.config.imageRoles.LAST;
  renderFrames();
}

function apiHeaders({ json = false } = {}) {
  const headers = {};
  if (json) headers["Content-Type"] = "application/json";
  if (state.apiKey) headers["X-MiniMax-API-Key"] = state.apiKey;
  return headers;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `요청에 실패했습니다. (${response.status})`);
  return body;
}

function generationInput() {
  const prompt = elements.prompt.value.trim();
  if (!prompt) throw new Error("프롬프트를 입력해 주세요.");
  if (!state.config.envKeyConfigured && !state.apiKey) throw new Error("API 설정에서 MiniMax API 키를 입력해 주세요.");

  const images = currentImages();
  if (state.mode === "reference-image" && images.length === 0) throw new Error("참고 이미지를 한 장 이상 추가해 주세요.");
  if (state.mode === "frames" && images.length === 0) throw new Error("시작 또는 종료 프레임을 추가해 주세요.");

  if (state.mode === "frames" && images.length === 2) {
    const ratios = images.map((image) => image.width / image.height);
    const difference = Math.abs(ratios[0] - ratios[1]);
    if (difference / Math.max(...ratios) > 0.02) throw new Error("시작 프레임과 종료 프레임의 비율을 같게 맞춰 주세요.");
  }

  if (state.sprite.enabled) {
    if (state.mode === "reference-image" && state.ratio !== "1:1") {
      throw new Error("스프라이트 일관성은 1:1 비율에서만 사용할 수 있어.");
    }
    if (state.mode === "frames" && images.some((image) => Math.abs(image.width / image.height - 1) > 0.02)) {
      throw new Error("스프라이트 일관성은 1:1 시작/종료 프레임만 사용할 수 있어.");
    }
  }

  if (prompt.length > userPromptLimit()) {
    throw new Error("자동 스프라이트 제약을 포함한 프롬프트는 7,000자 이하여야 해.");
  }

  const input = {
    mode: state.mode,
    prompt,
    resolution: state.resolution,
    duration: state.duration,
    ratio: state.ratio,
    sprite: { ...state.sprite },
    images: images.map(({ role, name, type, dataUrl, width, height }) => ({ role, name, type, dataUrl, width, height })),
  };
  if (new Blob([JSON.stringify(input)]).size > state.config.limits.requestBytes) throw new Error("전체 요청 크기는 64MB 이하여야 합니다.");
  return input;
}

function newTask(taskId, input) {
  return {
    id: taskId,
    status: "queued",
    mode: input.mode,
    resolution: input.resolution,
    duration: input.duration,
    ratio: input.mode === "frames" ? "원본 비율" : input.ratio,
    imageCount: input.images.length,
    cost: estimateCost({ resolution: input.resolution, duration: input.duration, imageCount: input.images.length }),
    prompt: input.prompt,
    spriteHeight: input.sprite.enabled ? input.sprite.characterHeightPercent : null,
    error: "",
  };
}

function taskById(taskId) {
  return state.tasks.find((task) => task.id === taskId);
}

function setResultStatus(status, label = STATUS_LABELS[status] ?? "준비됨") {
  elements.resultStatus.textContent = label;
  elements.resultStatus.classList.toggle("is-running", status === "queued" || status === "running" || status === "submitting");
  elements.resultStatus.classList.toggle("is-success", status === "succeeded");
  elements.resultStatus.classList.toggle("is-error", status === "failed" || status === "cancelled");
}

function setPreviewEmpty(title, description) {
  const strong = elements.previewEmpty.querySelector("strong");
  const span = elements.previewEmpty.querySelector("span");
  strong.textContent = title;
  span.textContent = description;
  elements.previewEmpty.hidden = false;
  elements.resultVideo.hidden = true;
  elements.resultVideo.removeAttribute("src");
  elements.resultVideo.load();
}

function selectTask(taskId) {
  const task = taskById(taskId);
  if (!task) return;
  state.activeTaskId = taskId;
  elements.activeTask.hidden = false;
  elements.activeTask.classList.toggle("is-complete", task.status === "succeeded");
  elements.activeTask.classList.toggle("is-error", task.status === "failed" || task.status === "cancelled");
  elements.activeTaskLabel.textContent = STATUS_LABELS[task.status] ?? task.status;
  elements.activeTaskId.textContent = task.id;
  setResultStatus(task.status);

  if (task.status === "succeeded") {
    elements.previewEmpty.hidden = true;
    elements.resultVideo.src = `/api/tasks/${encodeURIComponent(task.id)}/media`;
    elements.resultVideo.hidden = false;
    elements.downloadButton.href = `/api/tasks/${encodeURIComponent(task.id)}/media?download=1`;
    elements.downloadButton.hidden = false;
  } else {
    elements.downloadButton.hidden = true;
    const title = task.status === "failed" || task.status === "cancelled" ? "영상을 완성하지 못했어" : "MiniMax가 영상을 만들고 있어";
    const description = task.error || "작업 상태를 10초마다 자동으로 확인해.";
    setPreviewEmpty(title, description);
  }
}

function renderHistory() {
  if (state.tasks.length === 0) {
    const row = createElement("tr", { className: "empty-row" });
    const cell = createElement("td", { text: "아직 생성한 작업이 없어.", attributes: { colspan: "6" } });
    row.append(cell);
    elements.historyBody.replaceChildren(row);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const task of state.tasks) {
    const row = document.createElement("tr");
    const statusCell = document.createElement("td");
    statusCell.append(createElement("span", {
      className: `history-status ${task.status}`,
      text: STATUS_LABELS[task.status] ?? task.status,
    }));
    const modeCell = createElement("td", { text: MODE_LABELS[task.mode] });
    const spriteLabel = task.spriteHeight ? ` · 스프라이트 ${task.spriteHeight}%` : "";
    const settingsCell = createElement("td", { text: `${task.resolution} · ${task.ratio} · ${task.duration}초${spriteLabel}` });
    const costCell = createElement("td", { text: `$${task.cost.toFixed(2)}` });
    const idCell = createElement("td", { className: "history-task-id", text: task.id });
    const actionCell = document.createElement("td");
    const action = createElement("button", { className: "table-action", text: "보기", attributes: { type: "button" } });
    action.addEventListener("click", () => selectTask(task.id));
    actionCell.append(action);
    row.append(statusCell, modeCell, settingsCell, costCell, idCell, actionCell);
    fragment.append(row);
  }
  elements.historyBody.replaceChildren(fragment);
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Polling stopped", "AbortError"));
    }, { once: true });
  });
}

async function pollTask(taskId) {
  const controller = new AbortController();
  state.pollControllers.set(taskId, controller);

  try {
    await delay(1_200, controller.signal);
    while (!controller.signal.aborted) {
      const body = await requestJson(`/api/tasks/${encodeURIComponent(taskId)}`, {
        headers: apiHeaders(),
        signal: controller.signal,
      });
      const task = taskById(taskId);
      if (!task) return;

      task.status = body.task?.status || "running";
      task.error = body.task?.error?.message || body.task?.error || "";
      renderHistory();
      if (state.activeTaskId === taskId) selectTask(taskId);

      if (["succeeded", "failed", "cancelled"].includes(task.status)) {
        if (task.status === "succeeded") showToast("영상 생성이 완료됐어.");
        return;
      }

      await delay(10_000, controller.signal);
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    const task = taskById(taskId);
    if (task) {
      task.status = "failed";
      task.error = error.message;
      renderHistory();
      if (state.activeTaskId === taskId) selectTask(taskId);
    }
  } finally {
    state.pollControllers.delete(taskId);
  }
}

async function generateVideo() {
  setFormMessage();
  let input;
  try {
    input = generationInput();
  } catch (error) {
    setFormMessage(error.message);
    if (error.message.includes("API 키")) elements.settingsDialog.showModal();
    return;
  }

  elements.generateButton.disabled = true;
  setResultStatus("submitting", "요청 중");
  setPreviewEmpty("MiniMax에 작업을 보내고 있어", "잠시만 기다려 줘.");

  try {
    const body = await requestJson("/api/tasks", {
      method: "POST",
      headers: apiHeaders({ json: true }),
      body: JSON.stringify(input),
    });
    const task = newTask(body.taskId, input);
    state.tasks.unshift(task);
    state.activeTaskId = task.id;
    renderHistory();
    selectTask(task.id);
    void pollTask(task.id);
  } catch (error) {
    setResultStatus("failed");
    setPreviewEmpty("요청을 보내지 못했어", error.message);
    setFormMessage(error.message);
  } finally {
    elements.generateButton.disabled = false;
  }
}

function bindDropzone() {
  for (const eventName of ["dragenter", "dragover"]) {
    elements.referenceDropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.referenceDropzone.classList.add("is-dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    elements.referenceDropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.referenceDropzone.classList.remove("is-dragging");
    });
  }
  elements.referenceDropzone.addEventListener("drop", (event) => {
    void addReferenceFiles(event.dataTransfer.files);
  });
}

function bindEvents() {
  for (const tab of elements.modeTabs) tab.addEventListener("click", () => setMode(tab.dataset.mode));

  elements.referenceInput.addEventListener("change", (event) => {
    void addReferenceFiles(event.target.files);
    event.target.value = "";
  });
  elements.firstFrameInput.addEventListener("change", (event) => {
    void setFrame("first", event.target.files[0]);
    event.target.value = "";
  });
  elements.lastFrameInput.addEventListener("change", (event) => {
    void setFrame("last", event.target.files[0]);
    event.target.value = "";
  });
  elements.swapFrames.addEventListener("click", swapFrames);
  elements.prompt.addEventListener("input", updatePromptCount);
  elements.spriteToggle.addEventListener("change", () => setSpriteEnabled(elements.spriteToggle.checked));
  elements.generateButton.addEventListener("click", generateVideo);
  bindDropzone();

  elements.openSettings.addEventListener("click", () => {
    elements.apiKey.value = state.apiKey;
    elements.settingsDialog.showModal();
  });
  elements.toggleKey.addEventListener("click", () => {
    const visible = elements.apiKey.type === "text";
    elements.apiKey.type = visible ? "password" : "text";
    elements.toggleKey.textContent = visible ? "보기" : "숨기기";
    elements.toggleKey.setAttribute("aria-label", visible ? "API 키 보이기" : "API 키 숨기기");
  });
  elements.applyKey.addEventListener("click", (event) => {
    event.preventDefault();
    state.apiKey = elements.apiKey.value.trim();
    elements.apiKey.value = "";
    elements.settingsDialog.close();
    updateConnectionStatus();
    showToast(state.apiKey ? "이 탭에서 사용할 API 키를 적용했어." : "입력된 API 키를 비웠어.");
  });
  elements.settingsDialog.addEventListener("close", () => {
    elements.apiKey.value = "";
    elements.apiKey.type = "password";
    elements.toggleKey.textContent = "보기";
  });

  window.addEventListener("beforeunload", () => {
    for (const controller of state.pollControllers.values()) controller.abort();
    for (const image of state.referenceImages) disposeImage(image);
    disposeImage(state.frames.first);
    disposeImage(state.frames.last);
  });
}

async function initialize() {
  bindEvents();
  try {
    state.config = await requestJson("/api/config");
    state.mode = state.config.defaults.mode;
    state.resolution = state.config.defaults.resolution;
    state.ratio = state.config.defaults.ratio;
    state.duration = state.config.defaults.duration;
    state.sprite = { ...state.config.sprite.defaults };
    elements.envKeyNotice.hidden = !state.config.envKeyConfigured;
    elements.connectionStatus.classList.add("is-ready");
    elements.connectionLabel.textContent = state.config.envKeyConfigured ? "환경 키 준비됨" : "로컬 서버 연결됨";
    renderReferenceImages();
    renderFrames();
    renderSettings();
    renderSpriteOptions();
    updateCost();
    updatePromptCount();
    setMode(state.mode);
  } catch (error) {
    elements.connectionLabel.textContent = "서버 연결 실패";
    setFormMessage(`로컬 서버에 연결하지 못했습니다: ${error.message}`);
    elements.generateButton.disabled = true;
  }
}

void initialize();
