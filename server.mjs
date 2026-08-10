import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  H3ValidationError,
  LIMITS,
  buildH3Payload,
  publicConfig,
} from "./lib/h3-contract.mjs";
import { createSpriteWorkspace } from "./lib/sprite-workspace.mjs";

const ROOT_DIR = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_PUBLIC_DIR = join(ROOT_DIR, "public");
const DEFAULT_API_BASE_URL = "https://api.minimax.io";
const DEFAULT_WORKSPACE_DIR = join(ROOT_DIR, "workspace");
const DEFAULT_PYTHON_PATH = process.platform === "win32"
  ? join(ROOT_DIR, ".venv", "Scripts", "python.exe")
  : join(ROOT_DIR, ".venv", "bin", "python");
const DEFAULT_SPRITE_WORKER_PATH = join(ROOT_DIR, "sprite_engine", "worker.py");
const STATIC_ROUTES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/app.js", "app.js"],
]);
const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".zip", "application/zip"],
]);

function sendJson(response, statusCode, body) {
  const json = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    "Cache-Control": "no-store",
  });
  response.end(json);
}

function sanitizeMessage(value, fallback = "요청을 처리하지 못했습니다.") {
  const message = typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").trim() : "";
  return (message || fallback).slice(0, 400);
}

function upstreamErrorMessage(statusCode, body) {
  const explicit = body?.error?.message ?? body?.message ?? body?.base_resp?.status_msg;
  if (statusCode === 401) return "API 키가 올바르지 않습니다.";
  if (statusCode === 402) return "MiniMax 잔액이 부족합니다.";
  if (statusCode === 422) return "프롬프트 또는 이미지가 안전 정책에 의해 거부되었습니다.";
  if (statusCode === 429) return "요청이 많습니다. 잠시 후 다시 시도해 주세요.";
  if (explicit) return sanitizeMessage(explicit);
  return `MiniMax API 요청에 실패했습니다. (${statusCode})`;
}

async function readJsonBody(request, byteLimit = LIMITS.requestBytes) {
  const chunks = [];
  let received = 0;

  for await (const chunk of request) {
    received += chunk.length;
    if (received > byteLimit) {
      const error = new H3ValidationError("요청 크기는 64MB 이하여야 합니다.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) throw new H3ValidationError("요청 본문이 비어 있습니다.");

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new H3ValidationError("JSON 요청 본문이 올바르지 않습니다.");
  }
}

async function readResponseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: sanitizeMessage(text) };
  }
}

function apiKeyFor(request, environmentKey) {
  const headerKey = request.headers["x-minimax-api-key"];
  const key = (Array.isArray(headerKey) ? headerKey[0] : headerKey)?.trim() || environmentKey?.trim();
  if (!key) {
    const error = new H3ValidationError("API 키를 설정해 주세요.");
    error.statusCode = 401;
    throw error;
  }
  return key;
}

function commonSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
}

async function serveStatic(response, publicDir, pathname) {
  const filename = STATIC_ROUTES.get(pathname);
  if (!filename) return false;

  const filepath = join(publicDir, filename);
  const info = await stat(filepath);
  response.writeHead(200, {
    "Content-Type": MIME_TYPES.get(extname(filepath)) ?? "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": "no-cache",
  });
  createReadStream(filepath).pipe(response);
  return true;
}

function taskIdFromPath(pathname, suffix = "") {
  const pattern = suffix
    ? new RegExp(`^/api/tasks/([A-Za-z0-9_-]{1,128})/${suffix}$`)
    : /^\/api\/tasks\/([A-Za-z0-9_-]{1,128})$/;
  return pattern.exec(pathname)?.[1] ?? null;
}

function spriteJobRoute(pathname) {
  const match = /^\/api\/sprite\/jobs\/([A-Za-z0-9_-]{8,96})(?:\/(.*))?$/.exec(pathname);
  if (!match) return null;
  return { jobId: match[1], suffix: match[2] ?? "" };
}

function contentLength(request) {
  const value = Number(request.headers["content-length"]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sendFile(response, file, { download = false } = {}) {
  response.writeHead(200, {
    "Content-Type": MIME_TYPES.get(extname(file.path).toLowerCase()) ?? "application/octet-stream",
    "Content-Length": file.size,
    "Cache-Control": "private, no-store",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${String(file.name).replace(/["\\\r\n]/g, "-")}"`,
  });
  createReadStream(file.path).pipe(response);
}

export function createH3Server({
  fetchImpl = globalThis.fetch,
  apiBaseUrl = process.env.MINIMAX_API_BASE_URL || DEFAULT_API_BASE_URL,
  environmentKey = process.env.MINIMAX_API_KEY || "",
  publicDir = DEFAULT_PUBLIC_DIR,
  spriteWorkspace = null,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  const completedMedia = new Map();
  const sprites = spriteWorkspace ?? createSpriteWorkspace({
    rootDir: DEFAULT_WORKSPACE_DIR,
    pythonPath: DEFAULT_PYTHON_PATH,
    workerPath: DEFAULT_SPRITE_WORKER_PATH,
  });

  const server = createServer(async (request, response) => {
    commonSecurityHeaders(response);

    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const { pathname } = url;

      if (request.method === "GET" && pathname === "/api/config") {
        sendJson(response, 200, publicConfig({ envKeyConfigured: Boolean(environmentKey.trim()) }));
        return;
      }

      if (request.method === "GET" && pathname === "/api/sprite/config") {
        sendJson(response, 200, await sprites.config());
        return;
      }

      if (request.method === "GET" && pathname === "/api/sprite/jobs") {
        sendJson(response, 200, { jobs: await sprites.listJobs() });
        return;
      }

      if (request.method === "DELETE" && pathname === "/api/sprite/jobs") {
        await sprites.deleteAllJobs();
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && pathname === "/api/sprite/jobs/upload") {
        const encodedFilename = request.headers["x-video-filename"];
        let filename;
        try {
          filename = decodeURIComponent(Array.isArray(encodedFilename) ? encodedFilename[0] : encodedFilename ?? "");
        } catch {
          const error = new Error("영상 파일 이름이 올바르지 않습니다.");
          error.statusCode = 400;
          throw error;
        }
        const job = await sprites.createJob({ type: "upload", filename });
        try {
          await sprites.writeVideo(job.id, request, { contentLength: contentLength(request) });
          let inspected;
          try {
            inspected = await sprites.inspectJob(job.id);
          } catch {
            inspected = await sprites.getJob(job.id);
          }
          sendJson(response, 201, { job: inspected });
        } catch (error) {
          await sprites.deleteJob(job.id).catch(() => undefined);
          throw error;
        }
        return;
      }

      if (request.method === "POST" && pathname === "/api/sprite/jobs/from-task") {
        const input = await readJsonBody(request, 64 * 1024);
        const taskId = String(input.taskId ?? "");
        const mediaUrl = completedMedia.get(taskId);
        if (!mediaUrl) {
          const error = new H3ValidationError("완료된 MiniMax 영상을 찾을 수 없습니다. 작업 상태를 다시 확인해 주세요.");
          error.statusCode = 404;
          throw error;
        }
        const existing = await sprites.findByTaskId(taskId);
        if (existing) {
          sendJson(response, 200, { job: existing });
          return;
        }
        const job = await sprites.createJob({
          type: "minimax",
          filename: `minimax-h3-${taskId}.mp4`,
          taskId,
          prompt: input.prompt,
          generation: input.generation,
        });
        try {
          const upstream = await fetchImpl(mediaUrl);
          if (!upstream.ok || !upstream.body) throw new Error("생성된 MiniMax 영상을 로컬 작업 폴더에 연결하지 못했습니다.");
          await sprites.writeVideo(job.id, Readable.fromWeb(upstream.body), {
            contentLength: Number(upstream.headers.get("content-length")) || undefined,
          });
          let inspected;
          try {
            inspected = await sprites.inspectJob(job.id);
          } catch {
            inspected = await sprites.getJob(job.id);
          }
          sendJson(response, 201, { job: inspected });
        } catch (error) {
          await sprites.deleteJob(job.id).catch(() => undefined);
          throw error;
        }
        return;
      }

      if (request.method === "POST" && pathname === "/api/tasks") {
        const apiKey = apiKeyFor(request, environmentKey);
        const input = await readJsonBody(request);
        const payload = buildH3Payload(input);
        const upstream = await fetchImpl(`${apiBaseUrl}/v2/video_generation`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        const body = await readResponseJson(upstream);

        if (!upstream.ok) {
          sendJson(response, upstream.status, { error: { message: upstreamErrorMessage(upstream.status, body), status: upstream.status } });
          return;
        }

        if (!body.task_id) {
          sendJson(response, 502, { error: { message: "MiniMax가 task_id를 반환하지 않았습니다.", status: 502 } });
          return;
        }

        sendJson(response, 201, { taskId: String(body.task_id) });
        return;
      }

      const taskId = taskIdFromPath(pathname);
      if (request.method === "GET" && taskId) {
        const apiKey = apiKeyFor(request, environmentKey);
        const upstream = await fetchImpl(`${apiBaseUrl}/v2/query/video_generation/${encodeURIComponent(taskId)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        const body = await readResponseJson(upstream);

        if (!upstream.ok) {
          sendJson(response, upstream.status, { error: { message: upstreamErrorMessage(upstream.status, body), status: upstream.status } });
          return;
        }

        const task = body.task ?? {};
        if (task.status === "succeeded" && typeof task.content?.url === "string") {
          completedMedia.set(taskId, task.content.url);
        }
        sendJson(response, 200, { task });
        return;
      }

      const mediaTaskId = taskIdFromPath(pathname, "media");
      if (request.method === "GET" && mediaTaskId) {
        const mediaUrl = completedMedia.get(mediaTaskId);
        if (!mediaUrl) {
          sendJson(response, 404, { error: { message: "완료된 영상 주소를 찾을 수 없습니다. 작업 상태를 다시 확인해 주세요.", status: 404 } });
          return;
        }

        const upstream = await fetchImpl(mediaUrl);
        if (!upstream.ok || !upstream.body) {
          sendJson(response, 502, { error: { message: "생성된 영상을 내려받지 못했습니다.", status: 502 } });
          return;
        }

        const download = url.searchParams.get("download") === "1";
        response.writeHead(200, {
          "Content-Type": upstream.headers.get("content-type") || "video/mp4",
          "Cache-Control": "private, max-age=300",
          "Content-Disposition": `${download ? "attachment" : "inline"}; filename="minimax-h3-${mediaTaskId}.mp4"`,
        });
        Readable.fromWeb(upstream.body).pipe(response);
        return;
      }

      const spriteRoute = spriteJobRoute(pathname);
      if (spriteRoute) {
        const { jobId, suffix } = spriteRoute;
        if (request.method === "GET" && !suffix) {
          sendJson(response, 200, { job: await sprites.getJob(jobId) });
          return;
        }
        if (request.method === "DELETE" && !suffix) {
          await sprites.deleteJob(jobId);
          sendJson(response, 200, { ok: true });
          return;
        }
        if (request.method === "POST" && suffix === "extract") {
          const input = await readJsonBody(request, 16 * 1024);
          sendJson(response, 200, { job: await sprites.extract(jobId, input) });
          return;
        }
        if (request.method === "POST" && suffix === "export") {
          const input = await readJsonBody(request, 16 * 1024);
          sendJson(response, 200, { job: await sprites.exportJob(jobId, input) });
          return;
        }
        if (request.method === "GET" && suffix.startsWith("files/")) {
          const relativePath = suffix.slice("files/".length).split("/").map(decodeURIComponent).join("/");
          const file = await sprites.filePath(jobId, relativePath);
          sendFile(response, file, { download: url.searchParams.get("download") === "1" });
          return;
        }
      }

      if (request.method === "GET" && (await serveStatic(response, publicDir, pathname))) return;

      sendJson(response, 404, { error: { message: "경로를 찾을 수 없습니다.", status: 404 } });
    } catch (error) {
      if (error instanceof H3ValidationError) {
        sendJson(response, error.statusCode ?? 400, { error: { message: error.message, details: error.details } });
        return;
      }
      if (Number.isInteger(error?.statusCode)) {
        sendJson(response, error.statusCode, { error: { message: sanitizeMessage(error.message), status: error.statusCode } });
        return;
      }
      console.error("[minimax-h3-studio] request failed", sanitizeMessage(error?.message));
      if (!response.headersSent) sendJson(response, 500, { error: { message: "로컬 서버에서 요청을 처리하지 못했습니다.", status: 500 } });
      else response.destroy();
    }
  });

  return server;
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const port = Number(process.env.PORT || 4317);
  const host = "127.0.0.1";
  const server = createH3Server();
  server.listen(port, host, () => {
    console.log(`MiniMax H3 Sprite Studio: http://${host}:${port}`);
    console.log(process.env.MINIMAX_API_KEY ? "API key: environment variable configured" : "API key: enter it in the local website settings");
  });
}
