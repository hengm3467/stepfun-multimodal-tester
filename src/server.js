import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = join(__dirname, "..");
const publicDir = join(projectRoot, "public");
const STEP_BASE_URL = "https://api.stepfun.com/v1";

await loadDotEnv();

const PORT = Number(process.env.PORT || 8787);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "POST" && url.pathname === "/api/test-chat") {
      await handleTestChat(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        hasApiKey: Boolean(getEnvApiKey()),
        port: PORT,
      });
      return;
    }

    if (req.method === "GET") {
      await serveStatic(url.pathname, res);
      return;
    }

    sendJson(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}).listen(PORT, () => {
  console.log(`StepFun multimodal tester running at http://localhost:${PORT}`);
});

async function handleTestChat(req, res) {
  const input = await readJsonBody(req);
  const apiKey = getRequestApiKey(input);
  if (!apiKey) {
    sendJson(res, 500, {
      ok: false,
      error: "缺少 StepFun API Key。请在页面粘贴 API Key，或在本地运行时通过 STEPFUN_API_KEY 启动服务端。",
    });
    return;
  }

  const started = Date.now();
  const endpoint = input.endpoint === "messages" ? "messages" : "chat_completions";
  const payload = endpoint === "messages" ? buildMessagesPayload(input) : buildChatCompletionsPayload(input);
  const path = endpoint === "messages" ? "/messages" : "/chat/completions";

  const stepResponse = await fetch(`${STEP_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await stepResponse.text();
  const responseJson = tryParseJson(text);
  const latencyMs = Date.now() - started;

  sendJson(res, 200, {
    ok: stepResponse.ok,
    endpoint,
    status: stepResponse.status,
    latencyMs,
    requestJson: redactLargeBase64(payload),
    responseJson: responseJson ?? text,
    assistantText: extractAssistantText(endpoint, responseJson),
    usage: responseJson?.usage,
    error: stepResponse.ok ? undefined : summarizeError(responseJson, text),
  });
}

function buildChatCompletionsPayload(input) {
  validateInput(input, "chat_completions");

  const content = [{ type: "text", text: String(input.prompt || "") }];
  for (const attachment of input.attachments || []) {
    if (attachment.kind === "image_url") {
      content.push({
        type: "image_url",
        image_url: {
          url: attachment.url,
          detail: attachment.detail || "low",
        },
      });
    }

    if (attachment.kind === "image_base64") {
      content.push({
        type: "image_url",
        image_url: {
          url: `data:${attachment.mediaType};base64,${stripDataUrlPrefix(attachment.base64)}`,
          detail: attachment.detail || "low",
        },
      });
    }

    if (attachment.kind === "video_url") {
      content.push({
        type: "video_url",
        video_url: { url: attachment.url },
      });
    }
  }

  const messages = [];
  if (input.system) messages.push({ role: "system", content: String(input.system) });
  messages.push({ role: "user", content });

  return {
    model: input.model,
    messages,
    temperature: numberOrDefault(input.temperature, 0.2),
    max_tokens: integerOrDefault(input.maxTokens, 1024),
    stream: Boolean(input.stream),
  };
}

function buildMessagesPayload(input) {
  validateInput(input, "messages");

  const content = [{ type: "text", text: String(input.prompt || "") }];
  for (const attachment of input.attachments || []) {
    if (attachment.kind === "image_url") {
      content.push({
        type: "image",
        source: { type: "url", url: attachment.url },
      });
    }

    if (attachment.kind === "image_base64") {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mediaType,
          data: stripDataUrlPrefix(attachment.base64),
        },
      });
    }
  }

  return {
    model: input.model,
    max_tokens: integerOrDefault(input.maxTokens, 1024),
    system: input.system ? String(input.system) : undefined,
    messages: [{ role: "user", content }],
    temperature: numberOrDefault(input.temperature, 0.2),
    stream: Boolean(input.stream),
  };
}

function validateInput(input, endpoint) {
  if (!input.prompt && !(input.attachments || []).length) {
    throw new Error("请输入提示词，或添加至少一个附件。");
  }

  if (!String(input.model || "").trim()) {
    throw new Error("请输入模型名称。");
  }

  for (const attachment of input.attachments || []) {
    if (attachment.kind === "video_url" && endpoint === "messages") {
      throw new Error("Messages API 文档未说明支持 video_url。请使用 Chat Completion 进行视频测试。");
    }

    if ((attachment.kind === "image_url" || attachment.kind === "video_url") && !isHttpUrl(attachment.url)) {
      throw new Error(`${attachment.kind} 必须使用 http:// 或 https:// URL。`);
    }

    if (attachment.kind === "image_base64" && !isAllowedImageType(attachment.mediaType)) {
      throw new Error(`不支持的图片类型：${attachment.mediaType}`);
    }

    if (attachment.kind === "image_base64" && !attachment.base64) {
      throw new Error("Base64 图片附件缺少数据。");
    }

    if ((attachment.kind === "image_url" || attachment.kind === "image_base64") && attachment.detail && !["low", "high"].includes(attachment.detail)) {
      throw new Error("图片细节级别必须是 low 或 high。");
    }
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function serveStatic(pathname, res) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(publicDir, cleanPath));

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return;
  }

  try {
    const file = await readFile(filePath);
    const mimeType = mimeTypes[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mimeType, "Cache-Control": "no-store" });
    res.end(file);
  } catch {
    sendJson(res, 404, { ok: false, error: "Not found" });
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value, null, 2));
}

function extractAssistantText(endpoint, response) {
  if (!response) return "";
  if (endpoint === "chat_completions") return response.choices?.[0]?.message?.content || "";
  if (Array.isArray(response.content)) {
    return response.content.filter((block) => block.type === "text").map((block) => block.text || "").join("");
  }
  return response.output_text || response.text || "";
}

function stripDataUrlPrefix(value) {
  return String(value || "").replace(/^data:[^;]+;base64,/, "");
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isAllowedImageType(value) {
  return ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(value);
}

function integerOrDefault(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function summarizeError(json, raw) {
  return json?.error?.message || json?.message || raw || "StepFun API request failed.";
}

function redactLargeBase64(value) {
  return JSON.parse(JSON.stringify(value, (_key, val) => {
    if (typeof val === "string" && val.length > 500 && /base64|data:image/.test(val.slice(0, 80))) {
      return `${val.slice(0, 120)}... [已隐藏 ${val.length} 个字符]`;
    }
    return val;
  }));
}

function getEnvApiKey() {
  return process.env.STEPFUN_API_KEY || process.env.STEPFUN_APP_ID || "";
}

function getRequestApiKey(input) {
  const pasted = typeof input?.apiKey === "string" ? input.apiKey.trim() : "";
  return pasted || getEnvApiKey();
}

async function loadDotEnv() {
  try {
    const env = await readFile(join(projectRoot, ".env"), "utf8");
    for (const line of env.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...valueParts] = trimmed.split("=");
      if (!process.env[key]) {
        process.env[key] = valueParts.join("=").replace(/^['"]|['"]$/g, "");
      }
    }
  } catch {
    // .env is optional; exported environment variables work too.
  }
}
