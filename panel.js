const DEFAULT_API_KEY = "";
const API_CONFIG = {
  key: DEFAULT_API_KEY,
  url: "https://new.aicontrol.top",
  model: "gpt-5.5"
};

const BASE_SYSTEM_PROMPT = "你是一个小红书内容分析助手。请基于下面 DOM 抽取的信息回答, 适度精简回答。如需引用链接，不要直接展示裸 URL，请用中文超链接文字表达。";
const DEFAULT_OWNER_REPLY_PROMPT = "这是我自己发布的自媒体内容。请以作者本人/主人公视角回复评论，语气自然真诚，可以适度补充创作背景、个人体验或后续安排，不要生硬营销，不要超过 60 字。";
const DEFAULT_BYSTANDER_REPLY_PROMPT = "这是其他人发布的自媒体内容。请以普通路人视角回复评论，语气自然、有共鸣、有观点，不要冒充作者本人，不要生硬营销，不要超过 60 字。";
const SETTINGS_STORAGE_KEY = "aiAssistantSettings";
const PLATFORM_CONFIG = {
  xiaohongshu: {
    label: "小红书",
    chatEnabled: true,
    contentName: "笔记"
  },
  douyin: {
    label: "抖音",
    chatEnabled: false,
    contentName: "视频"
  },
  unknown: {
    label: "当前网页",
    chatEnabled: false,
    contentName: "页面"
  }
};

const state = {
  page: null,
  messages: [],
  suggestions: [],
  pageSignature: "",
  suggestionSignature: "",
  suggestionRequestId: 0,
  suggestionPromise: null,
  coverInsightSignature: "",
  coverInsightPromise: null,
  backgroundVideo: {
    signature: "",
    running: false,
    completed: []
  },
  confirmDialog: null,
  pendingScreenshot: null,
  settings: {
    apiKey: "",
    ownerReplyPrompt: DEFAULT_OWNER_REPLY_PROMPT,
    bystanderReplyPrompt: DEFAULT_BYSTANDER_REPLY_PROMPT
  }
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const elements = {
  articleTitle: $("#articleTitle"),
  pageStatus: $("#pageStatus"),
  pageStatusText: $("#pageStatusText"),
  pageSummary: $("#pageSummary"),
  suggestionStrip: $("#suggestionStrip"),
  manualRefreshButton: $("#manualRefreshButton"),
  clearChatButton: $("#clearChatButton"),
  promptInput: $("#promptInput"),
  composer: $("#composer"),
  videoFileInput: $("#videoFileInput"),
  videoAnalyzeButton: $("#videoAnalyzeButton"),
  screenshotButton: $("#screenshotButton"),
  screenshotPreview: $("#screenshotPreview"),
  screenshotPreviewImage: $("#screenshotPreviewImage"),
  removeScreenshotButton: $("#removeScreenshotButton"),
  platformActionCard: $("#platformActionCard"),
  platformAiButton: $("#platformAiButton"),
  platformActionHint: $("#platformActionHint"),
  chatFeed: $("#chatFeed"),
  assistantIntro: $("#assistantIntro"),
  modeValue: $("#modeValue"),
  chatView: $("#chatView"),
  settingsView: $("#settingsView"),
  chatNavButton: $("#chatNavButton"),
  settingsNavButton: $("#settingsNavButton"),
  settingsForm: $("#settingsForm"),
  apiKeyInput: $("#apiKeyInput"),
  ownerReplyPromptInput: $("#ownerReplyPromptInput"),
  bystanderReplyPromptInput: $("#bystanderReplyPromptInput"),
  settingsSaveStatus: $("#settingsSaveStatus"),
  refreshConfirm: $("#refreshConfirm"),
  refreshConfirmText: $("#refreshConfirmText"),
  refreshCancelButton: $("#refreshCancelButton"),
  refreshConfirmButton: $("#refreshConfirmButton")
};

const storageGet = (keys) => new Promise((resolve) => chrome.storage.sync.get(keys, resolve));
const storageSet = (items) => new Promise((resolve) => chrome.storage.sync.set(items, resolve));

const cleanApiKey = (value) => String(value || "")
  .replace(/[\u200B-\u200D\uFEFF]/g, "")
  .trim()
  .replace(/^Bearer\s+/i, "")
  .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
  .trim();

const getValidApiKey = (value) => {
  const apiKey = cleanApiKey(value);
  if (!apiKey) return "";
  if (!/^[\x21-\x7E]+$/.test(apiKey)) {
    throw new Error("API Key 含有非法字符，请只粘贴密钥本身，不要包含中文说明、空格或特殊符号。");
  }
  return apiKey;
};

const platformConfig = (pageOrPlatform) => {
  const platform = typeof pageOrPlatform === "string" ? pageOrPlatform : pageOrPlatform?.platform;
  return PLATFORM_CONFIG[platform] || PLATFORM_CONFIG.unknown;
};

const isSupportedPage = (page) => page?.isSupported || page?.isXiaohongshu || page?.isDouyin;
const isXhsNotePage = (page) => {
  if (page?.platform !== "xiaohongshu" && !page?.isXiaohongshu) return false;
  if (page?.isNotePage === true || page?.pageType === "note") return true;
  try {
    const parsed = new URL(page?.url || "");
    return /\/(explore|note)\//.test(parsed.pathname) || /\/discovery\/item\//.test(parsed.pathname);
  } catch {
    return false;
  }
};
const isChatEnabledPage = (page) => Boolean(isSupportedPage(page) && platformConfig(page).chatEnabled && isXhsNotePage(page));

const loadSettings = async () => {
  const stored = await storageGet(SETTINGS_STORAGE_KEY);
  const settings = stored[SETTINGS_STORAGE_KEY] || {};
  state.settings = {
    apiKey: cleanApiKey(settings.apiKey),
    ownerReplyPrompt: settings.ownerReplyPrompt || settings.commentReplyPrompt || DEFAULT_OWNER_REPLY_PROMPT,
    bystanderReplyPrompt: settings.bystanderReplyPrompt || settings.commentReplyPrompt || DEFAULT_BYSTANDER_REPLY_PROMPT
  };
  API_CONFIG.key = state.settings.apiKey;
  elements.apiKeyInput.value = state.settings.apiKey;
  elements.ownerReplyPromptInput.value = state.settings.ownerReplyPrompt;
  elements.bystanderReplyPromptInput.value = state.settings.bystanderReplyPrompt;
};

const saveSettings = async () => {
  const apiKey = getValidApiKey(elements.apiKeyInput.value);
  state.settings = {
    apiKey,
    ownerReplyPrompt: elements.ownerReplyPromptInput.value.trim() || DEFAULT_OWNER_REPLY_PROMPT,
    bystanderReplyPrompt: elements.bystanderReplyPromptInput.value.trim() || DEFAULT_BYSTANDER_REPLY_PROMPT
  };
  API_CONFIG.key = state.settings.apiKey;
  elements.apiKeyInput.value = state.settings.apiKey;
  elements.ownerReplyPromptInput.value = state.settings.ownerReplyPrompt;
  elements.bystanderReplyPromptInput.value = state.settings.bystanderReplyPrompt;
  await storageSet({ [SETTINGS_STORAGE_KEY]: state.settings });
};

const normalizeName = (value) => String(value || "").replace(/\s+/g, "").trim().toLowerCase();

const isOwnPage = (page) => {
  if (page?.platform === "douyin") {
    return Boolean(page?.isOwnPage === true && page?.ownPageConfidence === "high");
  }
  const authorId = String(page?.authorProfileId || "");
  const viewerId = String(page?.viewerProfileId || "");
  return Boolean(authorId && viewerId && authorId === viewerId);
};

const currentReplyPerspective = (page) => {
  if (isOwnPage(page)) {
    return {
      label: "主人公视角",
      prompt: state.settings.ownerReplyPrompt
    };
  }

  return {
    label: "路人视角",
    prompt: state.settings.bystanderReplyPrompt
  };
};

const showView = (view) => {
  // 只切换左侧 content 区域：app-header 和 right-nav 是固定区域，禁止在这里改动。
  const isSettings = view === "settings";
  elements.chatView.hidden = isSettings;
  elements.settingsView.hidden = !isSettings;
  elements.chatNavButton.classList.toggle("active", !isSettings);
  elements.chatNavButton.setAttribute("aria-current", isSettings ? "false" : "page");
  elements.settingsNavButton.classList.toggle("active", isSettings);
  elements.settingsNavButton.setAttribute("aria-current", isSettings ? "page" : "false");

  if (isSettings) {
    elements.apiKeyInput.focus();
  } else {
    elements.promptInput.focus();
  }
};

const setStatus = (text, tone = "idle") => {
  elements.pageStatus.dataset.tone = tone;
  elements.pageStatusText.textContent = text;
  elements.modeValue.textContent = text;
};

const truncate = (text, limit = 180) => {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
};

const getCurrentTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
};

const ensureContentScript = async (tabId) => {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "MEDIA_EXTRACT_PAGE" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  }
};

const extractPage = async () => {
  const tab = await getCurrentTab();
  if (!tab?.id || !tab.url) {
    throw new Error("未找到当前标签页");
  }

  const isXhsUrl = /^https:\/\/([^/]+\.)?xiaohongshu\.com\//i.test(tab.url);
  const isDouyinUrl = /^https:\/\/([^/]+\.)?(douyin|iesdouyin)\.com\//i.test(tab.url);

  if (!isXhsUrl && !isDouyinUrl) {
    return {
      ok: false,
      platform: "unknown",
      platformLabel: "当前网页",
      isSupported: false,
      isXiaohongshu: false,
      isDouyin: false,
      url: tab.url,
      title: tab.title || "AI 浏览助手",
      author: "",
      content: "",
      comments: [],
      media: { type: "unknown", images: [], imageItems: [], videos: [], posters: [], locations: [] }
    };
  }

  await ensureContentScript(tab.id);
  return chrome.tabs.sendMessage(tab.id, { type: "MEDIA_EXTRACT_PAGE" });
};

const buildHiddenSystemPrompt = (page) => {
  if (!isChatEnabledPage(page)) {
    return "";
  }
  const title = page?.title || "未读取到标题";
  const author = page?.author || "未读取到作者";
  const content = page?.content || "未读取到正文";
  const comments = page?.comments?.length
    ? page.comments.map((item, index) => `${index + 1}. ${item}`).join("\n")
    : "未读取到评论";
  const mediaType = page?.media?.type || "unknown";
  const images = page?.media?.imageItems?.length
    ? page.media.imageItems
        .map((item) => {
          const label = item.role === "cover" ? "封面图" : `正文图 ${item.index}`;
          return `${label}: ${item.url}${item.selector ? `\n  DOM: ${item.selector}` : ""}`;
        })
        .join("\n")
    : page?.media?.images?.length
      ? page.media.images.map((item, index) => `${index === 0 ? "封面图" : `正文图 ${index}`}: ${item}`).join("\n")
      : "未读取到图片链接";
  const videos = page?.media?.videos?.length ? page.media.videos.map((item, index) => `${index + 1}. ${item}`).join("\n") : "未读取到视频链接";
  const posters = page?.media?.posters?.length ? page.media.posters.map((item, index) => `${index + 1}. ${item}`).join("\n") : "未读取到视频封面链接";
  const mediaLocations = page?.media?.locations?.length
    ? page.media.locations.map((item, index) => `${index + 1}. ${item.type}: ${item.selector}`).join("\n")
    : "未读取到媒体 DOM 位置";
  const coverInsight = page?.coverInsight || "未生成封面图识别结果";

  const perspective = currentReplyPerspective(page);
  return `${BASE_SYSTEM_PROMPT}\n\n评论回复视角：${perspective.label}\n评论回复提示词：${perspective.prompt}\n视角判定规则：只有作者账号 ID 与当前登录账号 ID 明确一致时才是主人公视角；不一致或未识别到 ID 时必须按路人视角。\n\n页面URL：${page?.url || "-"}\n标题：${title}\n作者：${author}\n作者账号ID：${page?.authorProfileId || "未识别"}\n当前登录用户：${page?.viewerName || "未识别"}\n当前登录账号ID：${page?.viewerProfileId || "未识别"}\n是否判断为自己发布：${isOwnPage(page) ? "是" : "否"}\n媒体类型：${mediaType}\n封面图AI识别：${coverInsight}\n媒体 DOM 位置：\n${mediaLocations}\n图片链接（已按资源去重；第 1 张标为封面图，其余标为正文图）：\n${images}\n视频链接：\n${videos}\n视频封面：\n${posters}\n正文：${content}\n评论：\n${comments}`;
};

const getPageSignature = (page) => {
  return [page?.platform || "", page?.url || "", page?.title || "", page?.author || "", (page?.content || "").slice(0, 800), page?.media?.type || ""].join("|");
};

const setChatControlsEnabled = (enabled) => {
  elements.promptInput.disabled = !enabled;
  elements.screenshotButton.disabled = !enabled;
  elements.videoAnalyzeButton.disabled = false;
  elements.composer.querySelector(".send-button").disabled = !enabled || (!elements.promptInput.value.trim() && !state.pendingScreenshot);
  elements.composer.dataset.disabled = enabled ? "false" : "true";
};

const setPlatformAction = (page) => {
  const isDouyin = page?.platform === "douyin" || page?.isDouyin;
  elements.platformActionCard.hidden = !isDouyin;
  elements.platformAiButton.disabled = !isDouyin;
  elements.platformActionHint.textContent = isDouyin ? "打开抖音页面里的原生问AI。" : "";
};

const clearChat = (introText = "已清空聊天记录。") => {
  state.messages = [];
  elements.chatFeed.innerHTML = `
    <article class="message assistant">
      <div class="avatar">AI</div>
      <div class="bubble"><p id="assistantIntro"></p></div>
    </article>
  `;
  elements.assistantIntro = $("#assistantIntro");
  elements.assistantIntro.textContent = introText;
};

const renderPage = (page, options = {}) => {
  const nextSignature = getPageSignature(page);
  const isSamePage = nextSignature && nextSignature === state.pageSignature;
  if (!options.force && isSamePage) return;

  const platform = platformConfig(page);
  state.page = page;
  setPlatformAction(page);
  state.pageSignature = nextSignature;
  if (!isSamePage) {
    state.suggestions = [];
    state.suggestionSignature = "";
    state.suggestionPromise = null;
    state.coverInsightSignature = "";
    state.coverInsightPromise = null;
    state.backgroundVideo = {
      signature: nextSignature,
      running: false,
      completed: []
    };
  }

  if (!isSupportedPage(page)) {
    clearChat("我还没有读取到支持的平台内容。");
    setChatControlsEnabled(false);
    clearPendingScreenshot();
    setStatus("非支持页面", "warn");
    elements.articleTitle.textContent = truncate(page.title || "AI 浏览助手", 24);
    elements.pageSummary.textContent = "当前页面不是小红书或抖音页面。小红书支持侧栏对话；抖音支持页面内评论 AI 回复。";
    renderSuggestions([]);
    return;
  }

  if (!platform.chatEnabled) {
    clearChat(`${platform.label}已识别。抖音不启用侧栏 AI 对话；打开评论输入框后，可使用页面里的“AI回复”按钮生成评论回复。`);
    setChatControlsEnabled(false);
    clearPendingScreenshot();
    setStatus(`${platform.label}已识别`, "ok");
    elements.articleTitle.textContent = truncate(page.title || `${platform.label}${platform.contentName}`, 28);
    elements.pageSummary.textContent = `作者：${page.author || "未识别"}。媒体：${page.media?.type || "unknown"}。内容：${truncate(page.content || "未读取到内容，可能需要等待页面加载完成。", 130)}`;
    renderSuggestions([]);
    return;
  }

  if (!isXhsNotePage(page)) {
    clearChat("当前小红书页面不是笔记详情页，AI 聊天只支持小红书笔记。请打开具体笔记后再使用。");
    setChatControlsEnabled(false);
    clearPendingScreenshot();
    setStatus("小红书非笔记页", "warn");
    elements.articleTitle.textContent = truncate(page.title || "小红书", 28);
    elements.pageSummary.textContent = "当前识别为小红书页面，但不是笔记详情页。主页、个人页、创作中心、搜索页等暂不支持 AI 聊天。";
    renderSuggestions([]);
    return;
  }

  setChatControlsEnabled(true);
  clearChat(`已切换到新的${platform.label}${platform.contentName}，并清空上一条内容的聊天记录。你可以直接提问。`);
  setStatus(`${platform.label}已识别`, "ok");
  elements.articleTitle.textContent = truncate(page.title || `${platform.label}${platform.contentName}`, 28);
  elements.pageSummary.textContent = `作者：${page.author || "未识别"}。媒体：${page.media?.type || "unknown"}。正文：${truncate(page.content || "未读取到正文，可能需要等待页面加载完成。", 130)}`;
  startBackgroundVideoAnalysis(page);
  generateCoverInsight(page).finally(() => generateSuggestions(state.page || page));
};

const refreshPage = async (options = {}) => {
  try {
    setStatus("页面理解中", "loading");
    const page = await extractPage();
    renderPage(page, options);
  } catch (error) {
    setPlatformAction(null);
    setStatus("读取失败", "error");
    elements.articleTitle.textContent = "AI 浏览助手";
    elements.pageSummary.textContent = error.message;
    elements.assistantIntro.textContent = "当前页面无法读取，请确认扩展权限和页面地址。";
  }
};

const requestRefreshConfirmation = (reason = "检测到页面内容变化") => {
  if (state.confirmDialog) {
    elements.refreshConfirmText.textContent = `${reason}，是否重新读取当前页面并清空当前聊天记录？`;
    return state.confirmDialog;
  }

  elements.refreshConfirmText.textContent = `${reason}，是否重新读取当前页面并清空当前聊天记录？`;
  elements.refreshConfirm.hidden = false;

  state.confirmDialog = new Promise((resolve) => {
    const cleanup = () => {
      elements.refreshConfirm.hidden = true;
      elements.refreshCancelButton.removeEventListener("click", onCancel);
      elements.refreshConfirmButton.removeEventListener("click", onConfirm);
      state.confirmDialog = null;
    };
    const onCancel = () => {
      cleanup();
      resolve(false);
    };
    const onConfirm = () => {
      cleanup();
      resolve(true);
    };

    elements.refreshCancelButton.addEventListener("click", onCancel);
    elements.refreshConfirmButton.addEventListener("click", onConfirm);
    elements.refreshConfirmButton.focus();
  });

  return state.confirmDialog;
};

const appendMessage = (role, text, pending = false, attachments = []) => {
  const article = document.createElement("article");
  article.className = `message ${role}${pending ? " pending" : ""}`;
  article.dataset.rawText = text;

  if (role === "assistant") {
    article.innerHTML = `<div class="avatar">AI</div><div class="bubble"><p></p></div>`;
  } else {
    article.innerHTML = `<div class="bubble"><p></p></div>`;
  }

  setMessageContent(article.querySelector("p"), text);
  if (attachments.length) {
    const attachmentList = document.createElement("div");
    attachmentList.className = "message-attachments";
    attachments.forEach((attachment) => {
      if (attachment.type !== "image" || !attachment.dataUrl) return;
      const image = document.createElement("img");
      image.src = attachment.dataUrl;
      image.alt = attachment.label || "截图";
      attachmentList.appendChild(image);
    });
    article.querySelector(".bubble").appendChild(attachmentList);
  }
  if (role === "assistant" && !pending) {
    addMessageActions(article);
  }
  elements.chatFeed.appendChild(article);
  elements.chatFeed.scrollTop = elements.chatFeed.scrollHeight;
  return article;
};

const addMessageActions = (article) => {
  if (article.querySelector(".message-actions")) return;
  const actions = document.createElement("div");
  actions.className = "message-actions";
  actions.innerHTML = `<button type="button" data-message-action="copy">复制</button><button type="button" data-message-action="delete">删除</button>`;
  article.querySelector(".bubble").appendChild(actions);

  article.querySelector('[data-message-action="copy"]').addEventListener("click", async () => {
    await navigator.clipboard.writeText(article.dataset.rawText || article.innerText);
  });
  article.querySelector('[data-message-action="delete"]').addEventListener("click", () => {
    article.remove();
  });
};

const linkLabelFor = (url, counts) => {
  let label = "相关链接";
  if (/sns-video|\.mp4(\?|$)|\.m3u8(\?|$)/i.test(url)) {
    label = "视频链接";
  } else if (/sns-webpic|xhscdn|\.webp(\?|$)|\.jpe?g(\?|$)|\.png(\?|$)|\.gif(\?|$)/i.test(url)) {
    label = "图片链接";
  } else if (/xiaohongshu\.com/i.test(url)) {
    label = "页面链接";
  }

  counts[label] = (counts[label] || 0) + 1;
  return counts[label] > 1 ? `${label} ${counts[label]}` : label;
};

const setMessageContent = (target, text) => {
  target.textContent = "";
  const counts = {};
  const value = String(text || "");
  const urlPattern = /(https?:\/\/[^\s"'<>，。)、）\]]+)/g;
  let cursor = 0;
  let match;

  while ((match = urlPattern.exec(value))) {
    if (match.index > cursor) {
      target.appendChild(document.createTextNode(value.slice(cursor, match.index)));
    }

    const url = match[0];
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    anchor.textContent = linkLabelFor(url, counts);
    target.appendChild(anchor);
    cursor = match.index + url.length;
  }

  if (cursor < value.length) {
    target.appendChild(document.createTextNode(value.slice(cursor)));
  }
};

const setComposerBusy = (busy) => {
  const canUseComposer = isChatEnabledPage(state.page);
  elements.promptInput.disabled = busy || !canUseComposer;
  elements.screenshotButton.disabled = busy || !canUseComposer;
  elements.videoAnalyzeButton.disabled = busy;
  syncComposerState();
};

const parseChatResponse = async (response) => {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `AI 请求失败：${response.status}`);
  }

  if (!text.trim().startsWith("data:")) {
    const data = JSON.parse(text);
    return data.choices?.[0]?.message?.content?.trim() || "没有收到有效回复。";
  }

  const content = text
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

  return content || "没有收到有效回复。";
};

const callChat = async (messages) => {
  const apiKey = getValidApiKey(API_CONFIG.key);
  if (!apiKey) {
    showView("settings");
    throw new Error("请先在设置中填写 API Key。");
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

const callAudioTranscription = async (file) => {
  const apiKey = getValidApiKey(API_CONFIG.key);
  if (!apiKey) {
    showView("settings");
    throw new Error("请先在设置中填写 API Key。");
  }

  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("file", file, file.name || "video.mp4");
  form.append("response_format", "json");

  const response = await fetch(`${API_CONFIG.url.replace(/\/$/, "")}/v1/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `音频转写失败：${response.status}`);
  }
  try {
    const data = JSON.parse(text);
    return String(data.text || data.content || "").trim();
  } catch {
    return text.trim();
  }
};

const buildUserMessage = (text, screenshot) => {
  const images = Array.isArray(screenshot) ? screenshot : screenshot?.dataUrl ? [screenshot] : [];
  if (!images.length) return { role: "user", content: text };
  return {
    role: "user",
    content: [
      { type: "text", text },
      ...images.map((image) => ({
        type: "image_url",
        image_url: {
          url: image.dataUrl
        }
      }))
    ]
  };
};

const chunkList = (items, size) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const runConcurrent = async (items, concurrency, worker) => {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    const results = [];
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results.push(await worker(items[index], index));
    }
    return results;
  });
  return (await Promise.all(workers)).flat();
};

const summarizeFrameBatch = async (frames, batchIndex) => {
  const labels = frames.map((frame) => `${frame.timeSec.toFixed(1)}s`).join(",");
  const prompt = `只看图，极简中文输出。时间=${labels}。格式：场景/人物/动作/文字/可用卖点。每图1行，每行<=35字。`;
  return callChat([
    { role: "system", content: "视频帧识别。只写看见的，不推理，不解释。" },
    buildUserMessage(prompt, frames)
  ]).then((summary) => `批次${batchIndex + 1} ${labels}\n${summary}`);
};

const summarizeFramesFast = async (frames, options = {}) => {
  const batchSize = options.batchSize || 2;
  const concurrency = options.concurrency || 6;
  const batches = chunkList(frames, batchSize);
  const settled = await runConcurrent(batches, concurrency, (batch, index) => {
    return summarizeFrameBatch(batch, index)
      .then((value) => ({ status: "fulfilled", value }))
      .catch((reason) => ({ status: "rejected", reason }));
  });
  return settled
    .map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      const labels = batches[index].map((frame) => `${frame.timeSec.toFixed(1)}s`).join(",");
      return `批次${index + 1} ${labels}\n识别失败：${result.reason?.message || "未知错误"}`;
    })
    .join("\n\n");
};

const seekVideo = (video, timeSec, timeoutMs = 4500) => {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onSeeked = () => finish(resolve);
    const onError = () => finish(reject, new Error("视频跳转失败"));
    const timer = window.setTimeout(() => finish(reject, new Error("视频抽帧超时")), timeoutMs);
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = timeSec;
  });
};

const loadVideoMetadata = (video, url) => {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
    };
    const onLoaded = () => {
      cleanup();
      resolve({
        durationSec: Number.isFinite(video.duration) ? video.duration : 0,
        width: video.videoWidth || 0,
        height: video.videoHeight || 0
      });
    };
    const onError = () => {
      cleanup();
      reject(new Error("无法读取视频文件，请确认是浏览器可播放的 MP4/WebM/MOV。"));
    };
    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    video.load();
  });
};

const canvasDataUrl = (canvas, preferredType = "image/webp", quality = 0.82) => {
  const dataUrl = canvas.toDataURL(preferredType, quality);
  if (dataUrl.startsWith(`data:${preferredType}`)) return dataUrl;
  return canvas.toDataURL("image/jpeg", quality);
};

const extractVideoFrames = async (file, options = {}) => {
  const maxFrames = options.maxFrames || 10;
  const maxLongEdge = options.maxLongEdge || 768;
  const concurrency = Math.max(1, Math.min(options.concurrency || 3, 4));
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");

  try {
    const metadata = await loadVideoMetadata(video, url);
    if (!metadata.durationSec || !metadata.width || !metadata.height) {
      throw new Error("视频元信息不完整，无法抽帧。");
    }

    const scale = Math.min(1, maxLongEdge / Math.max(metadata.width, metadata.height));
    const frameWidth = Math.max(1, Math.round(metadata.width * scale));
    const frameHeight = Math.max(1, Math.round(metadata.height * scale));

    const totalFrames = Math.max(1, Math.min(maxFrames, Math.ceil(metadata.durationSec)));
    const intervalSec = metadata.durationSec / totalFrames;
    const jobs = Array.from({ length: totalFrames }, (_, index) => ({
      index,
      timeSec: Math.min(Math.max(0, metadata.durationSec - 0.05), index * intervalSec)
    }));

    const runFrameJob = async (job) => {
      const frameUrl = URL.createObjectURL(file);
      const frameVideo = document.createElement("video");
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("当前浏览器不支持 canvas 抽帧。");
      canvas.width = frameWidth;
      canvas.height = frameHeight;
      try {
        await loadVideoMetadata(frameVideo, frameUrl);
        await seekVideo(frameVideo, job.timeSec);
        context.drawImage(frameVideo, 0, 0, canvas.width, canvas.height);
        return {
          type: "image",
          dataUrl: canvasDataUrl(canvas),
          label: `视频帧 ${job.index + 1} / ${totalFrames}，${job.timeSec.toFixed(2)}s`,
          timeSec: job.timeSec,
          index: job.index
        };
      } finally {
        frameVideo.removeAttribute("src");
        frameVideo.load();
        URL.revokeObjectURL(frameUrl);
      }
    };

    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      const results = [];
      while (cursor < jobs.length) {
        const job = jobs[cursor];
        cursor += 1;
        try {
          results.push(await runFrameJob(job));
        } catch {
          // Skip individual bad frames and keep the rest of the analysis usable.
        }
      }
      return results;
    });
    const frames = (await Promise.all(workers))
      .flat()
      .sort((a, b) => a.index - b.index)
      .map(({ index, ...frame }) => frame);

    if (!frames.length) throw new Error("没有成功抽取到视频画面。");
    return {
      metadata: {
        source: "local_file",
        fileName: file.name,
        fileSize: file.size,
        durationSec: metadata.durationSec,
        width: metadata.width,
        height: metadata.height,
        frameExtraction: {
          mode: "uniform",
          maxFrames: totalFrames,
          extractedFrames: frames.length,
          intervalSec,
          format: frames[0]?.dataUrl?.startsWith("data:image/webp") ? "image/webp" : "image/jpeg",
          maxLongEdge,
          quality: 0.82,
          concurrency
        },
        audioExtraction: {
          enabled: true,
          method: "server_transcription",
          endpoint: "/v1/audio/transcriptions"
        }
      },
      frames
    };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
};

// 本地视频抽帧分析功能已完成并冻结：除非明确重开该需求，不要改动 analyzeLocalVideo 及其直接抽帧/并发识别流程。
const analyzeLocalVideo = async (file) => {
  if (!file) return;
  if (!file.type.startsWith("video/")) {
    appendMessage("assistant", "请选择 MP4、MOV、WebM 等视频文件。");
    return;
  }
  if (file.size > 200 * 1024 * 1024) {
    appendMessage("assistant", "视频超过 200MB，建议先剪成 5 分钟以内再分析。");
    return;
  }

  appendMessage("user", `分析本地视频：${file.name}`);
  const pending = appendMessage("assistant", "正在并发抽取画面，并识别视频声音...", true);
  setComposerBusy(true);

  try {
    const frameTask = extractVideoFrames(file, { maxFrames: 12, maxLongEdge: 640, concurrency: 3 });
    const transcriptTask = callAudioTranscription(file).catch((error) => `音频转写失败：${error.message}`);
    const [{ metadata, frames }, transcript] = await Promise.all([frameTask, transcriptTask]);
    pending.classList.remove("pending");
    pending.dataset.rawText = "视频抽帧完成，正在提交 AI 分析...";
    const hasTranscript = transcript && !transcript.startsWith("音频转写失败：");
    setMessageContent(
      pending.querySelector("p"),
      `已并发抽取 ${frames.length} 张画面，视频 ${metadata.durationSec.toFixed(1)} 秒，${metadata.width}×${metadata.height}。${hasTranscript ? "已识别声音，" : "声音识别未完成，"}正在提交 AI 分析...`
    );
    const frameSummary = await summarizeFramesFast(frames, { batchSize: 2, concurrency: 6 });
    setMessageContent(pending.querySelector("p"), "画面并发识别完成，正在整合视频结论...");

    const prompt = `基于视频帧摘要和音频转写，输出：1总结 2时间线 3口播要点 4标题/卖点/脚本建议。别废话。\n\n元信息：${JSON.stringify(metadata)}\n\n帧摘要：\n${frameSummary}\n\n音频：\n${transcript || "无"}`;
    const answer = await callChat([
      {
        role: "system",
        content:
          "自媒体视频分析助手。基于帧摘要和音频转写，简洁输出可执行结论。"
      },
      { role: "user", content: prompt }
    ]);

    pending.dataset.rawText = answer;
    setMessageContent(pending.querySelector("p"), answer);
    addMessageActions(pending);
    state.messages.push({ role: "user", content: `分析本地视频：${file.name}` }, { role: "assistant", content: answer });
  } catch (error) {
    pending.classList.remove("pending");
    const errorText = `视频分析失败：${error.message}`;
    pending.dataset.rawText = errorText;
    setMessageContent(pending.querySelector("p"), errorText);
    addMessageActions(pending);
  } finally {
    setComposerBusy(false);
    elements.videoFileInput.value = "";
  }
};

const extractVideoFramesFromUrl = async (videoUrl, options = {}) => {
  const maxFrames = options.maxFrames || 8;
  const maxLongEdge = options.maxLongEdge || 512;
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("当前浏览器不支持 canvas 抽帧。");

  try {
    const metadata = await loadVideoMetadata(video, videoUrl);
    if (!metadata.durationSec || !metadata.width || !metadata.height) {
      throw new Error("视频元信息不完整，无法抽帧。");
    }
    const scale = Math.min(1, maxLongEdge / Math.max(metadata.width, metadata.height));
    canvas.width = Math.max(1, Math.round(metadata.width * scale));
    canvas.height = Math.max(1, Math.round(metadata.height * scale));
    const totalFrames = Math.max(1, Math.min(maxFrames, Math.ceil(metadata.durationSec)));
    const intervalSec = metadata.durationSec / totalFrames;
    const frames = [];
    for (let index = 0; index < totalFrames; index += 1) {
      const timeSec = Math.min(Math.max(0, metadata.durationSec - 0.05), index * intervalSec);
      try {
        await seekVideo(video, timeSec);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push({
          type: "image",
          dataUrl: canvasDataUrl(canvas, "image/jpeg", 0.72),
          label: `网页视频帧 ${index + 1} / ${totalFrames}，${timeSec.toFixed(2)}s`,
          timeSec
        });
      } catch {
        // Keep partial background analysis available.
      }
    }
    if (!frames.length) throw new Error("没有成功抽取到视频画面。");
    return {
      metadata: {
        source: "xiaohongshu_page_video",
        videoUrl,
        durationSec: metadata.durationSec,
        width: metadata.width,
        height: metadata.height,
        frameExtraction: {
          mode: "uniform",
          maxFrames: totalFrames,
          extractedFrames: frames.length,
          intervalSec,
          format: "image/jpeg",
          maxLongEdge,
          quality: 0.72
        }
      },
      frames
    };
  } finally {
    video.removeAttribute("src");
    video.load();
  }
};

const startBackgroundVideoAnalysis = (page) => {
  // 小红书视频链接识别、后台抽帧与解析功能已验收冻结：除非明确重开该需求，不要改动这条链路。
  if (!isChatEnabledPage(page)) return;
  const videos = (page?.media?.videos || []).filter((url) => /^https?:\/\//i.test(url) && !/\.m3u8(\?|$)/i.test(url)).slice(0, 3);
  if (!videos.length) return;

  const signature = `${getPageSignature(page)}|${videos.join("|")}`;
  if (state.backgroundVideo.signature === signature && (state.backgroundVideo.running || state.backgroundVideo.completed.length)) return;
  state.backgroundVideo = {
    signature,
    running: true,
    completed: []
  };

  runConcurrent(videos, 3, async (videoUrl, index) => {
    try {
      const { metadata, frames } = await extractVideoFramesFromUrl(videoUrl, { maxFrames: 8, maxLongEdge: 512 });
      const frameSummary = await summarizeFramesFast(frames, { batchSize: 2, concurrency: 4 });
      if (state.backgroundVideo.signature !== signature) return null;
      const summary = `小红书视频${index + 1}：${metadata.durationSec.toFixed(1)}秒，${metadata.width}x${metadata.height}\n${frameSummary}`;
      state.backgroundVideo.completed.push(summary);
      return summary;
    } catch (error) {
      if (state.backgroundVideo.signature !== signature) return null;
      state.backgroundVideo.completed.push(`小红书视频${index + 1}：后台解析失败：${error.message}`);
      return null;
    }
  }).finally(() => {
    if (state.backgroundVideo.signature === signature) {
      state.backgroundVideo.running = false;
    }
  });
};

const currentBackgroundVideoPrompt = () => {
  if (!state.backgroundVideo.completed.length) return "";
  return `\n\n当前小红书视频后台解析（只包含已完成部分，后台仍可继续运行）：\n${state.backgroundVideo.completed.join("\n\n")}`;
};

const shouldAttachArticleImages = (text) => {
  return /图片|图里|图中|画面|封面|截图|照片|海报|读图|看图|image|photo|picture/i.test(text || "");
};

const dataUrlFromBlob = (blob) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
};

const fetchImageAsDataUrl = async (url) => {
  const response = await fetch(url, { credentials: "omit", cache: "force-cache" });
  if (!response.ok) throw new Error(`图片读取失败：${response.status}`);
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("资源不是图片");
  return dataUrlFromBlob(blob);
};

const articleImageInputs = async (page, limit = 4) => {
  const items = page?.media?.imageItems?.length
    ? page.media.imageItems
    : (page?.media?.images || []).map((url, index) => ({ url, role: index === 0 ? "cover" : "body", index }));
  const urls = items.map((item) => item.url).filter(Boolean).slice(0, limit);
  const results = await Promise.allSettled(
    urls.map(async (url, index) => ({
      type: "image",
      dataUrl: await fetchImageAsDataUrl(url),
      label: index === 0 ? "文章封面图" : `文章正文图 ${index}`,
      sourceUrl: url
    }))
  );
  return results.filter((result) => result.status === "fulfilled").map((result) => result.value);
};

const coverImageInput = async (page) => {
  const cover =
    page?.media?.imageItems?.find((item) => item.role === "cover") ||
    (page?.media?.images?.[0] ? { url: page.media.images[0] } : null) ||
    (page?.media?.posters?.[0] ? { url: page.media.posters[0] } : null);
  if (!cover?.url) return null;
  return {
    type: "image",
    dataUrl: await fetchImageAsDataUrl(cover.url),
    label: "文章封面图",
    sourceUrl: cover.url
  };
};

const generateCoverInsight = async (page) => {
  if (!isChatEnabledPage(page)) return "";
  const signature = `${getPageSignature(page)}|${page?.media?.imageItems?.[0]?.url || page?.media?.images?.[0] || page?.media?.posters?.[0] || ""}`;
  if (!signature || state.coverInsightSignature === signature || state.coverInsightPromise) return state.coverInsightPromise;

  state.coverInsightSignature = signature;
  state.coverInsightPromise = (async () => {
    const cover = await coverImageInput(page);
    if (!cover) return "";
    const insight = await callChat([
      {
        role: "system",
        content:
          "你是小红书封面图识别助手。请只基于输入图片，精简描述封面里能看到的主体、文字、场景、风格和可能传达的信息。不要编造看不到的内容。"
      },
      buildUserMessage("识别这张小红书笔记封面图，输出 80 字以内摘要。", cover)
    ]);
    if (state.page && getPageSignature(state.page) === getPageSignature(page)) {
      state.page.coverInsight = insight;
      elements.pageSummary.textContent = `作者：${state.page.author || "未识别"}。媒体：${state.page.media?.type || "unknown"}。封面：${truncate(insight, 70)}。正文：${truncate(state.page.content || "未读取到正文。", 90)}`;
    }
    return insight;
  })()
    .catch(() => "")
    .finally(() => {
      state.coverInsightPromise = null;
    });

  return state.coverInsightPromise;
};

const callAi = async (userText, screenshot = null) => {
  if (!isChatEnabledPage(state.page)) {
    throw new Error("当前平台不支持侧栏 AI 对话。抖音请使用页面评论框旁的 AI回复。");
  }
  const autoImages = !screenshot && shouldAttachArticleImages(userText) ? await articleImageInputs(state.page) : [];
  const images = screenshot ? [screenshot] : autoImages;
  const imageHint = autoImages.length
    ? `\n\n插件已自动把当前文章图片作为视觉输入附加到本次消息中，共 ${autoImages.length} 张。回答图片内容时必须基于这些视觉输入，不要说“只能看到链接”。`
    : "";
  const videoHint = currentBackgroundVideoPrompt();
  return callChat([
    { role: "system", content: `${buildHiddenSystemPrompt(state.page)}${imageHint}${videoHint}` },
    ...state.messages,
    buildUserMessage(userText, images)
  ]);
};

const parseSuggestionText = (text) => {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^[-*\d.\s、]+/, "").trim())
    .filter(Boolean)
    .slice(0, 4);
};

const renderSuggestions = (suggestions, loading = false) => {
  elements.suggestionStrip.innerHTML = "";

  if (loading) {
    const item = document.createElement("span");
    item.className = "suggestion-loading";
    item.textContent = "正在根据文章生成问题...";
    elements.suggestionStrip.appendChild(item);
    return;
  }

  if (!suggestions.length) {
    const item = document.createElement("span");
    item.className = "suggestion-loading";
    item.textContent = "暂无可用建议问题";
    elements.suggestionStrip.appendChild(item);
    return;
  }

  suggestions.forEach((question) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = question;
    button.addEventListener("click", () => {
      elements.promptInput.value = question;
      autoResizeInput();
      syncComposerState();
      elements.promptInput.focus();
    });
    elements.suggestionStrip.appendChild(button);
  });
};

const generateSuggestions = async (page) => {
  if (!isChatEnabledPage(page)) {
    renderSuggestions([]);
    return;
  }
  const signature = getPageSignature(page);
  if (!signature) return;

  if (state.suggestionSignature === signature && state.suggestions.length) {
    renderSuggestions(state.suggestions);
    return;
  }

  if (state.suggestionSignature === signature && state.suggestionPromise) {
    return state.suggestionPromise;
  }

  const requestId = ++state.suggestionRequestId;
  state.suggestionSignature = signature;
  renderSuggestions([], true);

  state.suggestionPromise = (async () => {
    const text = await callChat([
      { role: "system", content: buildHiddenSystemPrompt(page) },
      {
        role: "user",
        content:
          "请根据这篇小红书笔记，生成 4 个用户最可能想继续追问的问题。要求：只输出问题本身；每行一个；必须和文章内容强相关；不要泛泛而谈；不要输出编号以外的解释。"
      }
    ]);
    const suggestions = parseSuggestionText(text);
    if (requestId !== state.suggestionRequestId) return;
    state.suggestions = suggestions;
    renderSuggestions(suggestions);
  })()
    .catch(() => {
      if (requestId !== state.suggestionRequestId) return;
      state.suggestions = [];
      renderSuggestions([]);
    })
    .finally(() => {
      if (requestId === state.suggestionRequestId) {
        state.suggestionPromise = null;
      }
    });

  return state.suggestionPromise;
};

const syncComposerState = () => {
  if (!isChatEnabledPage(state.page)) {
    elements.composer.querySelector(".send-button").disabled = true;
    return;
  }
  const hasText = elements.promptInput.value.trim().length > 0;
  const hasScreenshot = Boolean(state.pendingScreenshot);
  elements.composer.querySelector(".send-button").disabled = (!hasText && !hasScreenshot) || elements.promptInput.disabled;
};

const autoResizeInput = () => {
  elements.promptInput.style.height = "0px";
  const nextHeight = Math.min(Math.max(elements.promptInput.scrollHeight, 49), 120);
  elements.promptInput.style.height = `${nextHeight}px`;
};

const submitQuestion = async (text) => {
  if (!isChatEnabledPage(state.page)) return;
  const question = text.trim();
  const screenshot = state.pendingScreenshot;
  if (!question && !screenshot) return;
  const displayText = question || "请分析这张截图。";

  appendMessage("user", displayText, false, screenshot ? [screenshot] : []);
  elements.promptInput.value = "";
  clearPendingScreenshot();
  autoResizeInput();
  syncComposerState();
  setComposerBusy(true);

  const pending = appendMessage("assistant", "正在思考...", true);

  try {
    const answer = await callAi(displayText, screenshot);
    pending.classList.remove("pending");
    pending.dataset.rawText = answer;
    setMessageContent(pending.querySelector("p"), answer);
    addMessageActions(pending);
    state.messages.push({ role: "user", content: displayText }, { role: "assistant", content: answer });
  } catch (error) {
    pending.classList.remove("pending");
    const errorText = `请求失败：${error.message}`;
    pending.dataset.rawText = errorText;
    setMessageContent(pending.querySelector("p"), errorText);
    addMessageActions(pending);
  } finally {
    setComposerBusy(false);
    elements.promptInput.focus();
  }
};

const renderPendingScreenshot = () => {
  if (!state.pendingScreenshot) {
    elements.screenshotPreview.hidden = true;
    elements.screenshotPreviewImage.removeAttribute("src");
    return;
  }
  elements.screenshotPreviewImage.src = state.pendingScreenshot.dataUrl;
  elements.screenshotPreview.hidden = false;
};

const clearPendingScreenshot = () => {
  state.pendingScreenshot = null;
  renderPendingScreenshot();
};

const setPendingImage = (dataUrl, label = "粘贴图片") => {
  state.pendingScreenshot = {
    type: "image",
    dataUrl,
    label,
    capturedAt: new Date().toISOString()
  };
  renderPendingScreenshot();
  syncComposerState();
};

const readFileAsDataUrl = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
};

const captureCurrentTabScreenshot = async () => {
  const tab = await getCurrentTab();
  if (!tab?.windowId) throw new Error("未找到当前标签页");
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 82 });
  setPendingImage(dataUrl, "当前页面截图");
};

const openPlatformAi = async () => {
  const tab = await getCurrentTab();
  if (!tab?.id) throw new Error("未找到当前标签页");
  await ensureContentScript(tab.id);
  const response = await chrome.tabs.sendMessage(tab.id, { type: "MEDIA_OPEN_PLATFORM_AI" });
  if (!response?.ok) throw new Error(response?.error || "已尝试打开评论区，请在视频详情页重试。");
  return response;
};

$$(".quick-card button").forEach((button) => {
  button.addEventListener("click", () => {
    const question = button.dataset.question || button.textContent.trim();
    elements.promptInput.value = question;
    autoResizeInput();
    syncComposerState();
    elements.promptInput.focus();
  });
});

elements.promptInput.addEventListener("input", () => {
  autoResizeInput();
  syncComposerState();
});

elements.promptInput.addEventListener("paste", async (event) => {
  const items = Array.from(event.clipboardData?.items || []);
  const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));
  if (!imageItem) return;

  const file = imageItem.getAsFile();
  if (!file) return;

  event.preventDefault();
  try {
    const dataUrl = await readFileAsDataUrl(file);
    setPendingImage(dataUrl, "粘贴图片");
    elements.promptInput.focus();
  } catch (error) {
    appendMessage("assistant", `图片粘贴失败：${error.message}`);
  }
});

elements.screenshotButton.addEventListener("click", async () => {
  elements.screenshotButton.disabled = true;
  try {
    await captureCurrentTabScreenshot();
  } catch (error) {
    appendMessage("assistant", `截图失败：${error.message}`);
  } finally {
    elements.screenshotButton.disabled = false;
    elements.promptInput.focus();
  }
});

elements.videoAnalyzeButton.addEventListener("click", () => {
  elements.videoFileInput.click();
});

elements.videoFileInput.addEventListener("change", () => {
  const file = elements.videoFileInput.files?.[0];
  analyzeLocalVideo(file);
});

elements.removeScreenshotButton.addEventListener("click", () => {
  clearPendingScreenshot();
  syncComposerState();
  elements.promptInput.focus();
});

elements.platformAiButton.addEventListener("click", async () => {
  elements.platformAiButton.disabled = true;
  elements.platformActionHint.textContent = "正在打开抖音问AI...";
  try {
    const response = await openPlatformAi();
    elements.platformActionHint.textContent = response?.opened === "ask-ai" ? "已打开抖音问AI。" : "已尝试打开评论区和问AI。";
  } catch (error) {
    elements.platformActionHint.textContent = "已尝试打开评论区，请在视频详情页重试。";
  } finally {
    elements.platformAiButton.disabled = false;
  }
});

elements.promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  submitQuestion(elements.promptInput.value);
});

elements.clearChatButton.addEventListener("click", () => {
  if (isChatEnabledPage(state.page)) {
    clearChat("聊天记录已清空。当前文章上下文仍会继续带入后续对话。");
    return;
  }
  clearChat("聊天记录已清空。当前平台不启用侧栏 AI 对话。");
});

elements.manualRefreshButton.addEventListener("click", async () => {
  const confirmed = await requestRefreshConfirmation("你正在手动刷新当前页面内容");
  if (!confirmed) return;

  elements.manualRefreshButton.disabled = true;
  try {
    await refreshPage({ force: true });
  } finally {
    elements.manualRefreshButton.disabled = false;
  }
});

elements.chatNavButton.addEventListener("click", () => {
  showView("chat");
});

elements.settingsNavButton.addEventListener("click", () => {
  showView("settings");
});

elements.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  window.clearTimeout(elements.settingsSaveStatus.dataset.timer);
  try {
    await saveSettings();
    elements.settingsSaveStatus.textContent = "已保存";
    const timer = window.setTimeout(() => {
      elements.settingsSaveStatus.textContent = "";
    }, 1800);
    elements.settingsSaveStatus.dataset.timer = String(timer);
  } catch (error) {
    elements.settingsSaveStatus.textContent = error.message || "保存失败";
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "MEDIA_PAGE_CHANGED" || message?.type === "XHS_PAGE_CHANGED") {
    requestRefreshConfirmation("检测到页面内容变化").then((confirmed) => {
      if (confirmed) refreshPage();
    });
  }
});

(async () => {
  await loadSettings();
  autoResizeInput();
  syncComposerState();
  refreshPage();
})();
