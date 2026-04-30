const form = document.querySelector("#testForm");
const endpointEl = document.querySelector("#endpoint");
const modelEl = document.querySelector("#model");
const apiKeyEl = document.querySelector("#apiKey");
const systemEl = document.querySelector("#system");
const promptEl = document.querySelector("#prompt");
const temperatureEl = document.querySelector("#temperature");
const maxTokensEl = document.querySelector("#maxTokens");
const streamEl = document.querySelector("#stream");
const attachmentsEl = document.querySelector("#attachments");
const warningsEl = document.querySelector("#warnings");
const requestJsonEl = document.querySelector("#requestJson");
const responseJsonEl = document.querySelector("#responseJson");
const assistantTextEl = document.querySelector("#assistantText");
const metricsEl = document.querySelector("#metrics");
const healthCard = document.querySelector("#healthCard");
const copyCurlButton = document.querySelector("#copyCurl");
const historyEl = document.querySelector("#history");
const clearHistoryButton = document.querySelector("#clearHistory");
const template = document.querySelector("#attachmentTemplate");

let attachments = [];
let lastPayload = null;
let serverHasApiKey = false;
let history = JSON.parse(localStorage.getItem("stepfun-test-history") || "[]");

apiKeyEl.value = sessionStorage.getItem("stepfun-api-key") || "";

checkHealth();
renderAttachments();
renderPreview();
renderHistory();

for (const button of document.querySelectorAll("[data-add]")) {
  button.addEventListener("click", () => addAttachment(button.dataset.add));
}

for (const element of [endpointEl, modelEl, apiKeyEl, systemEl, promptEl, temperatureEl, maxTokensEl, streamEl]) {
  element.addEventListener("input", () => {
    if (element === apiKeyEl) {
      if (apiKeyEl.value.trim()) {
        sessionStorage.setItem("stepfun-api-key", apiKeyEl.value.trim());
      } else {
        sessionStorage.removeItem("stepfun-api-key");
      }
    }
    renderPreview();
    renderWarnings();
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = buildClientPayload();
  const problems = validateClientPayload(payload);
  if (problems.length) {
    setWarnings(problems);
    return;
  }

  form.querySelector(".send").disabled = true;
  metricsEl.innerHTML = "<span>Sending...</span>";

  try {
    const result = payload.apiKey
      ? await sendDirectToStepFun(payload)
      : await sendViaLocalProxy(payload);
    requestJsonEl.textContent = pretty(result.requestJson || payload);
    responseJsonEl.textContent = pretty(result.responseJson || result);
    assistantTextEl.value = result.assistantText || "";
    renderMetrics(result);
    addHistory(result, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    responseJsonEl.textContent = pretty({ ok: false, error: message });
    metricsEl.innerHTML = `<span class="badge fail">Client error</span>`;
  } finally {
    form.querySelector(".send").disabled = false;
  }
});

async function sendViaLocalProxy(payload) {
  const response = await fetch("/api/test-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function sendDirectToStepFun(payload) {
  const started = Date.now();
  const stepRequest = buildStepPreview(payload);

  try {
    const response = await fetch(stepRequest.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${payload.apiKey}`,
      },
      body: JSON.stringify(stepRequest.body),
    });

    const text = await response.text();
    const responseJson = tryParseJson(text);
    return {
      ok: response.ok,
      endpoint: payload.endpoint,
      status: response.status,
      latencyMs: Date.now() - started,
      requestJson: redactPreview(stepRequest),
      responseJson: responseJson || text,
      assistantText: extractAssistantText(payload.endpoint, responseJson),
      usage: responseJson?.usage,
      error: response.ok ? undefined : summarizeError(responseJson, text),
    };
  } catch (error) {
    return {
      ok: false,
      endpoint: payload.endpoint,
      status: 0,
      latencyMs: Date.now() - started,
      requestJson: redactPreview(stepRequest),
      responseJson: null,
      assistantText: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

copyCurlButton.addEventListener("click", async () => {
  if (!lastPayload) renderPreview();
  const curl = buildCurl(lastPayload);
  await navigator.clipboard.writeText(curl);
  copyCurlButton.textContent = "Copied";
  setTimeout(() => (copyCurlButton.textContent = "Copy curl"), 1200);
});

clearHistoryButton.addEventListener("click", () => {
  history = [];
  localStorage.removeItem("stepfun-test-history");
  renderHistory();
});

function addAttachment(kind) {
  attachments.push({
    id: crypto.randomUUID(),
    kind,
    detail: "low",
    mediaType: "image/png",
    url: "",
    base64: "",
    fileName: "",
  });
  renderAttachments();
  renderPreview();
}

function renderAttachments() {
  attachmentsEl.innerHTML = "";
  for (const attachment of attachments) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector("strong").textContent = titleForAttachment(attachment.kind);
    node.querySelector(".remove").addEventListener("click", () => {
      attachments = attachments.filter((item) => item.id !== attachment.id);
      renderAttachments();
      renderPreview();
    });

    const body = node.querySelector(".attachment-body");
    if (attachment.kind === "image_url") {
      body.append(labelWithInput("Image URL", "url", attachment.url, "https://example.com/image.png", attachment));
      body.append(detailSelect(attachment));
    }

    if (attachment.kind === "video_url") {
      body.append(labelWithInput("MP4 video URL", "url", attachment.url, "https://example.com/video.mp4", attachment));
      const hint = document.createElement("div");
      hint.className = "warning";
      hint.textContent = "Chat Completion only. Recommended: MP4 under 128 MB and under 5 minutes.";
      body.append(hint);
    }

    if (attachment.kind === "image_base64") {
      const fileLabel = document.createElement("label");
      fileLabel.textContent = "Image file";
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "image/jpeg,image/png,image/webp,image/gif";
      fileInput.addEventListener("change", async () => {
        const file = fileInput.files[0];
        if (!file) return;
        attachment.mediaType = file.type || "image/png";
        attachment.fileName = file.name;
        attachment.base64 = await fileToDataUrl(file);
        renderAttachments();
        renderPreview();
      });
      fileLabel.append(fileInput);
      body.append(fileLabel);

      const meta = document.createElement("div");
      meta.className = "warning";
      meta.textContent = attachment.fileName ? `${attachment.fileName} (${attachment.mediaType}) loaded` : "Choose an image to convert to base64.";
      body.append(meta);
      body.append(detailSelect(attachment));
    }

    attachmentsEl.append(node);
  }
  renderWarnings();
}

function labelWithInput(labelText, key, value, placeholder, attachment) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const input = document.createElement("input");
  input.value = value || "";
  input.placeholder = placeholder;
  input.addEventListener("input", () => {
    attachment[key] = input.value.trim();
    renderPreview();
    renderWarnings();
  });
  label.append(input);
  return label;
}

function detailSelect(attachment) {
  const label = document.createElement("label");
  label.textContent = "Image detail";
  const select = document.createElement("select");
  for (const value of ["low", "high"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.selected = attachment.detail === value;
    select.append(option);
  }
  select.addEventListener("input", () => {
    attachment.detail = select.value;
    renderPreview();
  });
  label.append(select);
  return label;
}

function buildClientPayload() {
  return {
    endpoint: endpointEl.value,
    model: modelEl.value.trim() || "step-3.6",
    apiKey: apiKeyEl.value.trim(),
    system: systemEl.value.trim(),
    prompt: promptEl.value,
    temperature: Number(temperatureEl.value),
    maxTokens: Number(maxTokensEl.value),
    stream: streamEl.checked,
    attachments: attachments.map((attachment) => ({
      kind: attachment.kind,
      url: attachment.url,
      detail: attachment.detail,
      mediaType: attachment.mediaType,
      base64: attachment.base64,
      fileName: attachment.fileName,
    })),
  };
}

function renderPreview() {
  lastPayload = buildClientPayload();
  requestJsonEl.textContent = pretty(redactPreview(buildStepPreview(lastPayload)));
}

function renderWarnings() {
  setWarnings(validateClientPayload(buildClientPayload(), true));
}

function validateClientPayload(payload, warningsOnly = false) {
  const problems = [];
  if (!payload.apiKey && !serverHasApiKey && !warningsOnly) {
    problems.push("Paste a StepFun API key, or start the server with STEPFUN_API_KEY / STEPFUN_APP_ID.");
  }
  if (!payload.prompt.trim() && payload.attachments.length === 0) problems.push("Enter a prompt or add an attachment.");
  for (const attachment of payload.attachments) {
    if (attachment.kind === "video_url" && payload.endpoint === "messages") {
      problems.push("Messages API does not document video support. Switch to Chat Completion for video tests.");
    }
    if ((attachment.kind === "image_url" || attachment.kind === "video_url") && attachment.url && !/^https?:\/\//i.test(attachment.url)) {
      problems.push(`${titleForAttachment(attachment.kind)} must use http:// or https://.`);
    }
    if ((attachment.kind === "image_url" || attachment.kind === "video_url") && !attachment.url && !warningsOnly) {
      problems.push(`${titleForAttachment(attachment.kind)} is missing a URL.`);
    }
    if (attachment.kind === "image_base64" && !attachment.base64 && !warningsOnly) {
      problems.push("Uploaded image attachment is missing file data.");
    }
  }
  return problems;
}

function setWarnings(items) {
  warningsEl.innerHTML = "";
  for (const item of [...new Set(items)]) {
    const node = document.createElement("div");
    node.className = "warning";
    node.textContent = item;
    warningsEl.append(node);
  }
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    const health = await response.json();
    serverHasApiKey = Boolean(health.hasApiKey);
    healthCard.innerHTML = health.hasApiKey
      ? "<strong>Ready</strong><br>Server has an API key. You can also paste one per session."
      : "<strong>Paste key</strong><br>No server API key found. Use the field in the form.";
    renderWarnings();
  } catch {
    serverHasApiKey = false;
    healthCard.innerHTML = "<strong>Static mode</strong><br>Paste an API key to call the API directly from your browser.";
    renderWarnings();
  }
}

function renderMetrics(result) {
  metricsEl.innerHTML = "";
  const items = [
    badge(result.ok ? "Pass" : "Fail", result.ok ? "pass" : "fail"),
    badge(`HTTP ${result.status}`),
    badge(`${result.latencyMs} ms`),
    badge(result.endpoint),
  ];
  if (result.usage) items.push(badge(`usage ${JSON.stringify(result.usage)}`));
  for (const item of items) metricsEl.append(item);
}

function addHistory(result, payload) {
  history.unshift({
    at: new Date().toLocaleTimeString(),
    ok: result.ok,
    status: result.status,
    latencyMs: result.latencyMs,
    endpoint: result.endpoint,
    prompt: payload.prompt.slice(0, 90),
    attachments: payload.attachments.length,
  });
  history = history.slice(0, 30);
  localStorage.setItem("stepfun-test-history", JSON.stringify(history));
  renderHistory();
}

function renderHistory() {
  if (!history.length) {
    historyEl.className = "history empty";
    historyEl.textContent = "No tests yet.";
    return;
  }
  historyEl.className = "history";
  historyEl.innerHTML = "";
  for (const item of history) {
    const row = document.createElement("div");
    row.className = "history-item";
    row.innerHTML = `
      <span>${item.at}</span>
      <span class="badge ${item.ok ? "pass" : "fail"}">${item.ok ? "Pass" : "Fail"} ${item.status}</span>
      <span>${escapeHtml(item.prompt || "No prompt")}</span>
      <span>${item.attachments} files</span>
      <span>${item.latencyMs} ms</span>
    `;
    historyEl.append(row);
  }
}

function badge(text, kind = "") {
  const span = document.createElement("span");
  span.className = kind ? `badge ${kind}` : "badge";
  span.textContent = text;
  return span;
}

function titleForAttachment(kind) {
  return {
    image_url: "Image URL",
    image_base64: "Base64 image",
    video_url: "Video URL",
  }[kind] || kind;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function redactPreview(value) {
  return JSON.parse(JSON.stringify(value, (key, val) => {
    if (key === "apiKey" && val) return "[redacted]";
    if (key === "base64" && typeof val === "string" && val.length > 160) return `${val.slice(0, 80)}... [redacted ${val.length} chars]`;
    return val;
  }));
}

function buildStepPreview(payload) {
  const content = [{ type: "text", text: payload.prompt }];

  if (payload.endpoint === "messages") {
    for (const attachment of payload.attachments) {
      if (attachment.kind === "image_url") {
        content.push({ type: "image", source: { type: "url", url: attachment.url } });
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
      if (attachment.kind === "video_url") {
        content.push({ type: "unsupported_video_for_messages", url: attachment.url });
      }
    }

    return {
      url: "https://api.stepfun.com/v1/messages",
      body: {
        model: payload.model,
        max_tokens: payload.maxTokens,
        system: payload.system || undefined,
        messages: [{ role: "user", content }],
        temperature: payload.temperature,
        stream: payload.stream,
      },
    };
  }

  for (const attachment of payload.attachments) {
    if (attachment.kind === "image_url") {
      content.push({
        type: "image_url",
        image_url: { url: attachment.url, detail: attachment.detail || "low" },
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
      content.push({ type: "video_url", video_url: { url: attachment.url } });
    }
  }

  const messages = [];
  if (payload.system) messages.push({ role: "system", content: payload.system });
  messages.push({ role: "user", content });

  return {
    url: "https://api.stepfun.com/v1/chat/completions",
    body: {
      model: payload.model,
      messages,
      temperature: payload.temperature,
      max_tokens: payload.maxTokens,
      stream: payload.stream,
    },
  };
}

function buildCurl(payload) {
  if (payload.apiKey) {
    const stepRequest = buildStepPreview(payload);
    return `STEPFUN_API_KEY=your-key curl -X POST ${stepRequest.url} -H 'Content-Type: application/json' -H "Authorization: Bearer $STEPFUN_API_KEY" --data-raw '${JSON.stringify(stepRequest.body).replaceAll("'", "'\\''")}'`;
  }

  return `curl -X POST http://localhost:8787/api/test-chat -H 'Content-Type: application/json' --data-raw '${JSON.stringify(payload).replaceAll("'", "'\\''")}'`;
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractAssistantText(endpoint, response) {
  if (!response) return "";
  if (endpoint === "chat_completions") return response.choices?.[0]?.message?.content || "";
  if (Array.isArray(response.content)) {
    return response.content.filter((block) => block.type === "text").map((block) => block.text || "").join("");
  }
  return response.output_text || response.text || "";
}

function summarizeError(json, raw) {
  return json?.error?.message || json?.message || raw || "API request failed.";
}

function stripDataUrlPrefix(value) {
  return String(value || "").replace(/^data:[^;]+;base64,/, "");
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[char]);
}
