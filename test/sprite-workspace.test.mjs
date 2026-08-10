import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSpriteWorkspace } from "../lib/sprite-workspace.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "minimax-sprite-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pythonPath = join(root, "python");
  const workerPath = join(root, "worker.py");
  await writeFile(pythonPath, "mock");
  await writeFile(workerPath, "mock");

  const pythonRunner = async ({ action, payload }) => {
    if (action === "inspect") {
      return { width: 640, height: 640, fps: 24, frameCount: 48, durationSeconds: 2, fileBytes: 5 };
    }
    if (action === "extract") {
      const frameDir = join(payload.jobDir, "working", "extraction");
      await mkdir(frameDir, { recursive: true });
      const framePaths = [join("working", "extraction", "frame-0001.png"), join("working", "extraction", "frame-0002.png")];
      for (const path of framePaths) await writeFile(join(payload.jobDir, path), "png");
      const previewPath = join("working", "extraction", "preview.gif");
      await writeFile(join(payload.jobDir, previewPath), "gif");
      return {
        sourceVideoName: "clip.mp4",
        sourceVideoBytes: 5,
        sourceSize: [640, 640],
        sourceFps: 24,
        sourceFrameCount: 48,
        sourceDurationSeconds: 2,
        sampleFps: payload.targetFps,
        sampledDurationSeconds: 2,
        framePaths,
        frameTimes: [0, 1 / payload.targetFps],
        previewPath,
      };
    }
    if (action === "export") {
      const exportDir = join(payload.jobDir, "exports");
      await mkdir(exportDir, { recursive: true });
      const files = {
        "sprite-atlas.webp": join("exports", "sprite-atlas.webp"),
        "sprite-animation-package.zip": join("exports", "sprite-animation-package.zip"),
      };
      for (const path of Object.values(files)) await writeFile(join(payload.jobDir, path), "result");
      await rm(join(payload.jobDir, "working"), { recursive: true, force: true });
      return {
        frameCount: 2,
        sampleFps: 12,
        frameSize: [256, 256],
        atlasSize: [512, 256],
        columns: 2,
        rows: 1,
        frameDurationMs: 83,
        modelName: payload.modelName,
        deviceName: "mock",
        elapsedSeconds: 0.1,
        files,
        fileSizes: { "sprite-atlas.webp": 6, "sprite-animation-package.zip": 6 },
      };
    }
    throw new Error(`unexpected action: ${action}`);
  };

  return createSpriteWorkspace({
    rootDir: join(root, "workspace"),
    pythonPath,
    workerPath,
    pythonRunner,
    now: () => new Date("2026-08-10T03:00:00.000Z"),
  });
}

test("local jobs persist only allowlisted generation metadata", async (t) => {
  const workspace = await fixture(t);
  const job = await workspace.createJob({
    type: "minimax",
    filename: "generated.mp4",
    taskId: "task-123",
    prompt: "character wave",
    generation: {
      mode: "reference-image",
      resolution: "2K",
      duration: 6,
      ratio: "1:1",
      imageCount: 1,
      images: [{ dataUrl: "data:image/png;base64,secret" }],
      apiKey: "secret-key",
    },
  });
  const manifest = JSON.parse(await readFile(join(workspace.paths.jobsDir, job.id, "job.json"), "utf8"));
  assert.deepEqual(manifest.source.generation, {
    mode: "reference-image",
    resolution: "2K",
    duration: 6,
    ratio: "1:1",
    imageCount: 1,
  });
  assert.equal(JSON.stringify(manifest).includes("secret"), false);
});

test("upload, inspect, extract and export keep results but remove direct source and intermediates", async (t) => {
  const workspace = await fixture(t);
  const created = await workspace.createJob({ type: "upload", filename: "clip.mp4" });
  await workspace.writeVideo(created.id, [Buffer.from("video")], { contentLength: 5 });
  const inspected = await workspace.inspectJob(created.id);
  assert.equal(inspected.videoInfo.width, 640);

  const extracted = await workspace.extract(created.id, { targetFps: 12, maxFrames: 24 });
  assert.equal(extracted.status, "frames-ready");
  assert.equal(extracted.extraction.frameUrls.length, 2);

  const exported = await workspace.exportJob(created.id, {
    modelName: "빠르게 · 일반 사진",
    refineEdges: true,
    cellSize: 256,
    columns: 10,
    webpQuality: 80,
    gifColors: 128,
  });
  assert.equal(exported.status, "complete");
  assert.equal(exported.source.videoUrl, undefined);
  assert.equal(exported.source.removedAfterExport, true);
  assert.equal(exported.extraction.cleaned, true);
  assert.match(exported.result.fileUrls["sprite-animation-package.zip"], /^\/api\/sprite\/jobs\//);
  const resultFile = await workspace.filePath(created.id, "exports/sprite-atlas.webp");
  assert.equal(resultFile.name, "sprite-atlas.webp");
  await assert.rejects(() => workspace.filePath(created.id, "job.json"), /공개할 수 없는/);
});

test("jobs left running by a server interruption become retryable errors", async (t) => {
  const workspace = await fixture(t);
  const created = await workspace.createJob({ type: "upload", filename: "clip.mp4" });
  await workspace.writeVideo(created.id, [Buffer.from("video")], { contentLength: 5 });
  const manifestPath = join(workspace.paths.jobsDir, created.id, "job.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.status = "exporting";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const [recovered] = await workspace.listJobs();
  assert.equal(recovered.status, "error");
  assert.equal(recovered.error.stage, "export");
  assert.match(recovered.error.message, /서버가 작업 도중 종료/);
  assert.ok(recovered.source.videoUrl);
});

test("extracting again invalidates an older atlas result", async (t) => {
  const workspace = await fixture(t);
  const created = await workspace.createJob({ type: "minimax", filename: "generated.mp4", taskId: "task-reextract" });
  await workspace.writeVideo(created.id, [Buffer.from("video")], { contentLength: 5 });
  await workspace.extract(created.id, { targetFps: 12, maxFrames: 24 });
  const exported = await workspace.exportJob(created.id, {
    modelName: "빠르게 · 일반 사진",
    refineEdges: true,
    cellSize: 256,
    columns: 10,
    webpQuality: 80,
    gifColors: 128,
  });
  assert.ok(exported.result);

  const extractedAgain = await workspace.extract(created.id, { targetFps: 8, maxFrames: 16 });
  assert.equal(extractedAgain.status, "frames-ready");
  assert.equal(extractedAgain.result, null);
  assert.equal(extractedAgain.extraction.sampleFps, 8);
});
