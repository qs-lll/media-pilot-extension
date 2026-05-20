const DEFAULT_API_KEY = "";
const API_CONFIG = {
  key: DEFAULT_API_KEY,
  url: "https://new.aicontrol.top",
  model: "gpt-5.5"
};
const SETTINGS_STORAGE_KEY = "aiAssistantSettings";

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

const parseChatResponse = async (response) => {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `AI 请求失败：${response.status}`);
  }

  if (!text.trim().startsWith("data:")) {
    const data = JSON.parse(text);
    return data.choices?.[0]?.message?.content?.trim() || "";
  }

  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace(/^data:\s*/, ""))
    .filter((line) => line && line !== "[DONE]")
    .map((line) => {
      try {
        return JSON.parse(line).choices?.[0]?.delta?.content || "";
      } catch {
        return "";
      }
    })
    .join("")
    .trim();
};

const callChat = async (messages) => {
  const stored = await chrome.storage.sync.get(SETTINGS_STORAGE_KEY);
  const apiKey = stored[SETTINGS_STORAGE_KEY]?.apiKey || DEFAULT_API_KEY;
  if (!apiKey) {
    throw new Error("请先在插件设置中填写 API Key。");
  }

  const response = await fetch(`${API_CONFIG.url.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: API_CONFIG.model,
      stream: true,
      messages
    })
  });

  return parseChatResponse(response);
};

const debuggerTargets = new Set();

const debuggerTarget = (tabId) => ({ tabId });

const attachDebugger = async (tabId) => {
  if (debuggerTargets.has(tabId)) return;
  await chrome.debugger.attach(debuggerTarget(tabId), "1.3");
  debuggerTargets.add(tabId);
};

const detachDebugger = async (tabId) => {
  if (!debuggerTargets.has(tabId)) return;
  try {
    await chrome.debugger.detach(debuggerTarget(tabId));
  } catch {
    // The tab may already be closed or detached.
  } finally {
    debuggerTargets.delete(tabId);
  }
};

chrome.debugger.onDetach.addListener((source) => {
  if (!source.tabId) return;
  debuggerTargets.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  debuggerTargets.delete(tabId);
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sendDebuggerCommand = (tabId, method, params = {}) => {
  return chrome.debugger.sendCommand(debuggerTarget(tabId), method, params);
};

const dispatchMouseClick = async (tabId, point) => {
  if (!point || typeof point.x !== "number" || typeof point.y !== "number") return;
  const base = { x: point.x, y: point.y, button: "left", clickCount: 1, pointerType: "mouse" };
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
  await sendDebuggerCommand(tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
};

const dispatchKey = async (tabId, type, key, options = {}) => {
  await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type,
    key,
    code: options.code || key,
    windowsVirtualKeyCode: options.keyCode || key.toUpperCase?.().charCodeAt?.(0) || 0,
    nativeVirtualKeyCode: options.keyCode || key.toUpperCase?.().charCodeAt?.(0) || 0,
    modifiers: options.modifiers || 0
  });
};

const clearFocusedEditable = async (tabId) => {
  await dispatchKey(tabId, "rawKeyDown", "End", { code: "End", keyCode: 35 });
  await dispatchKey(tabId, "keyUp", "End", { code: "End", keyCode: 35 });
  await delay(25);
};

const deleteCharactersSlowly = async (tabId, count) => {
  const total = Math.min(500, Math.max(0, Number(count) || 0));
  for (let index = 0; index < total; index += 1) {
    await dispatchKey(tabId, "rawKeyDown", "Backspace", { code: "Backspace", keyCode: 8 });
    await dispatchKey(tabId, "keyUp", "Backspace", { code: "Backspace", keyCode: 8 });
    await delay(18);
  }
};

const clearFocusedEditableSlowly = async (tabId, existingLength) => {
  await clearFocusedEditable(tabId);
  const deleteCount = Math.max(0, Number(existingLength) || 0) + 8;
  await deleteCharactersSlowly(tabId, deleteCount);
  await dispatchKey(tabId, "rawKeyDown", "Backspace", { code: "Backspace", keyCode: 8 });
  await dispatchKey(tabId, "keyUp", "Backspace", { code: "Backspace", keyCode: 8 });
  await delay(35);
};

const replaceTextViaDebugger = async (tabId, text, clickPoints = [], existingLength = 0) => {
  const value = String(text || "");
  if (!tabId || !value) throw new Error("缺少可输入的文本。");

  await attachDebugger(tabId);
  try {
    for (const point of clickPoints.slice(0, 3)) {
      await dispatchMouseClick(tabId, point);
      await delay(45);
    }
    await clearFocusedEditableSlowly(tabId, existingLength);
    await sendDebuggerCommand(tabId, "Input.insertText", { text: value });
    await delay(80);
  } finally {
    await detachDebugger(tabId);
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "MEDIA_DEBUGGER_REPLACE_TEXT") {
    replaceTextViaDebugger(_sender.tab?.id, message.text, message.clickPoints, message.existingLength)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type !== "MEDIA_GENERATE_COMMENT_REPLY" && message?.type !== "XHS_GENERATE_COMMENT_REPLY") return false;

  callChat(message.messages)
    .then((content) => sendResponse({ ok: true, content }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});
