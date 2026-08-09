# MiniMax H3 Studio Design

## Summary

Create a small local website at `/Users/kingmo/Desktop/kkingmo-work/minimax-h3-studio` for submitting `MiniMax-H3` video-generation requests without manually assembling API JSON.

The interface exposes the two reference workflows supported by this tool:

1. Reference image generation using `role=reference_image`.
2. First and/or last frame generation using `role=first_frame` and `role=last_frame`.

It deliberately excludes reference video, reference audio, a separate character-reference mode, and the broad “omni reference” label. The public H3 API does not expose image-reference and character-reference as separate roles.

## Goals

- Make a paid H3 request from a clear local UI.
- Default to model `MiniMax-H3`, resolution `2K`, ratio `1:1`, and duration `6` seconds.
- Accept local image files without requiring the user to host them publicly.
- Poll the asynchronous task until it succeeds or fails.
- Preview and download the generated MP4.
- Show the estimated request cost before submission.
- Keep the API key out of source files and persistent browser storage.
- Keep the studio isolated from unrelated projects.

## Non-goals

- No video or audio reference inputs.
- No separate “character reference” behavior.
- No text-to-video-only workflow.
- No H3 Context-IR prompt enhancement.
- No 768P-to-2K regeneration workflow.
- No user accounts, database, cloud deployment, or shared task history.
- No automatic paid request during development or verification.

## Technical Approach

Use a zero-dependency Node.js application:

- `server.mjs`: serves static files and proxies MiniMax API requests.
- `lib/h3-contract.mjs`: pure request validation, MiniMax payload construction, and cost calculation.
- `public/index.html`: semantic one-page interface.
- `public/styles.css`: responsive dark tool interface.
- `public/app.js`: form state, file validation, request construction, polling, preview, download, and session-only history.
- Node's built-in test runner for request-contract and validation tests.

The local proxy avoids browser CORS limitations and prevents the browser from calling MiniMax directly. The server accepts an API key from `MINIMAX_API_KEY`; when that variable is absent, the user can enter a key in a password field. A UI-entered key is sent only to localhost for the current request and is never written to disk, local storage, session storage, cookies, logs, or generated task history.

## Interface

The page uses a quiet dark neutral palette. It is a tool surface rather than a marketing page.

### Main composition

- Header: product name, connection/key status, concise local-only note.
- Mode switch:
  - `참고 이미지`
  - `시작/종료 프레임`
- Upload region appropriate to the selected mode.
- Required prompt editor with a character count.
- Compact generation settings for ratio, resolution, and duration.
- Cost summary and primary `영상 생성` action.
- Result region showing request state, task ID, elapsed state, video preview, and MP4 download.
- Current-tab task history only; refreshing the page clears it.

### Reference image mode

- Accept 1–9 images.
- Represent every image as `type=image_url`, `role=reference_image`.
- Allow removal and reordering before submission.
- Use the selected ratio; default is `1:1`.
- Explain that the first five input images are free and later images add input cost.

### First/last frame mode

- Provide a first-frame slot and a last-frame slot.
- Permit first only, last only, or both.
- Represent images with `role=first_frame` and `role=last_frame`.
- Provide a swap control only when both slots are populated.
- The H3 API derives the output ratio from the frame image. Therefore the ratio control changes to a disabled `원본 비율` state in this mode rather than pretending `1:1` is applied.
- When both frames are provided, validate that their aspect ratios are close enough to avoid a misleading request.

## Input Validation

- Prompt: required, maximum 7,000 characters.
- Image formats: JPG, JPEG, PNG, WEBP, HEIC, HEIF.
- Image size: maximum 30 MB each.
- Dimensions: each side from 256 to 5,760 pixels.
- Aspect ratio: width/height from 0.4 to 2.5.
- Reference images: maximum 9.
- Total JSON request body: maximum 64 MB after Data URL conversion.
- Duration: integer from 4 through 15 seconds.
- Resolution: `768P` or `2K`, default `2K`.
- Reference-image ratio: `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, or `9:16`, default `1:1`.
- Reference-image and first/last-frame roles can never coexist in one request.

Client validation provides immediate feedback. The server repeats security-relevant validation before forwarding the request.

## API Contract

### Create

`POST https://api.minimax.io/v2/video_generation`

Shared fields:

```json
{
  "model": "MiniMax-H3",
  "content": [
    { "type": "text", "text": "Required prompt" }
  ],
  "resolution": "2K",
  "duration": 6
}
```

Reference images add:

```json
{
  "type": "image_url",
  "image_url": { "url": "data:image/png;base64,..." },
  "role": "reference_image"
}
```

This mode sends `ratio`, defaulting to `1:1`.

Frame inputs use the same media object with `role=first_frame` and/or `role=last_frame`. This mode omits the ratio field because H3 treats it as adaptive to the uploaded frame.

The create response returns `task_id`.

### Query

Poll `GET https://api.minimax.io/v2/query/video_generation/{task_id}` every ten seconds.

- Continue for `queued` and `running`.
- Stop and show the video for `succeeded`; the URL is `task.content.url`.
- Stop with an actionable error for `failed` or `cancelled`.
- Polling is cancelled when the user explicitly removes a task from the current view or leaves the page.

### Download

When a task succeeds, the local server records only its task ID and returned `content.url` in process memory. A download endpoint keyed by that known task ID streams the MP4. It does not accept an arbitrary remote URL and never stores the API key, avoiding an open proxy/SSRF surface. Restarting the server clears this map.

## Cost Estimate

Use current H3 pay-as-you-go list prices:

- 2K output: `$0.13 × output seconds`.
- 768P output: `$0.08 × output seconds`.
- First five input images: free.
- Each additional input image: `$0.04`.

The UI labels this as an estimate and displays the chosen resolution, duration, image count, and calculated total. The authoritative charge remains the MiniMax account record.

## Errors and Safety

- `401`: missing or invalid API key.
- `402`: insufficient account balance.
- `422`: rejected prompt or media.
- `429`: rate limited; keep the task form intact and suggest retrying later.
- Upstream `5xx`: show a retryable service error without exposing response headers or secrets.
- Never print the API key or full Data URLs.
- Bind the local server to `127.0.0.1`, not all network interfaces.
- Apply request-size limits and reject unsupported routes and methods.
- Escape all user-visible API messages and use text nodes rather than HTML injection.

## Verification

- Unit tests for mode-to-API payload construction.
- Unit tests for role exclusivity, duration/resolution/ratio constraints, file count, and cost calculation.
- Mocked upstream tests for create, queued/running/succeeded polling, failure states, and download proxy behavior.
- Browser verification at desktop and narrow mobile widths.
- Keyboard and accessible-name checks for mode controls, uploads, settings, submit, and result actions.
- No real MiniMax request, paid generation, or balance deduction during verification.

## Source References

- Hailuo UI: <https://hailuoai.video/ko/create/image-to-video>
- H3 create endpoint: <https://platform.minimax.io/docs/api-reference/video-generation-v2-create>
- H3 generation guide: <https://platform.minimax.io/docs/guides/video-generation>
- Pay-as-you-go pricing: <https://platform.minimax.io/docs/guides/pricing-paygo>
