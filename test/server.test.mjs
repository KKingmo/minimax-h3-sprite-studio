import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { IMAGE_ROLES, MODES } from "../lib/h3-contract.mjs";
import { createH3Server } from "../server.mjs";

function requestImage(role) {
  return {
    role,
    name: "reference.png",
    type: "image/png",
    dataUrl: `data:image/png;base64,${Buffer.from("fake-image").toString("base64")}`,
    width: 1024,
    height: 1024,
  };
}

function generationBody() {
  return {
    mode: MODES.REFERENCE_IMAGE,
    prompt: "A calm, continuous character motion.",
    resolution: "2K",
    duration: 6,
    ratio: "1:1",
    images: [requestImage(IMAGE_ROLES.REFERENCE)],
  };
}

async function withServer(options, run) {
  const server = createH3Server(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("config reports whether an environment API key exists", async () => {
  await withServer({ environmentKey: "server-key" }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/config`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.envKeyConfigured, true);
    assert.equal(body.defaults.resolution, "2K");
    assert.equal(body.defaults.ratio, "1:1");
  });
});

test("create endpoint forwards a validated H3 v2 request without logging or returning the key", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ task_id: "task-123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await withServer({ fetchImpl, apiBaseUrl: "https://api.example" }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-minimax-api-key": "temporary-browser-key",
      },
      body: JSON.stringify(generationBody()),
    });

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { taskId: "task-123" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.example/v2/video_generation");
    assert.equal(calls[0].options.headers.Authorization, "Bearer temporary-browser-key");
    const upstreamBody = JSON.parse(calls[0].options.body);
    assert.equal(upstreamBody.model, "MiniMax-H3");
    assert.equal(upstreamBody.ratio, "1:1");
    assert.equal(upstreamBody.content[1].role, "reference_image");
  });
});

test("create endpoint composes sprite constraints before forwarding", async () => {
  let upstreamBody;
  const fetchImpl = async (_url, options) => {
    upstreamBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ task_id: "sprite-task" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await withServer({ fetchImpl, apiBaseUrl: "https://api.example", environmentKey: "server-key" }, async (baseUrl) => {
    const body = generationBody();
    body.sprite = { enabled: true, characterHeightPercent: 80, footAnchorPercent: 92 };
    const response = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    assert.equal(response.status, 201);
    assert.match(upstreamBody.content[0].text, /\[static\]/);
    assert.match(upstreamBody.content[0].text, /approximately 80%/);
    assert.match(upstreamBody.content[0].text, /at 92% of the canvas height/);
    assert.equal("prompt_optimizer" in upstreamBody, false);
  });
});

test("missing API key is rejected before an upstream request", async () => {
  let called = false;
  await withServer({ fetchImpl: async () => { called = true; return new Response(); } }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(generationBody()),
    });
    assert.equal(response.status, 401);
    assert.match((await response.json()).error.message, /API 키/);
    assert.equal(called, false);
  });
});

test("successful query registers a task-scoped media stream and download", async () => {
  const videoBytes = Buffer.from("mock-mp4-bytes");
  const fetchImpl = async (url) => {
    if (url === "https://api.example/v2/query/video_generation/task-777") {
      return new Response(JSON.stringify({
        task: {
          id: "task-777",
          status: "succeeded",
          content: { url: "https://cdn.example/result.mp4" },
        },
      }), { headers: { "content-type": "application/json" } });
    }
    if (url === "https://cdn.example/result.mp4") {
      return new Response(videoBytes, { headers: { "content-type": "video/mp4" } });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  await withServer({ fetchImpl, apiBaseUrl: "https://api.example" }, async (baseUrl) => {
    const query = await fetch(`${baseUrl}/api/tasks/task-777`, { headers: { "x-minimax-api-key": "key" } });
    assert.equal(query.status, 200);
    assert.equal((await query.json()).task.status, "succeeded");

    const media = await fetch(`${baseUrl}/api/tasks/task-777/media`);
    assert.equal(media.status, 200);
    assert.equal(media.headers.get("content-type"), "video/mp4");
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), videoBytes);

    const download = await fetch(`${baseUrl}/api/tasks/task-777/media?download=1`);
    assert.match(download.headers.get("content-disposition"), /^attachment/);
  });
});

test("arbitrary media URLs cannot be proxied", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks/unknown/media?url=https://evil.example/file`);
    assert.equal(response.status, 404);
  });
});

test("a completed H3 task can be copied into a local sprite job", async () => {
  const videoBytes = Buffer.from("generated-video");
  const calls = [];
  const spriteWorkspace = {
    findByTaskId: async () => null,
    createJob: async (input) => {
      calls.push(["create", input]);
      return { id: "sprite-job-123" };
    },
    writeVideo: async (id, stream) => {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      calls.push(["write", id, Buffer.concat(chunks)]);
    },
    inspectJob: async () => ({ id: "sprite-job-123", status: "video-ready", source: { type: "minimax" } }),
    deleteJob: async () => undefined,
  };
  const fetchImpl = async (url) => {
    if (url.endsWith("/v2/query/video_generation/task-atlas")) {
      return new Response(JSON.stringify({
        task: { status: "succeeded", content: { url: "https://cdn.example/task-atlas.mp4" } },
      }), { headers: { "content-type": "application/json" } });
    }
    if (url === "https://cdn.example/task-atlas.mp4") return new Response(videoBytes);
    throw new Error(`unexpected URL: ${url}`);
  };

  await withServer({ fetchImpl, apiBaseUrl: "https://api.example", spriteWorkspace }, async (baseUrl) => {
    const query = await fetch(`${baseUrl}/api/tasks/task-atlas`, { headers: { "x-minimax-api-key": "key" } });
    assert.equal(query.status, 200);

    const response = await fetch(`${baseUrl}/api/sprite/jobs/from-task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: "task-atlas", prompt: "wave", generation: { resolution: "2K" } }),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).job.id, "sprite-job-123");
    assert.equal(calls[0][1].taskId, "task-atlas");
    assert.deepEqual(calls[1][2], videoBytes);
  });
});

test("direct sprite uploads decode a Unicode filename before validation", async () => {
  let receivedFilename;
  const spriteWorkspace = {
    createJob: async ({ filename }) => {
      receivedFilename = filename;
      return { id: "sprite-upload-1" };
    },
    writeVideo: async () => undefined,
    inspectJob: async () => ({ id: "sprite-upload-1", status: "video-ready" }),
    deleteJob: async () => undefined,
  };

  await withServer({ spriteWorkspace }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sprite/jobs/upload`, {
      method: "POST",
      headers: { "x-video-filename": encodeURIComponent("내 영상.mp4") },
      body: Buffer.from("video"),
    });
    assert.equal(response.status, 201);
    assert.equal(receivedFilename, "내 영상.mp4");
  });
});
