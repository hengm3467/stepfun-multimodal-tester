# StepFun Multimodal Tester

A local test chatbox for validating multimodal requests to StepFun models.

## What it tests

- Chat Completion endpoint: `POST https://api.stepfun.com/v1/chat/completions`
- Messages endpoint: `POST https://api.stepfun.com/v1/messages`
- Text-only requests
- Image URL requests
- Uploaded images converted to base64
- Multiple attachments
- Video URL requests for Chat Completion
- Local validation for unsupported video requests to Messages
- UI-pasted API keys, with `.env` fallback

## Run it

```bash
cd stepfun-multimodal-tester
cp .env.example .env
# Optional: edit .env and set STEPFUN_API_KEY, or paste the key in the UI
npm start
```

Open locally:

```text
http://localhost:8787
```

No dependencies are required beyond Node.js 20+.

## Public static page

This repo can also be served from GitHub Pages. In that static mode, paste an API key in the UI and the browser sends requests directly to the StepFun API using CORS. No project server stores or proxies the key.

The included GitHub Actions workflow deploys the `public/` folder to GitHub Pages on every push to `main`.

## API key options

You can use either option:

- Paste a StepFun API key into the web UI for the current browser session.
- Set `STEPFUN_API_KEY` in `.env` or your shell before running `npm start`. The server also accepts `STEPFUN_APP_ID` as a fallback name if that is already defined in your environment.

The key is never included in the generated request preview. When pasted in the UI, it is stored only in `sessionStorage`. On GitHub Pages it is sent directly from the browser to the StepFun API. In local server mode without a pasted key, the local `/api/test-chat` proxy adds `Authorization: Bearer ...` from the environment.

## Endpoint-specific request mapping

### Chat Completion image URL

```json
{
  "type": "image_url",
  "image_url": {
    "url": "https://example.com/image.png",
    "detail": "high"
  }
}
```

### Chat Completion base64 image

```json
{
  "type": "image_url",
  "image_url": {
    "url": "data:image/png;base64,iVBORw0KGgo...",
    "detail": "low"
  }
}
```

### Chat Completion video URL

```json
{
  "type": "video_url",
  "video_url": {
    "url": "https://example.com/video.mp4"
  }
}
```

### Messages image URL

```json
{
  "type": "image",
  "source": {
    "type": "url",
    "url": "https://example.com/image.png"
  }
}
```

### Messages base64 image

```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/png",
    "data": "iVBORw0KGgo..."
  }
}
```

## Useful checks

```bash
npm run check
npm start
curl http://localhost:8787/api/health
```

## Notes

- Video is only wired for the Chat Completion endpoint because the StepFun Messages documentation lists image blocks, not video blocks.
- Direct video-file upload is not implemented because the StepFun Chat Completion docs document video input as `video_url` with an HTTP/HTTPS MP4 URL. To test a local MP4, upload/host it first and paste the URL.
- The request preview redacts long base64 values to keep diagnostics readable.
- The backend still sends the full base64 image to StepFun.
