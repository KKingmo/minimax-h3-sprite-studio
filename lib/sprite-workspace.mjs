import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  SPRITE_LIMITS,
  normalizeExportSettings,
  normalizeExtractionSettings,
  publicSpriteConfig,
  safeVideoFilename,
} from "./sprite-contract.mjs";

const MANIFEST_NAME = "job.json";
const MAX_RUNNER_OUTPUT_BYTES = 4 * 1024 * 1024;
const PROGRESS_PREFIX = "SPRITE_PROGRESS ";

function sanitizeText(value, limit = 500) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, limit);
}

function sanitizeGeneration(value) {
  if (!value || typeof value !== "object") return null;
  const safe = {};
  if (["reference-image", "frames"].includes(value.mode)) safe.mode = value.mode;
  if (["2K", "768P"].includes(value.resolution)) safe.resolution = value.resolution;
  if (Number.isInteger(value.duration) && value.duration >= 4 && value.duration <= 15) safe.duration = value.duration;
  if (typeof value.ratio === "string") safe.ratio = sanitizeText(value.ratio, 24);
  if (Number.isInteger(value.imageCount) && value.imageCount >= 0 && value.imageCount <= 9) safe.imageCount = value.imageCount;
  return Object.keys(safe).length ? safe : null;
}

function inside(root, candidate) {
  const normalizedRoot = resolve(root);
  const normalized = resolve(candidate);
  if (normalized !== normalizedRoot && !normalized.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error("허용된 로컬 작업 폴더 밖의 경로입니다.");
  }
  return normalized;
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function defaultPythonRunner({ pythonPath, workerPath, workspaceDir, action, payload, onProgress }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(pythonPath, [workerPath, action, "--workspace", workspaceDir], {
      cwd: dirname(workerPath),
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        HF_HOME: join(workspaceDir, "model-cache"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stderrDecoder = new StringDecoder("utf8");
    let stderrRemainder = "";
    const progressWrites = [];

    function handleStderrText(text, flush = false) {
      stderrRemainder += text;
      const lines = stderrRemainder.split("\n");
      const trailing = lines.pop() ?? "";
      stderrRemainder = flush ? "" : trailing;
      if (flush && trailing) lines.push(trailing);
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "");
        if (line.startsWith(PROGRESS_PREFIX)) {
          try {
            const event = JSON.parse(line.slice(PROGRESS_PREFIX.length));
            if (event?.type === "progress" && onProgress) {
              progressWrites.push(Promise.resolve(onProgress(event)));
              continue;
            }
          } catch {
            // Keep malformed progress output as diagnostic stderr.
          }
        }
        if (!line) continue;
        const chunk = Buffer.from(`${line}\n`);
        stderrBytes += chunk.length;
        if (stderrBytes <= MAX_RUNNER_OUTPUT_BYTES) stderr.push(chunk);
      }
    }

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_RUNNER_OUTPUT_BYTES) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      handleStderrText(stderrDecoder.write(chunk));
    });
    child.on("error", rejectRun);
    child.on("close", async (code) => {
      handleStderrText(stderrDecoder.end(), true);
      await Promise.allSettled(progressWrites);
      let response;
      try {
        response = JSON.parse(Buffer.concat(stdout).toString("utf8"));
      } catch {
        response = null;
      }
      if (code === 0 && response?.ok) {
        resolveRun(response.result);
        return;
      }
      const safeError = sanitizeText(response?.error || Buffer.concat(stderr).toString("utf8"), 700);
      rejectRun(new Error(safeError || "Python 스프라이트 엔진 실행에 실패했습니다."));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function fileUrl(jobId, relativePath) {
  if (!relativePath) return null;
  const encoded = String(relativePath).split(/[\\/]/).map(encodeURIComponent).join("/");
  return `/api/sprite/jobs/${encodeURIComponent(jobId)}/files/${encoded}`;
}

function clientJob(job) {
  const copy = structuredClone(job);
  if (copy.source?.relativePath) copy.source.videoUrl = fileUrl(copy.id, copy.source.relativePath);
  if (copy.extraction?.previewPath) copy.extraction.previewUrl = fileUrl(copy.id, copy.extraction.previewPath);
  if (Array.isArray(copy.extraction?.framePaths)) {
    copy.extraction.frameUrls = copy.extraction.framePaths.map((path) => fileUrl(copy.id, path));
  }
  if (copy.result?.files) {
    copy.result.fileUrls = Object.fromEntries(
      Object.entries(copy.result.files).map(([name, path]) => [name, fileUrl(copy.id, path)]),
    );
  }
  return copy;
}

function allowedFiles(job) {
  const files = new Set();
  if (job.source?.relativePath) files.add(job.source.relativePath);
  if (job.extraction?.previewPath) files.add(job.extraction.previewPath);
  for (const path of job.extraction?.framePaths ?? []) files.add(path);
  for (const path of Object.values(job.result?.files ?? {})) files.add(path);
  return files;
}

export function createSpriteWorkspace({
  rootDir,
  pythonPath,
  workerPath,
  pythonRunner = defaultPythonRunner,
  now = () => new Date(),
} = {}) {
  if (!rootDir || !pythonPath || !workerPath) throw new TypeError("sprite workspace paths are required");
  const workspaceDir = resolve(rootDir);
  const jobsDir = join(workspaceDir, "jobs");
  const activeJobIds = new Set();
  let operationQueue = Promise.resolve();

  async function initialize() {
    await mkdir(jobsDir, { recursive: true });
  }

  async function installed() {
    return (await exists(pythonPath)) && (await exists(workerPath));
  }

  async function requireInstalled() {
    if (!(await installed())) {
      const error = new Error("스프라이트 엔진이 설치되지 않았습니다. pnpm setup:sprite를 먼저 실행해 주세요.");
      error.statusCode = 503;
      throw error;
    }
  }

  async function readJob(jobId) {
    const id = String(jobId ?? "");
    if (!/^[A-Za-z0-9_-]{8,96}$/.test(id)) throw new Error("작업 ID가 올바르지 않습니다.");
    const manifestPath = inside(jobsDir, join(jobsDir, id, MANIFEST_NAME));
    let parsed;
    try {
      parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      const error = new Error("스프라이트 작업을 찾을 수 없습니다.");
      error.statusCode = 404;
      throw error;
    }
    return parsed;
  }

  async function saveJob(job) {
    job.updatedAt = now().toISOString();
    const manifestPath = inside(jobsDir, join(jobsDir, job.id, MANIFEST_NAME));
    await atomicJson(manifestPath, job);
    return job;
  }

  async function listJobs() {
    await initialize();
    const entries = await readdir(jobsDir, { withFileTypes: true });
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const job = await readJob(entry.name);
        if (["extracting", "exporting"].includes(job.status) && !activeJobIds.has(job.id)) {
          const interruptedStage = job.status === "exporting" ? "export" : "extract";
          job.status = "error";
          job.progress = null;
          job.error = {
            stage: interruptedStage,
            message: "서버가 작업 도중 종료되었습니다. 보존된 입력으로 같은 단계를 다시 실행해 주세요.",
          };
          await saveJob(job);
        }
        jobs.push(job);
      } catch {
        // Ignore incomplete local folders; they remain available for manual diagnosis.
      }
    }
    jobs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    return jobs.map(clientJob);
  }

  async function findByTaskId(taskId) {
    if (!taskId) return null;
    const jobs = await listJobs();
    return jobs.find((job) => job.source?.type === "minimax" && job.source?.taskId === String(taskId)) ?? null;
  }

  async function createJob({ type, filename, taskId = null, prompt = "", generation = null } = {}) {
    await initialize();
    if (!["upload", "minimax"].includes(type)) {
      const error = new Error("지원하지 않는 영상 입력 방식입니다.");
      error.statusCode = 400;
      throw error;
    }
    const safeFilename = safeVideoFilename(filename);
    const id = `sprite-${now().getTime().toString(36)}-${randomUUID().slice(0, 8)}`;
    const jobDir = inside(jobsDir, join(jobsDir, id));
    await mkdir(join(jobDir, "source"), { recursive: true });
    const relativePath = join("source", safeFilename);
    const timestamp = now().toISOString();
    const job = {
      schemaVersion: 1,
      id,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "awaiting-video",
      source: {
        type,
        name: safeFilename,
        relativePath,
        ...(taskId ? { taskId: sanitizeText(taskId, 128) } : {}),
        ...(prompt ? { prompt: sanitizeText(prompt, 7000) } : {}),
        ...(sanitizeGeneration(generation) ? { generation: sanitizeGeneration(generation) } : {}),
      },
      videoInfo: null,
      extraction: null,
      spriteSettings: null,
      result: null,
      progress: null,
      error: null,
    };
    await atomicJson(join(jobDir, MANIFEST_NAME), job);
    return job;
  }

  async function writeVideo(jobId, chunks, { contentLength } = {}) {
    const job = await readJob(jobId);
    if (Number.isFinite(contentLength) && contentLength > SPRITE_LIMITS.maxVideoBytes) {
      const error = new Error("영상은 1GB 이하 파일만 사용할 수 있습니다.");
      error.statusCode = 413;
      throw error;
    }
    const jobDir = inside(jobsDir, join(jobsDir, job.id));
    const destination = inside(jobDir, join(jobDir, job.source.relativePath));
    const temporary = `${destination}.upload`;
    const handle = await open(temporary, "w", 0o600);
    let received = 0;
    try {
      for await (const chunk of chunks) {
        received += chunk.length;
        if (received > SPRITE_LIMITS.maxVideoBytes) {
          const error = new Error("영상은 1GB 이하 파일만 사용할 수 있습니다.");
          error.statusCode = 413;
          throw error;
        }
        await handle.write(chunk);
      }
      if (received === 0) throw new Error("업로드한 영상이 비어 있습니다.");
    } catch (error) {
      await handle.close();
      await rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    await rename(temporary, destination);
    job.status = "video-ready";
    job.source.bytes = received;
    await saveJob(job);
    return clientJob(job);
  }

  function runExclusive(task) {
    const running = operationQueue.then(task, task);
    operationQueue = running.catch(() => undefined);
    return running;
  }

  async function runTracked(jobId, task) {
    activeJobIds.add(jobId);
    try {
      return await task();
    } finally {
      activeJobIds.delete(jobId);
    }
  }

  async function runPython(action, payload, onProgress) {
    await requireInstalled();
    return pythonRunner({ pythonPath, workerPath, workspaceDir, action, payload, onProgress });
  }

  function progressRecorder(job, stage) {
    let saveChain = Promise.resolve();
    return {
      update(event) {
        const value = Math.max(0, Math.min(1, Number(event?.value) || 0));
        job.progress = {
          stage,
          value,
          description: sanitizeText(event?.description, 180) || "처리하고 있습니다.",
          startedAt: job.progress?.startedAt ?? now().toISOString(),
        };
        saveChain = saveChain
          .catch(() => undefined)
          .then(() => saveJob(job).catch(() => undefined));
        return saveChain;
      },
      flush() {
        return saveChain;
      },
    };
  }

  async function inspectJob(jobId) {
    const job = await readJob(jobId);
    const jobDir = inside(jobsDir, join(jobsDir, job.id));
    const videoPath = inside(jobDir, join(jobDir, job.source.relativePath));
    job.videoInfo = await runPython("inspect", { videoPath });
    await saveJob(job);
    return clientJob(job);
  }

  async function extract(jobId, input) {
    const settings = normalizeExtractionSettings(input);
    return runExclusive(() => runTracked(jobId, async () => {
      const job = await readJob(jobId);
      const jobDir = inside(jobsDir, join(jobsDir, job.id));
      const videoPath = inside(jobDir, join(jobDir, job.source.relativePath));
      job.status = "extracting";
      job.error = null;
      job.result = null;
      job.progress = {
        stage: "extract",
        value: 0,
        description: "프레임 추출을 준비하고 있습니다.",
        startedAt: now().toISOString(),
      };
      await saveJob(job);
      const progress = progressRecorder(job, "extract");
      try {
        const extraction = await runPython("extract", { jobDir, videoPath, ...settings }, progress.update);
        await progress.flush();
        job.extraction = extraction;
        job.status = "frames-ready";
        job.progress = null;
        job.spriteSettings = { ...(job.spriteSettings ?? {}), ...settings };
        await saveJob(job);
        return clientJob(job);
      } catch (error) {
        await progress.flush();
        job.status = "error";
        job.progress = null;
        job.error = { stage: "extract", message: sanitizeText(error.message, 700) };
        await saveJob(job);
        throw error;
      }
    }));
  }

  async function exportJob(jobId, input) {
    const settings = normalizeExportSettings(input);
    return runExclusive(() => runTracked(jobId, async () => {
      const job = await readJob(jobId);
      if (!job.extraction) throw new Error("먼저 프레임을 펼쳐 확인해 주세요.");
      const jobDir = inside(jobsDir, join(jobsDir, job.id));
      job.status = "exporting";
      job.error = null;
      job.progress = {
        stage: "export",
        value: 0,
        description: "BiRefNet 배경 제거를 준비하고 있습니다.",
        startedAt: now().toISOString(),
      };
      job.spriteSettings = { ...(job.spriteSettings ?? {}), ...settings };
      await saveJob(job);
      const progress = progressRecorder(job, "export");
      try {
        job.result = await runPython("export", { jobDir, extraction: job.extraction, ...settings }, progress.update);
        await progress.flush();
        job.status = "complete";
        job.progress = null;
        job.extraction = {
          ...job.extraction,
          frameCount: job.extraction.framePaths?.length ?? 0,
          framePaths: [],
          previewPath: null,
          cleaned: true,
        };
        if (job.source.type === "upload" && job.source.relativePath) {
          await rm(inside(jobDir, join(jobDir, job.source.relativePath)), { force: true });
          job.source.relativePath = null;
          job.source.removedAfterExport = true;
        }
        await saveJob(job);
        return clientJob(job);
      } catch (error) {
        await progress.flush();
        job.status = "error";
        job.progress = null;
        job.error = { stage: "export", message: sanitizeText(error.message, 700) };
        await saveJob(job);
        throw error;
      }
    }));
  }

  async function getJob(jobId) {
    return clientJob(await readJob(jobId));
  }

  async function deleteJob(jobId) {
    const job = await readJob(jobId);
    await rm(inside(jobsDir, join(jobsDir, job.id)), { recursive: true, force: true });
  }

  async function deleteAllJobs() {
    await rm(jobsDir, { recursive: true, force: true });
    await mkdir(jobsDir, { recursive: true });
  }

  async function filePath(jobId, requestedRelativePath) {
    const job = await readJob(jobId);
    const normalizedRelative = String(requestedRelativePath ?? "").split(/[\\/]/).filter(Boolean).join(sep);
    if (!allowedFiles(job).has(normalizedRelative)) {
      const error = new Error("이 작업에서 공개할 수 없는 파일입니다.");
      error.statusCode = 404;
      throw error;
    }
    const jobDir = inside(jobsDir, join(jobsDir, job.id));
    const path = inside(jobDir, join(jobDir, normalizedRelative));
    const info = await stat(path);
    if (!info.isFile()) throw new Error("결과 파일을 찾을 수 없습니다.");
    return { path, size: info.size, name: normalizedRelative.split(sep).pop() };
  }

  async function config() {
    return publicSpriteConfig({ installed: await installed() });
  }

  return {
    initialize,
    config,
    listJobs,
    findByTaskId,
    createJob,
    writeVideo,
    inspectJob,
    extract,
    exportJob,
    getJob,
    deleteJob,
    deleteAllJobs,
    filePath,
    paths: { workspaceDir, jobsDir, pythonPath, workerPath },
  };
}
