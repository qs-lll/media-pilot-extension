(() => {
  if (window.__mediaAssistantDomBridgeLoaded) return;
  window.__mediaAssistantDomBridgeLoaded = true;
  window.__xhsDomBridgeLoaded = true;

  let lastSignature = "";
  let replyButtonSyncTimer = 0;
  let lastReplyButtonPlacement = "";
  const observers = [];
  const observedNodes = new WeakSet();
  const PLATFORM_LABELS = {
    xiaohongshu: "小红书",
    douyin: "抖音",
    unknown: "当前网页"
  };
  const keySelectors = [
    ".note-detail-mask",
    ".note-container",
    ".note-content",
    ".author-wrapper",
    "#detail-title",
    "#detail-desc",
    "#slidelist",
    "[data-e2e='feed-active-video']",
    "[data-e2e='browse-video']",
    "[data-e2e='video-detail']",
    "[data-e2e='comment-list']",
    "[data-e2e='comment-input']",
    "[class*='comment']",
    "article"
  ];

  const normalizeUrl = (value) => {
    if (!value) return "";
    const raw = String(value).trim();
    if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return "";
    try {
      return new URL(raw, location.href).href;
    } catch {
      return "";
    }
  };

  const platformFromLocation = () => {
    const host = location.hostname;
    if (/(^|\.)xiaohongshu\.com$/i.test(host)) return "xiaohongshu";
    if (/(^|\.)douyin\.com$/i.test(host) || /(^|\.)iesdouyin\.com$/i.test(host)) return "douyin";
    return "unknown";
  };

  const platformLabel = (platform = platformFromLocation()) => PLATFORM_LABELS[platform] || "当前网页";

  const textFrom = (selectors, root = document) => {
    for (const selector of selectors) {
      const element = root.querySelector?.(selector);
      const text = element?.innerText || element?.textContent || element?.getAttribute?.("content");
      if (text?.trim()) return text.trim();
    }
    return "";
  };

  const attrFrom = (selectors, attributes, root = document) => {
    for (const selector of selectors) {
      const element = root.querySelector?.(selector);
      if (!element) continue;
      for (const attribute of attributes) {
        const value = element.getAttribute?.(attribute) || element[attribute];
        if (value) return String(value).trim();
      }
    }
    return "";
  };

  const compact = (value, limit = 4000) => {
    const text = String(value || "")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  };

  const looksLikeUrl = (text) => {
    return (
      /^https?:\/\//i.test(text) ||
      /^www\./i.test(text) ||
      /xiaohongshu\.com/i.test(text) ||
      /douyin\.com/i.test(text) ||
      /iesdouyin\.com/i.test(text)
    );
  };

  const addUnique = (list, value) => {
    const url = normalizeUrl(value);
    if (url && !list.includes(url)) list.push(url);
  };

  const pathFor = (element) => {
    const parts = [];
    for (let node = element; node && node.nodeType === 1 && parts.length < 6; node = node.parentElement) {
      let item = node.tagName.toLowerCase();
      if (node.id) item += `#${node.id}`;
      if (typeof node.className === "string" && node.className.trim()) {
        item += `.${node.className.trim().split(/\s+/).slice(0, 3).join(".")}`;
      }
      parts.unshift(item);
    }
    return parts.join(" > ");
  };

  const firstSrcsetUrl = (srcset) => {
    return String(srcset || "")
      .split(",")
      .map((item) => item.trim().split(/\s+/)[0])
      .find(Boolean);
  };

  const imageIdentity = (value) => {
    const url = normalizeUrl(value);
    if (!url) return "";
    try {
      const parsed = new URL(url);
      return parsed.pathname
        .replace(/^\/\d{12,}\//, "/")
        .replace(/!.+$/, "")
        .replace(/\/format\/[^/|]+/g, "")
        .replace(/\|.+$/, "");
    } catch {
      return url.replace(/!.+$/, "");
    }
  };

  const profileIdFromHref = (href, platform = platformFromLocation()) => {
    const url = normalizeUrl(href);
    if (!url) return "";
    try {
      const pathname = new URL(url).pathname;
      if (platform === "douyin") {
        const id =
          pathname.match(/\/user\/([^/?#]+)/)?.[1] ||
          pathname.match(/\/share\/user\/([^/?#]+)/)?.[1] ||
          "";
        const decoded = decodeURIComponent(id || "").trim();
        return /^(self|me|mine|personal)$/i.test(decoded) ? "" : decoded;
      }
      return pathname.match(/\/user\/profile\/([^/?#]+)/)?.[1] || "";
    } catch {
      return "";
    }
  };

  const firstProfileId = (selectors, platform = platformFromLocation()) => {
    for (const selector of selectors) {
      const link = document.querySelector(selector);
      const id = profileIdFromHref(link?.getAttribute?.("href") || link?.href, platform);
      if (id) return id;
    }
    return "";
  };

  const normalizeName = (value) => String(value || "").replace(/\s+/g, "").trim().toLowerCase();

  const parseJsonScripts = (limit = 8) => {
    const results = [];
    const scripts = Array.from(document.querySelectorAll("script[type='application/json'], script#__NEXT_DATA__"));
    for (const script of scripts.slice(0, limit)) {
      const raw = script.textContent || "";
      if (!raw.trim() || raw.length > 2000000) continue;
      try {
        results.push(JSON.parse(raw));
      } catch {
        // Ignore non-JSON hydration payloads.
      }
    }
    return results;
  };

  const walkJson = (value, visit, depth = 0, seen = new WeakSet()) => {
    if (value == null || depth > 8) return;
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (visit(value) === false) return;
    if (Array.isArray(value)) {
      value.slice(0, 80).forEach((item) => walkJson(item, visit, depth + 1, seen));
      return;
    }
    Object.keys(value)
      .slice(0, 120)
      .forEach((key) => walkJson(value[key], visit, depth + 1, seen));
  };

  const metaContent = (selectors) => {
    return attrFrom(selectors, ["content"]);
  };

  const viewerFromLocalState = (platform = platformFromLocation()) => {
    const platformPattern = platform === "douyin" ? /user|login|account|profile|self|mine|douyin|aweme|passport/i : /user|login|account|profile|self|mine/i;
    const keys = Object.keys(localStorage || {}).filter((key) => platformPattern.test(key));
    for (const key of keys) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw || raw.length > 20000) continue;
        const value = raw.startsWith("{") || raw.startsWith("[") ? JSON.parse(raw) : raw;
        const text = JSON.stringify(value);
        const id =
          text.match(/"(?:sec_uid|secUid|uid|userId|user_id|userid|id)"\s*:\s*"([^"]{6,})"/i)?.[1] ||
          text.match(/"(?:uid|userId|user_id|userid|id)"\s*:\s*(\d{6,})/i)?.[1] ||
          "";
        const name = text.match(/"(?:nickname|nickName|userName|username|name|displayName)"\s*:\s*"([^"]{1,80})"/i)?.[1] || "";
        if (id || name) return { profileId: id, name: compact(name, 80) };
      } catch {
        // Ignore unreadable app state entries.
      }
    }
    return { profileId: "", name: "" };
  };

  const viewerFrom = (platform = platformFromLocation()) => {
    const local = platform === "douyin" ? { profileId: "", name: "" } : viewerFromLocalState(platform);
    if (platform === "douyin") {
      const mineLink = Array.from(document.querySelectorAll("a[href*='/user/'], a[href*='/share/user/']")).find((link) => {
        const href = link.getAttribute("href") || link.href || "";
        const text = compact(link.innerText || link.textContent || link.getAttribute?.("aria-label"), 40);
        return /mine|personal|self|web_mine|channel_type=web_mine|source=web_mine/i.test(href) || /^(我的|个人主页|主页)$/.test(text);
      });
      const profileId = profileIdFromHref(mineLink?.getAttribute?.("href") || mineLink?.href, platform);
      const name = mineLink ? compact(mineLink.innerText || mineLink.textContent || mineLink.getAttribute?.("aria-label"), 80) : "";
      return {
        profileId: profileId || local.profileId,
        name: compact(name || local.name, 80)
      };
    }

    const profileId = firstProfileId(
      [
        "a[href*='/user/profile/'][href*='channel_type=web_mine']",
        "a[href*='/user/profile/'][href*='source=web_mine']",
        "a[href*='/user/profile/'][href*='web_mine']",
        ".user-side a[href*='/user/profile/']",
        ".side-bar a[href*='/user/profile/']",
        "header a[href*='/user/profile/']"
      ],
      platform
    );
    const name = textFrom([
      ".user-side .username",
      ".side-bar .username",
      "header .username",
      "[class*='user'] [class*='name']"
    ]);
    return {
      profileId: profileId || local.profileId,
      name: compact(name || local.name, 80)
    };
  };

  const titleFromXhs = () => {
    const direct = textFrom([
      "#detail-title span",
      "#detail-title",
      ".note-content .title span",
      ".note-content .title",
      ".note-detail-main .title span",
      ".note-detail-main .title"
    ]);
    if (direct && !looksLikeUrl(direct)) return direct;

    const candidates = Array.from(document.querySelectorAll(".note-content span, .note-detail-main span, article span"))
      .map((node) => compact(node.innerText || node.textContent, 220))
      .filter((text) => text.length >= 8 && !looksLikeUrl(text));

    return candidates.sort((a, b) => b.length - a.length)[0] || "";
  };

  const douyinJsonCandidates = () => {
    const candidates = [];
    parseJsonScripts().forEach((json) => {
      walkJson(json, (node) => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return;
        const desc = node.desc || node.description || node.title || node.share_desc || node.shareDesc;
        const hasAweme = node.aweme_id || node.awemeId || node.itemId || node.item_id || node.video || node.video_info || node.videoInfo;
        if (!desc && !hasAweme) return;
        const author = node.author || node.authorInfo || node.user || node.userInfo || {};
        const video = node.video || node.video_info || node.videoInfo || {};
        candidates.push({ node, author, video });
      });
    });
    return candidates;
  };

  const douyinItemIdFromNode = (node = {}) => {
    return String(node.aweme_id || node.awemeId || node.itemId || node.item_id || node.id || "").trim();
  };

  const currentDouyinItemIdFromUrl = () => {
    try {
      const parsed = new URL(location.href);
      return (
        parsed.searchParams.get("modal_id") ||
        parsed.pathname.match(/\/video\/([^/?#]+)/)?.[1] ||
        parsed.pathname.match(/\/note\/([^/?#]+)/)?.[1] ||
        ""
      );
    } catch {
      return "";
    }
  };

  const bestDouyinJson = (preferredId = currentDouyinItemIdFromUrl()) => {
    return douyinJsonCandidates().sort((a, b) => {
      const score = (item) => {
        const node = item.node || {};
        let value = 0;
        if (preferredId && douyinItemIdFromNode(node) === String(preferredId)) value += 100;
        if (node.aweme_id || node.awemeId || node.itemId || node.item_id) value += 5;
        if (node.desc || node.description || node.title) value += 4;
        if (item.author?.nickname || item.author?.name) value += 3;
        if (item.video?.play_addr || item.video?.playAddr || item.video?.cover) value += 2;
        return value;
      };
      return score(b) - score(a);
    })[0];
  };

  const textFromJsonField = (...values) => {
    return compact(values.find((value) => typeof value === "string" && value.trim()) || "", 300);
  };

  const firstUrlFromJson = (...values) => {
    const flattened = values.flatMap((value) => {
      if (!value) return [];
      if (typeof value === "string") return [value];
      if (Array.isArray(value)) return value;
      if (Array.isArray(value.url_list)) return value.url_list;
      if (Array.isArray(value.urlList)) return value.urlList;
      if (typeof value.uri === "string") return [value.uri];
      return [];
    });
    return flattened.map(normalizeUrl).find(Boolean) || "";
  };

  const getDouyinActiveRoot = (input = null) => {
    const composer = input ? findDouyinComposer(input) : findDouyinComposer();
    const fromComposer =
      composer?.root?.closest?.("[data-e2e='video-detail'], [data-e2e='feed-active-video'], [data-e2e='browse-video'], [data-e2e='video-card'], article, main") ||
      composer?.root?.parentElement?.closest?.("[data-e2e='video-detail'], [data-e2e='feed-active-video'], [data-e2e='browse-video'], [data-e2e='video-card'], article, main");
    if (fromComposer) return fromComposer;

    const candidates = Array.from(
      document.querySelectorAll("[data-e2e='feed-active-video'], [data-e2e='browse-video'], [data-e2e='video-detail'], [data-e2e='video-card'], article")
    ).filter(isVisibleElement);
    if (!candidates.length) return document;
    const viewportCenter = window.innerHeight / 2;
    return candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return Math.abs((ar.top + ar.bottom) / 2 - viewportCenter) - Math.abs((br.top + br.bottom) / 2 - viewportCenter);
    })[0];
  };

  const titleFromDouyin = (root = document, preferredId = currentDouyinItemIdFromUrl()) => {
    const direct = textFrom(
      [
      "[data-e2e='video-desc']",
      "[data-e2e='browse-video-desc']",
      "[data-e2e='feed-video-desc']",
      "[data-e2e='aweme-desc']",
      "h1"
      ],
      root
    );
    if (direct && !looksLikeUrl(direct)) return direct;

    const meta = metaContent([
      "meta[property='og:title']",
      "meta[name='twitter:title']",
      "meta[name='description']",
      "meta[property='og:description']"
    ]);
    if (meta) {
      return meta
        .replace(/ - 抖音$/, "")
        .replace(/_抖音$/, "")
        .trim();
    }

    const candidate = bestDouyinJson(preferredId);
    if (candidate) {
      return textFromJsonField(candidate.node.desc, candidate.node.description, candidate.node.title, candidate.node.share_desc, candidate.node.shareDesc);
    }
    return compact(document.title.replace(/ - 抖音$/, "").replace(/_抖音$/, ""), 180);
  };

  const collectMedia = (platform = platformFromLocation(), preferredRoot = null, preferredId = currentDouyinItemIdFromUrl()) => {
    const videos = [];
    const images = [];
    const imageItems = [];
    const posters = [];
    const locations = [];
    let hasVideoElement = false;

    const roots =
      platform === "douyin" && preferredRoot && preferredRoot !== document
        ? [preferredRoot]
        : platform === "douyin"
        ? Array.from(
            document.querySelectorAll(
              "[data-e2e='feed-active-video'], [data-e2e='browse-video'], [data-e2e='video-detail'], [class*='video'], main, article"
            )
          )
        : Array.from(document.querySelectorAll("#noteContainer .media-container, .note-container .media-container, .media-container"));
    const scopes = roots.length ? roots : [document];

    const addImage = (value, element, sourceType = "image") => {
      const url = normalizeUrl(value);
      const identity = imageIdentity(url);
      if (!url || !identity || /avatar|profile|emoji|icon|sprite|data:image\/svg/i.test(url)) return;
      if (imageItems.some((item) => item.identity === identity)) return;
      imageItems.push({
        identity,
        url,
        sourceType,
        selector: element ? pathFor(element) : ""
      });
      images.push(url);
    };

    scopes.forEach((scope) => {
      scope.querySelectorAll("video").forEach((video) => {
        hasVideoElement = true;
        addUnique(videos, video.currentSrc || video.src);
        addUnique(posters, video.poster);
        locations.push({ type: "video", selector: pathFor(video) });
        video.querySelectorAll("source").forEach((source) => addUnique(videos, source.src));
      });

      scope.querySelectorAll("img").forEach((img) => {
        addImage(img.currentSrc || img.src || firstSrcsetUrl(img.srcset), img, "image");
        locations.push({ type: "image", selector: pathFor(img) });
      });

      scope.querySelectorAll("[style*='background']").forEach((node) => {
        const style = node.getAttribute("style") || "";
        const matches = style.matchAll(/url\(["']?([^"')]+)["']?\)/g);
        for (const match of matches) {
          if (node.tagName.toLowerCase() === "xg-poster" || /poster|cover/i.test(String(node.className || ""))) {
            addUnique(posters, match[1]);
            locations.push({ type: "video-poster", selector: pathFor(node) });
          } else {
            addImage(match[1], node, "background-image");
            locations.push({ type: "background-image", selector: pathFor(node) });
          }
        }
      });
    });

    if (platform === "douyin") {
      const candidate = bestDouyinJson(preferredId);
      const video = candidate?.video || {};
      addUnique(videos, firstUrlFromJson(video.play_addr, video.playAddr, video.download_addr, video.downloadAddr, video.bit_rate?.[0]?.play_addr));
      addUnique(posters, firstUrlFromJson(video.cover, video.origin_cover, video.originCover, video.dynamic_cover, video.dynamicCover));
      const metaImage = metaContent(["meta[property='og:image']", "meta[name='twitter:image']"]);
      addUnique(posters, metaImage);
    }

    if (!videos.length && !images.length) {
      document.querySelectorAll("video").forEach((video) => {
        hasVideoElement = true;
        addUnique(videos, video.currentSrc || video.src);
        addUnique(posters, video.poster);
        locations.push({ type: "video", selector: pathFor(video) });
        video.querySelectorAll("source").forEach((source) => addUnique(videos, source.src));
      });
    }

    if (hasVideoElement || platform === "douyin") {
      performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((url) => /sns-video|\.mp4(\?|$)|\.m3u8(\?|$)|douyin|douyinvod|ixigua|byteimg|aweme/i.test(url))
        .forEach((url) => {
          if (/\.mp4(\?|$)|\.m3u8(\?|$)|douyinvod|aweme.*video|video_id/i.test(url)) {
            addUnique(videos, url);
          } else if (/image|img|cover|poster|byteimg/i.test(url)) {
            addUnique(posters, url);
          }
        });
    }

    const filteredImageItems = imageItems.slice(0, 20).map((item, index) => ({
      role: index === 0 ? "cover" : "body",
      index: index === 0 ? 0 : index,
      url: item.url,
      selector: item.selector,
      sourceType: item.sourceType
    }));
    const filteredImages = filteredImageItems.map((item) => item.url);
    const filteredPosters = posters.filter((url) => !/avatar|profile|emoji|icon|sprite/i.test(url)).slice(0, 10);
    const filteredVideos = videos.slice(0, 10);

    return {
      type: hasVideoElement || filteredVideos.length ? "video" : filteredImages.length ? "image" : "unknown",
      images: filteredImages,
      imageItems: filteredImageItems,
      videos: filteredVideos,
      posters: filteredPosters,
      locations: locations.slice(0, 10)
    };
  };

  const collectComments = (platform = platformFromLocation(), preferredRoot = null) => {
    const selectors =
      platform === "douyin"
        ? [
            "[data-e2e='comment-item']",
            "[data-e2e='comment-list'] [class*='comment']",
            "[class*='CommentItem']",
            "[class*='comment-item']",
            "[class*='comment']"
          ]
        : [".comments-container .content", ".comment-item .content", ".comment-item", "[class*='comment']"];
    const comments = [];

    const root = platform === "douyin" && preferredRoot ? preferredRoot : document;
    for (const selector of selectors) {
      root.querySelectorAll(selector).forEach((node) => {
        const text = compact(node.innerText || node.textContent, 220);
        if (text && text.length >= 2 && !/^\d+$/.test(text) && !comments.includes(text)) comments.push(text);
      });
      if (comments.length >= 10) break;
    }

    return comments.slice(0, 10);
  };

  const findReplyTarget = (input, platform = platformFromLocation()) => {
    const roots = [];
    for (let node = input?.parentElement; node && node !== document.body && roots.length < 8; node = node.parentElement) {
      roots.push(node);
    }

    if (platform === "douyin") {
      const composer = findDouyinComposer(input);
      const targetedReply = parseDouyinReplyTag(composer?.root || input?.parentElement || document);
      if (targetedReply) {
        return targetedReply;
      }

      for (const root of roots) {
        const commentRoot =
          root.closest?.("[data-e2e='comment-item'], [class*='CommentItem'], [class*='comment-item']") ||
          root.querySelector?.("[data-e2e='comment-item'], [class*='CommentItem'], [class*='comment-item']");
        const text = compact(commentRoot?.innerText || commentRoot?.textContent || root.innerText || root.textContent, 260);
        if (text && !/发送|评论|回复/.test(text)) {
          return {
            isTargetedReply: true,
            replyTo: "",
            content: text,
            raw: text
          };
        }
      }
    }

    for (const root of roots) {
      const replyContent = root.querySelector?.(".reply-content");
      if (!replyContent) continue;
      const replyTo = compact(replyContent.querySelector(".reply")?.innerText || replyContent.querySelector(".reply")?.textContent, 80).replace(/^回复\s*/, "");
      const content = compact(replyContent.querySelector(".content")?.innerText || replyContent.querySelector(".content")?.textContent, 220);
      if (replyTo || content) {
        return {
          isTargetedReply: true,
          replyTo,
          content,
          raw: compact(replyContent.innerText || replyContent.textContent, 260)
        };
      }
    }

    return {
      isTargetedReply: false,
      replyTo: "",
      content: "",
      raw: ""
    };
  };

  const editableContentRoot = (element) => {
    return element?.querySelector?.("[data-contents='true']") || element;
  };

  const pointerEvent = (type, options) => {
    if (typeof PointerEvent === "function") {
      return new PointerEvent(type, options);
    }
    return new MouseEvent(type.replace(/^pointer/, "mouse"), options);
  };

  const visiblePointFor = (element) => {
    const rect = element?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return { clientX: Math.floor(window.innerWidth / 2), clientY: Math.floor(window.innerHeight / 2) };
    }
    return {
      clientX: rect.left + Math.min(rect.width - 4, Math.max(4, rect.width / 2)),
      clientY: rect.top + Math.min(rect.height - 4, Math.max(4, rect.height / 2))
    };
  };

  const centerPointFor = (element) => {
    const rect = element?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.round(rect.left + Math.min(rect.width - 4, Math.max(4, rect.width / 2))),
      y: Math.round(rect.top + Math.min(rect.height - 4, Math.max(4, rect.height / 2)))
    };
  };

  const douyinInputClickPointFor = (element) => {
    const target =
      element?.querySelector?.("[data-block='true'] [data-offset-key], [data-offset-key] span[data-offset-key], [data-offset-key]") ||
      element;
    const rect = target?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return centerPointFor(element);
    return {
      x: Math.round(rect.left + Math.min(rect.width - 8, 12)),
      y: Math.round(rect.top + Math.min(rect.height - 4, Math.max(4, rect.height / 2)))
    };
  };

  const dispatchPointerClick = (target) => {
    if (!target) return;
    const { clientX, clientY } = visiblePointFor(target);
    const pointer = { bubbles: true, cancelable: true, composed: true, clientX, clientY, pointerId: 1, pointerType: "mouse" };
    const mouse = { bubbles: true, cancelable: true, composed: true, clientX, clientY, button: 0, buttons: 1 };
    target.dispatchEvent(pointerEvent("pointerdown", pointer));
    target.dispatchEvent(new MouseEvent("mousedown", mouse));
    target.focus?.({ preventScroll: true });
    target.dispatchEvent(pointerEvent("pointerup", { ...pointer, buttons: 0 }));
    target.dispatchEvent(new MouseEvent("mouseup", { ...mouse, buttons: 0 }));
    target.dispatchEvent(new MouseEvent("click", { ...mouse, buttons: 0 }));
  };

  const placeCaretAtEnd = (element) => {
    const eventOptions = { bubbles: true, cancelable: true, composed: true };
    const selection = window.getSelection();
    const range = document.createRange();
    const draftLeaf = editableContentRoot(element)?.querySelector?.("[data-block='true'] [data-offset-key], [data-offset-key] span[data-offset-key], [data-offset-key]");
    if (draftLeaf) {
      range.selectNodeContents(draftLeaf);
    } else {
      range.selectNodeContents(editableContentRoot(element));
    }
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return eventOptions;
  };

  const selectEditableContents = (element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editableContentRoot(element));
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  const editableTextMatches = (element, text) => {
    const expected = compact(text, Math.max(text.length + 20, 120));
    const visibleText = compact(element?.innerText || element?.textContent, Math.max(text.length + 30, 160));
    return Boolean(expected && (visibleText === expected || (visibleText.includes(expected) && visibleText.length <= expected.length + 2)));
  };

  const prepareEditableForReplacement = async (element) => {
    if (!element) return false;
    element.focus?.({ preventScroll: true });
    selectEditableContents(element);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    selectEditableContents(element);
    return document.activeElement === element || element.contains(document.activeElement) || window.getSelection()?.rangeCount > 0;
  };

  const clearEditableSelection = async (element) => {
    selectEditableContents(element);
    const eventOptions = { bubbles: true, cancelable: true, composed: true };
    const beforeInput = new InputEvent("beforeinput", { ...eventOptions, inputType: "deleteContentBackward", data: null });
    element.dispatchEvent(beforeInput);
    try {
      document.execCommand?.("delete", false);
    } catch {
      // Fall back to letting the following insertText replace the selected content.
    }
    element.dispatchEvent(new InputEvent("input", { ...eventOptions, inputType: "deleteContentBackward", data: null }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    placeCaretAtEnd(element);
  };

  const replaceEditableTextInPage = async (element, text) => {
    if (platformFromLocation() === "douyin" && !isDouyinCommentInputCandidate(element)) return false;
    const prepared = await prepareEditableForReplacement(element);
    if (!prepared) return false;
    selectEditableContents(element);
    const eventOptions = { bubbles: true, cancelable: true, composed: true };
    const tryInsert = async (value, inputType = "insertText") => {
      const beforeInput = new InputEvent("beforeinput", { ...eventOptions, inputType, data: value });
      const shouldInsert = element.dispatchEvent(beforeInput);
      let inserted = false;
      try {
        inserted = shouldInsert && !beforeInput.defaultPrevented ? document.execCommand?.("insertText", false, value) || false : false;
      } catch {
        inserted = false;
      }
      element.dispatchEvent(new InputEvent("input", { ...eventOptions, inputType, data: value }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      return inserted && editableTextMatches(element, text);
    };

    if (await tryInsert(text, "insertReplacementText")) return true;

    await prepareEditableForReplacement(element);
    selectEditableContents(element);
    if (typeof ClipboardEvent === "function" && typeof DataTransfer === "function") {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData("text/plain", text);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dataTransfer, bubbles: true, cancelable: true, composed: true }));
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (editableTextMatches(element, text)) return true;
    }

    await prepareEditableForReplacement(element);
    selectEditableContents(element);
    let insertedAny = false;
    for (const char of text) {
      element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: char }));
      const beforeInput = new InputEvent("beforeinput", { ...eventOptions, inputType: "insertText", data: char });
      const shouldInsert = element.dispatchEvent(beforeInput);
      try {
        if (shouldInsert && !beforeInput.defaultPrevented) insertedAny = document.execCommand?.("insertText", false, char) || insertedAny;
      } catch {
        // Keep dispatching the same event sequence Draft.js listens for.
      }
      element.dispatchEvent(new InputEvent("input", { ...eventOptions, inputType: "insertText", data: char }));
      element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed: true, key: char }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    return insertedAny && editableTextMatches(element, text);
  };

  const activateEditable = (element) => {
    if (!element) return;
    const clickTargets = [
      element.closest?.(".DraftEditor-editorContainer"),
      element.closest?.(".DraftEditor-root"),
      element.closest?.(".richtext-container"),
      element
    ].filter((target, index, list) => target && list.indexOf(target) === index);
    clickTargets.forEach(dispatchPointerClick);
    element.focus?.({ preventScroll: true });
    placeCaretAtEnd(element);
  };

  const clearEditableLikeUser = (element) => {
    selectEditableContents(element);
    const eventOptions = { bubbles: true, cancelable: true, composed: true };
    try {
      element.dispatchEvent(new InputEvent("beforeinput", { ...eventOptions, inputType: "deleteContentBackward", data: null }));
      document.execCommand?.("delete", false);
      element.dispatchEvent(new InputEvent("input", { ...eventOptions, inputType: "deleteContentBackward", data: null }));
    } catch {
      // Keep the editor editable; DOM replacement is handled by the caller only when allowed.
    }
  };

  const insertTextLikeUser = (element, text, options = {}) => {
    activateEditable(element);
    if (options.replace !== false) {
      clearEditableLikeUser(element);
    }
    const eventOptions = placeCaretAtEnd(element);
    let insertedAny = false;
    if (options.perCharacter) {
      for (const char of text) {
        element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: char }));
        element.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, cancelable: true, composed: true, key: char }));
        const beforeInput = new InputEvent("beforeinput", { ...eventOptions, inputType: "insertText", data: char });
        const shouldMutateDom = element.dispatchEvent(beforeInput);
        try {
          if (shouldMutateDom && !beforeInput.defaultPrevented) {
            insertedAny = document.execCommand?.("insertText", false, char) || insertedAny;
          }
        } catch {
          // Ignore and continue dispatching input events.
        }
        element.dispatchEvent(new InputEvent("input", { ...eventOptions, inputType: "insertText", data: char }));
        element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, composed: true, key: char }));
      }
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return insertedAny || compact(element.innerText || element.textContent, text.length + 20).includes(text);
    }
    let inserted = false;
    try {
      inserted = document.execCommand?.("insertText", false, text) || false;
    } catch {
      inserted = false;
    }
    if (!inserted && typeof ClipboardEvent === "function" && typeof DataTransfer === "function") {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData("text/plain", text);
      inserted = element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dataTransfer, bubbles: true, cancelable: true, composed: true }));
    }
    element.dispatchEvent(new InputEvent("input", { ...eventOptions, inputType: "insertText", data: text }));
    element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed: true, key: text.slice(-1) || " " }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return inserted;
  };

  const insertTextViaBrowserInput = async (element, text) => {
    if (!element || !text) return false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (await replaceEditableTextInPage(element, text)) return true;
      await clearEditableSelection(element);
    }
    return false;
  };

  const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  const simulateDouyinKeyboardInput = async (element, text) => {
    if (!element || !text || !isDouyinCommentInputCandidate(element)) return false;
    const editorRoot =
      element.closest?.(".DraftEditor-editorContainer") ||
      element.closest?.(".DraftEditor-root") ||
      element.closest?.(".richtext-container") ||
      element;

    const existingText = compact(element.innerText || element.textContent, 1000);
    const clickPoints = [centerPointFor(editorRoot), douyinInputClickPointFor(element)].filter(Boolean);
    const response = await chrome.runtime.sendMessage({
      type: "MEDIA_DEBUGGER_REPLACE_TEXT",
      text,
      clickPoints,
      existingLength: existingText.length
    });
    if (!response?.ok) throw new Error(response?.error || "调试模式输入失败");

    await new Promise((resolve) => setTimeout(resolve, 350));
    const visibleText = compact(element.innerText || element.textContent, Math.max(text.length + 30, 160));
    if (!visibleText || visibleText.includes(text.slice(0, Math.min(8, text.length)))) return true;
    console.debug("[Media AI Reply] Debugger input succeeded, delayed Draft text check did not match", { visibleText, expected: text });
    return true;
  };

  const setEditableText = (element, value, options = {}) => {
    const text = String(value || "").trim();
    if (!element || !text) return;

    element.focus();
    const eventOptions = { bubbles: true, cancelable: true, composed: true };

    if ("value" in element) {
      const descriptor = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value");
      descriptor?.set ? descriptor.set.call(element, text) : (element.value = text);
      element.dispatchEvent(new InputEvent("beforeinput", { ...eventOptions, inputType: "insertText", data: text }));
      element.dispatchEvent(new InputEvent("input", { ...eventOptions, inputType: "insertText", data: text }));
      element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return;
    }

    const inserted = insertTextLikeUser(element, text, { perCharacter: options.perCharacter, replace: options.replace });
    if (options.domFallback === false) {
      return;
    }
    if (!inserted || compact(element.innerText || element.textContent, text.length + 20) !== text) {
      element.replaceChildren(document.createTextNode(text));
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new InputEvent("input", { ...eventOptions, inputType: "insertText", data: text }));
    element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed: true, key: text.slice(-1) || " " }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    setTimeout(() => {
      element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    }, 0);
  };

  const setEditableTextSilently = (element, value) => {
    if (!element) return;
    if ("value" in element) {
      element.value = value;
    } else {
      element.textContent = value;
    }
  };

  const emitEditableInput = (element, value) => {
    if (!element) return;
    const text = String(value || "");
    const eventOptions = { bubbles: true, cancelable: true, composed: true };
    element.dispatchEvent(new InputEvent("input", { ...eventOptions, inputType: "insertText", data: text }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  };

  const DEFAULT_OWNER_REPLY_PROMPT =
    "这是我自己发布的自媒体内容。请以作者本人/主人公视角回复评论，语气自然真诚，可以适度补充创作背景、个人体验或后续安排，不要生硬营销，不要超过 60 字。";
  const DEFAULT_BYSTANDER_REPLY_PROMPT =
    "这是其他人发布的自媒体内容。请以普通路人视角回复评论，语气自然、有共鸣、有观点，不要冒充作者本人，不要生硬营销，不要超过 60 字。";

  const getSettings = () => {
    return new Promise((resolve) => {
      chrome.storage.sync.get("aiAssistantSettings", (stored) => {
        const settings = stored.aiAssistantSettings || {};
        resolve({
          ownerReplyPrompt: settings.ownerReplyPrompt || settings.commentReplyPrompt || DEFAULT_OWNER_REPLY_PROMPT,
          bystanderReplyPrompt: settings.bystanderReplyPrompt || settings.commentReplyPrompt || DEFAULT_BYSTANDER_REPLY_PROMPT
        });
      });
    });
  };

  const isOwnPageFrom = (page) => {
    if (page?.platform === "douyin") {
      return Boolean(page?.isOwnPage === true && page?.ownPageConfidence === "high");
    }
    return Boolean(page?.authorProfileId && page?.viewerProfileId && page.authorProfileId === page.viewerProfileId);
  };

  const buildReplyPrompt = async (input) => {
    const page = platformFromLocation() === "douyin" ? extractDouyinPage(input) : extractPage();
    const settings = await getSettings();
    const isOwnPage = isOwnPageFrom(page);
    const label = platformLabel(page.platform);
    const perspective = isOwnPage ? "主人公视角" : "路人视角";
    const replyPrompt = isOwnPage ? settings.ownerReplyPrompt : settings.bystanderReplyPrompt;
    const perspectiveRule = isOwnPage
      ? "这是高置信识别为当前登录账号自己的内容，可以用作者本人/主人公视角。"
      : "这不是高置信识别为当前登录账号自己的内容，必须用路人/观众视角；禁止冒充作者，禁止使用“我这个视频/我的作品/我们拍的/我当时”等作者口吻。";
    const comments = page.comments.length ? page.comments.map((item, index) => `${index + 1}. ${item}`).join("\n") : "未读取到评论";
    const replyTarget = findReplyTarget(input, page.platform);
    const targetBlock = replyTarget.isTargetedReply
      ? `当前正在针对某一条评论回复：是\n被回复用户：${replyTarget.replyTo || "未知"}\n被回复评论：${replyTarget.content || replyTarget.raw || "未读取到"}\n回复要求：优先围绕这条被回复评论回应，不要泛泛总结整篇内容。`
      : "当前正在针对某一条评论回复：否";
    return [
      {
        role: "system",
        content: `你是${label}评论回复助手。当前回复视角：${perspective}。${perspectiveRule} 只有作者账号 ID 与当前登录账号 ID 高置信明确一致时才允许使用主人公视角，否则必须使用路人视角。${replyPrompt} 不要带引号。`
      },
      {
        role: "user",
        content: `平台：${label}\n标题/文案：${page.title}\n作者：${page.author || "未知"}\n作者账号ID：${page.authorProfileId || "未识别"}\n当前登录用户：${page.viewerName || "未识别"}\n当前登录账号ID：${page.viewerProfileId || "未识别"}\n自己发布判定置信度：${page.ownPageConfidence || "unknown"}\n是否判断为自己发布：${isOwnPage ? "是" : "否"}\n${targetBlock}\n正文/视频文案摘要：${compact(page.content, 800)}\n评论区：\n${comments}\n\n请生成一条适合发在评论输入框里的回复。`
      }
    ];
  };

  const generateCommentReply = async (button, input) => {
    if (button.dataset.loading === "true") return;
    const platform = platformFromLocation();
    const originalText = button.textContent || "AI回复";
    const isDouyinIconButton = platform === "douyin";
    const currentInput = findCommentInput(platform) || input;
    const lockedDouyinPage = platform === "douyin" ? extractDouyinPage(currentInput) : null;
    let loadingIndex = 0;
    const loadingTexts = ["AI typing.", "AI typing..", "AI typing..."];
    const loadingTimer = isDouyinIconButton ? 0 : window.setInterval(() => {
      const text = loadingTexts[loadingIndex % loadingTexts.length];
      loadingIndex += 1;
      setEditableTextSilently(currentInput, text);
      emitEditableInput(currentInput, text);
    }, 450);

    button.dataset.loading = "true";
    button.disabled = true;
    if (isDouyinIconButton) {
      setDouyinAiReplyLoading(button);
    } else {
      button.textContent = originalText;
    }
    if (!isDouyinIconButton) {
      setEditableTextSilently(currentInput, loadingTexts[0]);
      emitEditableInput(currentInput, loadingTexts[0]);
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: "MEDIA_GENERATE_COMMENT_REPLY",
        messages: await buildReplyPrompt(currentInput)
      });

      if (!response?.ok) throw new Error(response?.error || "生成失败");
      const latestInput = findCommentInput(platform) || currentInput || input;
      if (platform === "douyin") {
        const latestPage = extractDouyinPage(latestInput);
        const lockedKey = lockedDouyinPage?.itemId || lockedDouyinPage?.title || lockedDouyinPage?.anchorPath || "";
        const latestKey = latestPage?.itemId || latestPage?.title || latestPage?.anchorPath || "";
        if (lockedKey && latestKey && lockedKey !== latestKey) {
          throw new Error("当前视频已切换，已取消写入旧回复");
        }
        setDouyinAiStatusTip(button, "正在输入...");
        const inserted = await simulateDouyinKeyboardInput(latestInput, response.content);
        if (!inserted) throw new Error("输入失败");
        setDouyinAiStatusTip(button, "已输入");
      } else {
        setEditableText(latestInput, response.content, { domFallback: true });
      }
    } catch (error) {
      console.warn("[Media AI Reply]", error);
      if (!isDouyinIconButton) {
        setEditableTextSilently(currentInput, "");
        emitEditableInput(currentInput, "");
      }
      if (isDouyinIconButton) {
        button.style.opacity = "1";
        button.title = "生成失败";
        button.setAttribute("aria-label", "生成失败");
        setDouyinAiStatusTip(button, "生成失败");
      } else {
        button.textContent = "生成失败";
      }
      setTimeout(() => {
        if (isDouyinIconButton) {
          styleDouyinAiReplyButton(button, true);
          setDouyinAiStatusTip(button, "");
        } else {
          button.textContent = originalText;
        }
      }, 1800);
      return;
    } finally {
      if (loadingTimer) window.clearInterval(loadingTimer);
      delete button.dataset.loading;
      button.disabled = false;
    }

    if (isDouyinIconButton) {
      setTimeout(() => {
        if (button.dataset.loading !== "true") styleDouyinAiReplyButton(button, true);
      }, 1400);
    } else {
      button.textContent = originalText;
    }
  };

  const getRectScore = (element) => {
    const rect = element.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return 0;
    return rect.width * rect.height;
  };

  const isVisibleElement = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle?.(element);
    return style?.visibility !== "hidden" && style?.display !== "none";
  };

  const douyinInputSelector = [
    ".public-DraftEditor-content[contenteditable='true']",
    ".DraftEditor-editorContainer [contenteditable='true']",
    "[data-e2e='comment-input'] [contenteditable='true']",
    "[data-e2e='comment-input'] [contenteditable='plaintext-only']",
    "[data-e2e='comment-input'] textarea",
    "[data-e2e='comment-input'] input",
    "[class*='comment'] [contenteditable='true']",
    "[class*='Comment'] [contenteditable='true']",
    "textarea[placeholder*='评论']",
    "input[placeholder*='评论']",
    "[contenteditable='true'][placeholder*='评论']"
  ].join(",");
  const douyinFallbackInputSelector = "textarea,input,[contenteditable='true'],[contenteditable='plaintext-only']";

  const douyinSendButtonText = /^(发送|发布|评论|回复)$/;

  const hasDouyinActiveSendButton = (root = document) => {
    return Boolean(
      root.querySelector?.(
        "svg path[fill='#FE2C55'], svg path[fill='#fe2c55'], svg path[fill='rgb(254, 44, 85)'], svg path[fill='rgb(254,44,85)']"
      )
    );
  };

  const parseDouyinReplyTag = (root = document) => {
    const nodes = Array.from(root.querySelectorAll?.(".WSmVtag_, [class*='WSmVtag'], [class*='replyTag'], [class*='ReplyTag']") || []);
    const targeted = nodes.find((node) => /^回复@/.test(compact(node.innerText || node.textContent, 260)));
    if (!targeted) return null;
    const raw = compact(targeted.innerText || targeted.textContent, 260).replace(/\[表情\]/g, "").trim();
    const replyTo = raw.match(/^回复@([^:：\s]+)[:：]/)?.[1] || "";
    return {
      isTargetedReply: true,
      replyTo,
      content: raw.replace(/^回复@[^:：]+[:：]\s*/, ""),
      raw
    };
  };

  function douyinPlaceholderText(input) {
    if (!input) return "";
    const describedBy = input.getAttribute?.("aria-describedby");
    const describedText = describedBy ? compact(document.getElementById(describedBy)?.innerText || document.getElementById(describedBy)?.textContent, 120) : "";
    const root = input.closest?.(".DraftEditor-root, .richtext-container, [data-e2e='comment-input'], [class*='comment-input'], [class*='CommentInput']");
    const placeholderText = compact(root?.querySelector?.(".public-DraftEditorPlaceholder-inner")?.innerText || root?.querySelector?.(".public-DraftEditorPlaceholder-inner")?.textContent, 120);
    return compact([describedText, placeholderText, input.getAttribute?.("placeholder"), input.getAttribute?.("aria-label")].filter(Boolean).join(" "), 180);
  }

  function hasDouyinNativeAiFailure(root) {
    return /加载失败|请检查网络|稍后重试/.test(compact(root?.innerText || root?.textContent, 260));
  }

  function isDouyinCommentInputCandidate(input) {
    if (!input || !isVisibleElement(input)) return false;
    if (input.closest?.("#media-ai-reply-button, [data-media-ai-reply-wrapper='true']")) return false;
    const editorRoot = input.closest?.(".DraftEditor-root, .richtext-container, [data-e2e='comment-input'], [class*='comment-input'], [class*='CommentInput']");
    const localText = compact(editorRoot?.innerText || editorRoot?.textContent || input.innerText || input.textContent || input.value, 260);
    const placeholder = douyinPlaceholderText(input);
    const isCommentContext =
      /留下你的精彩评论|评论|回复/.test(placeholder) ||
      Boolean(input.closest?.("[data-e2e='comment-input'], [class*='comment-input'], [class*='CommentInput']")) ||
      Boolean(parseDouyinReplyTag(editorRoot || input.parentElement || document));

    if (!isCommentContext) return false;
    if (/搜索|问AI|问 AI/.test(placeholder)) return false;
    if (hasDouyinNativeAiFailure(editorRoot) || /加载失败|请检查网络|稍后重试/.test(localText)) return false;
    return true;
  }

  const findDouyinComposer = (preferredInput = null) => {
    const inputCandidates = [];
    if (preferredInput?.matches?.(douyinInputSelector) && isDouyinCommentInputCandidate(preferredInput)) inputCandidates.push(preferredInput);
    const active = document.activeElement;
    if (active?.matches?.(douyinInputSelector) && isDouyinCommentInputCandidate(active)) inputCandidates.push(active);
    inputCandidates.push(...Array.from(document.querySelectorAll(douyinInputSelector)).filter(isDouyinCommentInputCandidate));
    inputCandidates.push(
      ...Array.from(document.querySelectorAll(douyinFallbackInputSelector)).filter((node) => {
        if (!isDouyinCommentInputCandidate(node)) return false;
        const text = compact(node.innerText || node.textContent || node.value || node.getAttribute?.("placeholder"), 80);
        if (/搜索/.test(text)) return false;
        return node.closest?.("[data-e2e='comment-input'], [class*='comment'], [class*='Comment']") || parseDouyinReplyTag(node.parentElement || document);
      })
    );

    const uniqueInputs = inputCandidates.filter((input, index, list) => input && list.indexOf(input) === index && isVisibleElement(input));
    for (const input of uniqueInputs) {
      const ancestors = [];
      for (let node = input.parentElement; node && node !== document.body && ancestors.length < 8; node = node.parentElement) {
        ancestors.push(node);
      }

      for (const root of ancestors) {
        const buttons = Array.from(root.querySelectorAll("button, [role='button']"));
        const sendButton = buttons.find((node) => {
          if (node.id === "media-ai-reply-button" || node.id === "xhs-ai-reply-button") return false;
          const text = compact(node.innerText || node.textContent || node.getAttribute?.("aria-label"), 20);
          return douyinSendButtonText.test(text) && isVisibleElement(node);
        });
        const toolAnchor = findDouyinToolAnchorInRoot(root);
        if (sendButton || toolAnchor || parseDouyinReplyTag(root)) {
          return { root, input, sendButton, toolAnchor };
        }
      }
    }

    return null;
  };

  const findCommentInput = (platform = platformFromLocation()) => {
    if (platform === "douyin") {
      return findDouyinComposer()?.input || null;
    }

    return document.querySelector("#content-textarea.content-input[contenteditable='true']");
  };

  const findDouyinToolAnchorInRoot = (root) => {
    if (!root) return null;
    const candidates = Array.from(root.querySelectorAll?.("span, button, [role='button']") || []).filter((node) => {
      if (node.id === "media-ai-reply-button") return false;
      if (node.querySelector?.("#media-ai-reply-button")) return false;
      const svg = node.querySelector?.("svg[viewBox='0 0 36 36'], svg[width='36'][height='36']");
      if (!svg) return false;
      const text = compact(node.innerText || node.textContent || node.getAttribute?.("aria-label"), 30);
      if (/问AI|发送|发布|评论|回复/.test(text)) return false;
      return getRectScore(node) > 0 && isVisibleElement(node);
    });
    const anchor = candidates.find((node) => node.parentElement?.children?.length > 1) || candidates[0] || null;
    return anchor?.closest?.("button, [role='button']") || anchor;
  };

  const findDouyinAiButtonHost = (composer) => {
    const input = composer?.input;
    if (!input) return null;
    const candidates = [
      input.closest?.(".comment-input-inner-container"),
      input.closest?.("[class*='comment-input-inner']"),
      input.closest?.("[data-e2e='comment-input']"),
      input.closest?.(".comment-input-container"),
      input.closest?.("[class*='comment-input-container']"),
      input.closest?.(".richtext-container")?.parentElement,
      input.closest?.(".DraftEditor-root")?.parentElement,
      composer?.root
    ].filter(Boolean);

    return candidates.find((node) => {
      if (!isVisibleElement(node)) return false;
      const text = compact(node.innerText || node.textContent, 360);
      if (/问AI|问 AI|加载失败|请检查网络|稍后重试/.test(text) && !/留下你的精彩评论|评论|回复/.test(text)) return false;
      return node.contains(input);
    }) || null;
  };

  const findDouyinAskAiButton = () => {
    return Array.from(document.querySelectorAll("button, [role='button'], [role='tab'], span, div")).find((node) => {
      if (node.id === "media-ai-reply-button") return false;
      const text = compact(node.innerText || node.textContent || node.getAttribute?.("aria-label"), 20);
      return text === "问AI" || text === "问 AI";
    });
  };

  const findDouyinCommentEntry = () => {
    const commentTab = Array.from(document.querySelectorAll("button, [role='button'], [role='tab'], span, div")).find((node) => {
      if (node.id === "media-ai-reply-button") return false;
      const text = compact(node.innerText || node.textContent || node.getAttribute?.("aria-label"), 30);
      if (/评论|查看评论|展开评论/.test(text) && isVisibleElement(node)) return true;
      const label = compact(node.getAttribute?.("aria-label"), 30);
      return /评论/.test(label) && isVisibleElement(node);
    });
    if (commentTab) return commentTab;

    const feedIcon = Array.from(document.querySelectorAll("[data-e2e='feed-comment-icon']")).find(isVisibleElement);
    if (feedIcon) return feedIcon.closest?.("[tabindex], button, [role='button']") || feedIcon;

    return null;
  };

  const douyinAuthorProfileIdFromDom = (root = document) => {
    const selectors = [
      "[data-e2e='video-author-name'] a[href*='/user/']",
      "[data-e2e='browse-username'] a[href*='/user/']",
      "[data-e2e='user-title'] a[href*='/user/']",
      "[data-e2e='video-detail'] [data-e2e*='author'] a[href*='/user/']",
      "[data-e2e='feed-active-video'] [data-e2e*='author'] a[href*='/user/']",
      "[data-e2e='browse-video'] [data-e2e*='author'] a[href*='/user/']"
    ];
    for (const selector of selectors) {
      const link = root.querySelector?.(selector) || document.querySelector(selector);
      const id = profileIdFromHref(link?.getAttribute?.("href") || link?.href, "douyin");
      if (id) return id;
    }
    return "";
  };

  const openDouyinAskAi = () => {
    const clickTarget = (target) => {
      target.scrollIntoView?.({ block: "center", inline: "center" });
      dispatchPointerClick(target);
    };
    const dispatchShortcut = (target) => {
      if (!target?.dispatchEvent) return;
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "x", code: "KeyX", keyCode: 88, which: 88, bubbles: true, cancelable: true, composed: true }));
      target.dispatchEvent(new KeyboardEvent("keypress", { key: "x", code: "KeyX", keyCode: 88, which: 88, bubbles: true, cancelable: true, composed: true }));
      target.dispatchEvent(new KeyboardEvent("keyup", { key: "x", code: "KeyX", keyCode: 88, which: 88, bubbles: true, cancelable: true, composed: true }));
    };
    const openByCommentEntry = () => {
      const commentEntry = findDouyinCommentEntry();
      if (!commentEntry) return false;
      clickTarget(commentEntry);
      setTimeout(() => {
        const nextAskTarget = findDouyinAskAiButton();
        if (nextAskTarget) clickTarget(nextAskTarget);
      }, 500);
      return true;
    };
    const askTarget = findDouyinAskAiButton();
    if (askTarget) {
      clickTarget(askTarget);
      return { ok: true, opened: "ask-ai" };
    }
    document.activeElement?.blur?.();
    const videoRoot = document.querySelector("[data-e2e='feed-active-video'], [data-e2e='browse-video'], [data-e2e='video-detail'], video") || document.body;
    [document, document.documentElement, document.body, videoRoot, window].forEach(dispatchShortcut);
    setTimeout(() => {
      const nextAskTarget = findDouyinAskAiButton();
      if (nextAskTarget) {
        clickTarget(nextAskTarget);
        return;
      }
      if (openByCommentEntry()) return;
      setTimeout(() => {
        const nextAskTarget = findDouyinAskAiButton();
        if (nextAskTarget) clickTarget(nextAskTarget);
      }, 500);
    }, 650);
    return { ok: true, opened: "shortcut" };
  };

  const findSendButton = (platform = platformFromLocation(), input = null) => {
    if (platform === "douyin") {
      return findDouyinComposer(input)?.sendButton || null;
    }

    return Array.from(document.querySelectorAll("button.btn.submit, .btn.submit")).find((node) => {
      return node instanceof HTMLButtonElement && node.id !== "media-ai-reply-button" && node.id !== "xhs-ai-reply-button" && /发送/.test(node.textContent || "");
    });
  };

  const styleAiReplyButton = (button, sendButton, platform = platformFromLocation()) => {
    button.type = "button";
    if (sendButton?.className && button.className !== sendButton.className) button.className = sendButton.className;
    if (button.disabled) button.disabled = false;
    if (button.hasAttribute("disabled")) button.removeAttribute("disabled");
    button.replaceChildren(document.createTextNode("AI回复"));
    button.style.marginRight = "8px";
    button.style.marginLeft = "0";
    button.style.background =
      platform === "douyin" ? "linear-gradient(135deg, #111827 0%, #fe2c55 100%)" : "linear-gradient(135deg, #ff2442 0%, #7c3aed 100%)";
    button.style.border = "0";
    button.style.borderRadius = "16px";
    button.style.color = "#fff";
    button.style.cursor = "pointer";
    button.style.display = "inline-flex";
    button.style.alignItems = "center";
    button.style.justifyContent = "center";
    button.style.flex = "0 0 auto";
    button.style.width = "64px";
    button.style.minWidth = "64px";
    button.style.maxWidth = "64px";
    button.style.height = "32px";
    button.style.lineHeight = "32px";
    button.style.padding = "0 12px";
    button.style.boxSizing = "border-box";
    button.style.whiteSpace = "nowrap";
    button.style.fontSize = "13px";
    button.style.fontWeight = "700";
    button.style.boxShadow = platform === "douyin" ? "0 4px 12px rgba(254, 44, 85, 0.26)" : "0 4px 12px rgba(255, 36, 66, 0.28)";
    button.style.opacity = "1";
    if (button.getAttribute("aria-label") !== "AI回复") button.setAttribute("aria-label", "AI回复");
  };

  const buildDouyinAiIcon = () => {
    const badge = document.createElement("span");
    badge.textContent = "AI";
    badge.style.display = "inline-grid";
    badge.style.width = "30px";
    badge.style.height = "30px";
    badge.style.placeItems = "center";
    badge.style.borderRadius = "10px";
    badge.style.color = "#ffffff";
    badge.style.background = "linear-gradient(135deg, #00f5ff 0%, #7c3aed 48%, #ff2d55 100%)";
    badge.style.fontSize = "12px";
    badge.style.fontWeight = "900";
    badge.style.letterSpacing = "0";
    badge.style.lineHeight = "1";
    badge.style.boxShadow = "0 4px 12px rgba(255, 45, 85, 0.34), 0 0 0 1px rgba(255, 255, 255, 0.85) inset";
    return badge;
  };

  const ensureMediaAiStyles = () => {
    if (document.getElementById("media-ai-style")) return;
    const style = document.createElement("style");
    style.id = "media-ai-style";
    style.textContent = `
      @keyframes mediaAiPulse {
        from { opacity: 0.62; }
        to { opacity: 1; }
      }
      @keyframes mediaAiBubblePulse {
        0% { transform: translateX(-50%) scale(0.98); opacity: 0.9; }
        100% { transform: translateX(-50%) scale(1); opacity: 1; }
      }
    `;
    document.documentElement.appendChild(style);
  };

  const buildDouyinAiLoadingIcon = () => {
    ensureMediaAiStyles();
    const badge = document.createElement("span");
    badge.textContent = "...";
    badge.style.display = "inline-grid";
    badge.style.width = "30px";
    badge.style.height = "30px";
    badge.style.minWidth = "30px";
    badge.style.maxWidth = "30px";
    badge.style.placeItems = "center";
    badge.style.borderRadius = "10px";
    badge.style.color = "#ffffff";
    badge.style.background = "linear-gradient(135deg, #fe2c55 0%, #ff7a00 52%, #00f5ff 100%)";
    badge.style.fontSize = "14px";
    badge.style.fontWeight = "900";
    badge.style.letterSpacing = "0";
    badge.style.lineHeight = "1";
    badge.style.transform = "none";
    badge.style.boxShadow = "0 4px 14px rgba(254, 44, 85, 0.42), 0 0 0 1px rgba(255, 255, 255, 0.9) inset";
    badge.style.animation = "mediaAiPulse 0.9s ease-in-out infinite alternate";
    return badge;
  };

  const stopAiButtonEvent = (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  };

  const swallowAiPopoverEvent = (event) => {
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  };

  const copyTextToClipboard = async (text, throwOnError = true) => {
    const value = String(text || "");
    if (!value) return false;
    try {
      await navigator.clipboard?.writeText(value);
      return true;
    } catch (error) {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        textarea.style.top = "0";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand?.("copy") || false;
        textarea.remove();
        return copied;
      } catch (fallbackError) {
        if (throwOnError) throw fallbackError;
        return false;
      } finally {
        if (!throwOnError) {
          console.debug("[Media AI Reply] Clipboard copy skipped or failed", error);
        }
      }
    }
  };

  const closeDouyinAiResultPopover = () => {
    document.querySelectorAll("[data-media-ai-result='true']").forEach((node) => node.remove());
  };

  const showDouyinAiResultPopover = (button, text, copied = false) => {
    const wrapper = button.parentElement?.dataset?.mediaAiReplyWrapper === "true" ? button.parentElement : null;
    if (!wrapper) return;
    closeDouyinAiResultPopover();

    const popover = document.createElement("div");
    popover.dataset.mediaAiResult = "true";
    popover.style.position = "absolute";
    popover.style.right = "0";
    popover.style.bottom = "46px";
    popover.style.left = "auto";
    popover.style.zIndex = "2147483647";
    popover.style.width = "260px";
    popover.style.maxWidth = "min(260px, calc(100vw - 24px))";
    popover.style.padding = "12px";
    popover.style.borderRadius = "12px";
    popover.style.background = "rgba(24, 24, 27, 0.98)";
    popover.style.color = "#fff";
    popover.style.boxShadow = "0 12px 32px rgba(0, 0, 0, 0.28)";
    popover.style.border = "1px solid rgba(255, 255, 255, 0.12)";
    popover.style.fontSize = "13px";
    popover.style.lineHeight = "18px";
    popover.style.whiteSpace = "normal";
    popover.style.pointerEvents = "auto";

    const content = document.createElement("div");
    content.textContent = text;
    content.style.maxHeight = "126px";
    content.style.overflow = "auto";
    content.style.wordBreak = "break-word";

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.alignItems = "center";
    actions.style.justifyContent = "space-between";
    actions.style.gap = "8px";
    actions.style.marginTop = "10px";

    const status = document.createElement("span");
    status.textContent = copied ? "已生成并复制" : "已生成";
    status.style.color = "rgba(255, 255, 255, 0.72)";
    status.style.fontSize = "12px";

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.textContent = "复制";
    copyButton.style.border = "0";
    copyButton.style.borderRadius = "8px";
    copyButton.style.background = "#fe2c55";
    copyButton.style.color = "#fff";
    copyButton.style.fontSize = "12px";
    copyButton.style.fontWeight = "800";
    copyButton.style.padding = "6px 10px";
    copyButton.style.cursor = "pointer";
    copyButton.addEventListener("click", async (event) => {
      stopAiButtonEvent(event);
      const ok = await copyTextToClipboard(text, false);
      status.textContent = ok ? "已复制，手动粘贴到评论框" : "复制失败，请手动选中文本";
    });

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "关闭";
    closeButton.style.border = "0";
    closeButton.style.borderRadius = "8px";
    closeButton.style.background = "rgba(255, 255, 255, 0.12)";
    closeButton.style.color = "#fff";
    closeButton.style.fontSize = "12px";
    closeButton.style.fontWeight = "700";
    closeButton.style.padding = "6px 10px";
    closeButton.style.cursor = "pointer";
    closeButton.addEventListener("click", (event) => {
      stopAiButtonEvent(event);
      popover.remove();
    });

    [popover, content, actions].forEach((node) => {
      ["pointerdown", "mousedown", "mouseup", "pointerup", "click"].forEach((type) => {
        node.addEventListener(type, swallowAiPopoverEvent);
      });
    });

    actions.append(status, copyButton, closeButton);
    popover.append(content, actions);
    wrapper.appendChild(popover);
    setTimeout(() => {
      if (popover.isConnected) popover.remove();
    }, 12000);
  };

  const setDouyinAiStatusTip = (button, text = "") => {
    const wrapper = button.parentElement?.dataset?.mediaAiReplyWrapper === "true" ? button.parentElement : null;
    let tip = document.querySelector("[data-media-ai-status='true']");
    if (!tip) {
      tip = document.createElement("span");
      tip.dataset.mediaAiStatus = "true";
      tip.style.position = "absolute";
      tip.style.left = "0";
      tip.style.top = "0";
      tip.style.transform = "none";
      tip.style.zIndex = "2147483647";
      tip.style.minWidth = "132px";
      tip.style.maxWidth = "220px";
      tip.style.padding = "12px 16px";
      tip.style.borderRadius = "16px";
      tip.style.background = "linear-gradient(135deg, rgba(254, 44, 85, 0.98), rgba(124, 58, 237, 0.98))";
      tip.style.color = "#fff";
      tip.style.fontSize = "15px";
      tip.style.fontWeight = "900";
      tip.style.lineHeight = "20px";
      tip.style.textAlign = "center";
      tip.style.whiteSpace = "nowrap";
      tip.style.boxShadow = "0 14px 34px rgba(254, 44, 85, 0.44), 0 4px 14px rgba(0, 0, 0, 0.24)";
      tip.style.pointerEvents = "none";
      tip.style.animation = "mediaAiBubblePulse 0.75s ease-in-out infinite alternate";
      document.body.appendChild(tip);
    }
    tip.textContent = text;
    tip.style.display = text ? "inline-flex" : "none";
    if (text && wrapper) positionDouyinAiStatusTip(wrapper);
  };

  const setDouyinAiReplyLoading = (button) => {
    button.replaceChildren(buildDouyinAiLoadingIcon());
    button.dataset.mediaAiVariant = "douyin-loading";
    button.title = "AI回复生成中";
    button.setAttribute("aria-label", "AI回复生成中");
    button.setAttribute("aria-busy", "true");
    button.style.display = "inline-flex";
    button.style.alignItems = "center";
    button.style.justifyContent = "center";
    button.style.width = "36px";
    button.style.height = "36px";
    button.style.minWidth = "36px";
    button.style.maxWidth = "36px";
    button.style.flex = "0 0 36px";
    button.style.padding = "0";
    button.style.margin = "0";
    button.style.lineHeight = "0";
    button.style.opacity = "1";
    button.style.cursor = "progress";
    setDouyinAiStatusTip(button, "AI回复生成中...");
  };

  const styleDouyinAiReplyButton = (button, force = false) => {
    button.type = "button";
    button.className = "";
    if (button.dataset.loading === "true") {
      setDouyinAiReplyLoading(button);
      return;
    }
    if (force || button.dataset.mediaAiVariant !== "douyin-icon") {
      button.replaceChildren(buildDouyinAiIcon());
      button.dataset.mediaAiVariant = "douyin-icon";
    }
    button.title = "AI回复";
    button.setAttribute("aria-label", "AI回复");
    button.removeAttribute("aria-busy");
    setDouyinAiStatusTip(button, "");
    button.style.display = "inline-flex";
    button.style.alignItems = "center";
    button.style.justifyContent = "center";
    button.style.width = "36px";
    button.style.height = "36px";
    button.style.minWidth = "36px";
    button.style.maxWidth = "36px";
    button.style.margin = "0";
    button.style.padding = "0";
    button.style.border = "0";
    button.style.borderRadius = "50%";
    button.style.background = "transparent";
    button.style.boxShadow = "none";
    button.style.color = "inherit";
    button.style.cursor = "pointer";
    button.style.opacity = "1";
    button.style.flex = "0 0 36px";
    button.style.lineHeight = "0";
    button.style.position = "relative";
    button.onpointerdown = null;
    button.onmousedown = null;
    button.onmouseup = null;
    button.onpointerup = null;
  };

  const isAiReplyEvent = (event) => {
    const target = event.target;
    return Boolean(target?.closest?.("#media-ai-reply-button, [data-media-ai-reply-wrapper='true']"));
  };

  const isAiReplyButtonEvent = (event) => {
    return Boolean(event.target?.closest?.("#media-ai-reply-button"));
  };

  const installAiReplyEventFirewall = () => {
    if (window.__mediaAiReplyEventFirewallInstalled) return;
    window.__mediaAiReplyEventFirewallInstalled = true;
    const guard = (type) => (event) => {
      if (!isAiReplyEvent(event)) return;
      stopAiButtonEvent(event);
      if (type !== "click") return;
    };
    ["click"].forEach((type) => {
      const handler = guard(type);
      [window, document].forEach((target) => target.addEventListener(
        type,
        handler,
        true
      ));
    });
  };

  const ensureAiReplyWrapper = (button) => {
    let wrapper = button.parentElement?.dataset?.mediaAiReplyWrapper === "true" ? button.parentElement : null;
    if (!wrapper) {
      wrapper = document.createElement("span");
      wrapper.dataset.mediaAiReplyWrapper = "true";
      wrapper.style.display = "inline-flex";
      wrapper.style.alignItems = "center";
      wrapper.style.justifyContent = "center";
      wrapper.style.width = "36px";
      wrapper.style.height = "36px";
      wrapper.style.minWidth = "36px";
      wrapper.style.maxWidth = "36px";
      wrapper.style.flex = "0 0 36px";
      wrapper.style.margin = "0";
      wrapper.style.padding = "0";
      wrapper.style.position = "relative";
      wrapper.style.zIndex = "1";
      wrapper.style.pointerEvents = "auto";
      wrapper.style.contain = "layout style paint";
      wrapper.appendChild(button);
    }
    wrapper.style.position = "relative";
    wrapper.style.zIndex = "1";
    wrapper.style.width = "36px";
    wrapper.style.height = "36px";
    wrapper.style.minWidth = "36px";
    wrapper.style.maxWidth = "36px";
    wrapper.style.flex = "0 0 36px";
    wrapper.style.transform = "none";
    installAiReplyEventFirewall();
    installDouyinAiReplyDrag(wrapper, button);
    return wrapper;
  };

  const douyinAiDragKey = "mediaAiDouyinReplyButtonPosition";

  const douyinAiPositionAnchors = (composer) => {
    const input = composer?.input;
    if (!input || !isVisibleElement(input)) return null;
    const host = findDouyinAiButtonHost(composer) || input.closest?.(".richtext-container, .DraftEditor-root") || input;
    const inputRect = input.getBoundingClientRect();
    const hostRect = host?.getBoundingClientRect?.() || inputRect;
    if (!inputRect || !hostRect || inputRect.width <= 0 || inputRect.height <= 0) return null;
    return {
      sidebarLeft: hostRect.left,
      inputCenterY: inputRect.top + inputRect.height / 2
    };
  };

  const savedDouyinAiReplyPosition = (composer) => {
    try {
      const value = JSON.parse(localStorage.getItem(douyinAiDragKey) || "null");
      if (!value) return null;
      if (typeof value.dx === "number" && typeof value.dy === "number") {
        const anchors = douyinAiPositionAnchors(composer);
        if (!anchors) return null;
        return {
          left: Math.min(window.innerWidth - 44, Math.max(8, anchors.sidebarLeft + value.dx)),
          top: Math.min(window.innerHeight - 44, Math.max(8, anchors.inputCenterY + value.dy))
        };
      }
      if (typeof value.left !== "number" || typeof value.top !== "number") return null;
      return {
        left: Math.min(window.innerWidth - 44, Math.max(8, value.left)),
        top: Math.min(window.innerHeight - 44, Math.max(8, value.top))
      };
    } catch {
      return null;
    }
  };

  const saveDouyinAiReplyPosition = (left, top, composer = findDouyinComposer()) => {
    try {
      const anchors = douyinAiPositionAnchors(composer);
      if (anchors) {
        localStorage.setItem(
          douyinAiDragKey,
          JSON.stringify({
            dx: Math.round(left - anchors.sidebarLeft),
            dy: Math.round(top - anchors.inputCenterY)
          })
        );
        return;
      }
      localStorage.setItem(
        douyinAiDragKey,
        JSON.stringify({
          left: Math.round(Math.min(window.innerWidth - 44, Math.max(8, left))),
          top: Math.round(Math.min(window.innerHeight - 44, Math.max(8, top)))
        })
      );
    } catch {
      // Position persistence is optional.
    }
  };

  const applyDouyinAiReplyPosition = (wrapper, left, top) => {
    wrapper.style.display = "inline-flex";
    wrapper.style.position = "fixed";
    wrapper.style.left = `${Math.round(Math.min(window.innerWidth - 44, Math.max(8, left)))}px`;
    wrapper.style.top = `${Math.round(Math.min(window.innerHeight - 44, Math.max(8, top)))}px`;
    wrapper.style.right = "";
    wrapper.style.bottom = "";
    wrapper.style.transform = "none";
    wrapper.style.zIndex = "2147483646";
    wrapper.style.pointerEvents = "auto";
    wrapper.style.contain = "layout style paint";
    positionDouyinAiStatusTip(wrapper);
  };

  const positionDouyinAiStatusTip = (wrapper) => {
    const tip = document.querySelector("[data-media-ai-status='true']");
    if (!tip || tip.style.display === "none" || !wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const width = Math.min(220, Math.max(132, tip.offsetWidth || 132));
    const left = Math.round(Math.min(window.innerWidth - width - 8, Math.max(8, rect.left + rect.width / 2 - width / 2)));
    const top = Math.round(Math.max(8, rect.top - 60));
    tip.style.position = "fixed";
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.transform = "none";
  };

  const installDouyinAiReplyDrag = (wrapper, button) => {
    if (!wrapper || wrapper.dataset.dragInstalled === "true") return;
    wrapper.dataset.dragInstalled = "true";
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let moved = false;

    wrapper.addEventListener(
      "pointerdown",
      (event) => {
        if (button.dataset.loading === "true") return;
        stopAiButtonEvent(event);
        const rect = wrapper.getBoundingClientRect();
        startX = event.clientX;
        startY = event.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        moved = false;
        button.dataset.dragging = "false";
        wrapper.setPointerCapture?.(event.pointerId);
      },
      true
    );

    wrapper.addEventListener(
      "pointermove",
      (event) => {
        if (!startX && !startY) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 4) {
          moved = true;
          button.dataset.dragging = "true";
        }
        if (!moved) return;
        stopAiButtonEvent(event);
        applyDouyinAiReplyPosition(wrapper, startLeft + dx, startTop + dy);
      },
      true
    );

    wrapper.addEventListener(
      "pointerup",
      (event) => {
        if (!startX && !startY) return;
        stopAiButtonEvent(event);
        wrapper.releasePointerCapture?.(event.pointerId);
        if (moved) {
          const rect = wrapper.getBoundingClientRect();
          saveDouyinAiReplyPosition(rect.left, rect.top, findDouyinComposer());
          setTimeout(() => {
            delete button.dataset.dragging;
          }, 80);
        } else {
          delete button.dataset.dragging;
          if (button.dataset.loading === "true") {
            setDouyinAiReplyLoading(button);
          } else {
            generateCommentReply(button, findCommentInput("douyin"));
          }
        }
        startX = 0;
        startY = 0;
        moved = false;
      },
      true
    );
  };

  const positionDouyinAiReplyWrapper = (wrapper, composer) => {
    const input = composer?.input;
    if (!wrapper || !input || !isVisibleElement(input)) {
      if (wrapper) wrapper.style.display = "none";
      return false;
    }

    const saved = savedDouyinAiReplyPosition(composer);
    if (saved) {
      applyDouyinAiReplyPosition(wrapper, saved.left, saved.top);
      return true;
    }

    const host = findDouyinAiButtonHost(composer) || input.closest?.(".richtext-container, .DraftEditor-root") || input;
    const sendButton = composer?.sendButton;
    const sendRect = isVisibleElement(sendButton) ? sendButton.getBoundingClientRect() : null;
    const hostRect = host?.getBoundingClientRect?.() || input.getBoundingClientRect();
    if (!hostRect || hostRect.width <= 0 || hostRect.height <= 0) {
      wrapper.style.display = "none";
      return false;
    }

    const rawLeft = Math.min(window.innerWidth - 52, (sendRect ? sendRect.right : hostRect.right) + 12);
    const rawTop = (sendRect ? sendRect.top + (sendRect.height - 36) / 2 : hostRect.bottom - 42) - 50;
    const left = Math.round(Math.min(window.innerWidth - 44, Math.max(8, rawLeft)));
    const top = Math.round(Math.min(window.innerHeight - 44, Math.max(8, rawTop)));

    applyDouyinAiReplyPosition(wrapper, left, top);
    return true;
  };

  const injectAiReplyButton = () => {
    const platform = platformFromLocation();
    if (platform !== "xiaohongshu" && platform !== "douyin") return;
    const existing = document.getElementById("media-ai-reply-button") || document.getElementById("xhs-ai-reply-button");
    const composer = platform === "douyin" ? findDouyinComposer() : null;
    const input = composer?.input || findCommentInput(platform);
    const sendButton = composer?.sendButton || findSendButton(platform, input);

    if (!input || (!sendButton && platform !== "douyin") || (sendButton && !sendButton.parentElement)) {
      if (existing?.parentElement?.dataset?.mediaAiReplyWrapper === "true") {
        existing.parentElement.remove();
      } else {
        existing?.remove();
      }
      lastReplyButtonPlacement = "";
      return;
    }

    const button = existing || document.createElement("button");
    button.id = "media-ai-reply-button";
    if (platform === "douyin") {
      styleDouyinAiReplyButton(button);
    } else {
      styleAiReplyButton(button, sendButton, platform);
    }
    button.onclick = platform === "douyin" ? null : (event) => {
      stopAiButtonEvent(event);
      generateCommentReply(button, input);
    };
    if (button.dataset.mediaAiPointerGuard !== "true") {
      ["pointerdown", "mousedown", "mouseup", "pointerup"].forEach((type) => {
        button.addEventListener(type, stopAiButtonEvent, { capture: true });
      });
      button.dataset.mediaAiPointerGuard = "true";
    }

    if (platform === "douyin") {
      const host = document.body;
      const placement = [platform, pathFor(input), "body-overlay"].join("|");
      const wrapper = ensureAiReplyWrapper(button);
      if (!host) return;
      lastReplyButtonPlacement = placement;
      wrapper.style.margin = "0";
      if (wrapper.parentElement !== host) {
        host.appendChild(wrapper);
      }
      positionDouyinAiReplyWrapper(wrapper, composer);
      return;
    }

    if (button.parentElement !== sendButton.parentElement || button.nextElementSibling !== sendButton) {
      sendButton.parentElement.insertBefore(button, sendButton);
    }
  };

  const scheduleInjectAiReplyButton = () => {
    if (replyButtonSyncTimer) return;
    replyButtonSyncTimer = window.setTimeout(() => {
      replyButtonSyncTimer = 0;
      injectAiReplyButton();
    }, 250);
  };

  const scheduleDouyinOverlayPosition = () => {
    if (platformFromLocation() !== "douyin") return;
    scheduleInjectAiReplyButton();
  };

  const extractXhsPage = () => {
    const platform = "xiaohongshu";
    const url = location.href;
    const title = compact(titleFromXhs() || textFrom(["h1"]) || document.title, 180);
    const author = compact(
      textFrom([
        ".author-wrapper .username",
        ".author-wrapper .name",
        ".author-wrapper a.name",
        ".author .name",
        ".user-name",
        ".username",
        ".nickname",
        "[class*='author'] [class*='name']"
      ]),
      80
    );
    const authorProfileId = firstProfileId(
      [".author-wrapper a[href*='/user/profile/']", ".note-detail-main a[href*='/user/profile/']", ".note-content a[href*='/user/profile/']"],
      platform
    );
    const viewer = viewerFrom(platform);
    const isOwnPage = Boolean(authorProfileId && viewer.profileId && authorProfileId === viewer.profileId);
    const content = compact(textFrom(["#detail-desc", ".note-content .desc", ".desc", ".content", "article"]) || document.body.innerText, 5000);
    const comments = collectComments(platform);
    const media = collectMedia(platform);

    return {
      ok: true,
      platform,
      platformLabel: platformLabel(platform),
      isSupported: true,
      isXiaohongshu: true,
      isDouyin: false,
      url,
      title,
      author,
      authorProfileId,
      viewerName: viewer.name,
      viewerProfileId: viewer.profileId,
      isOwnPage,
      content,
      comments,
      media,
      capturedAt: new Date().toISOString()
    };
  };

  const extractDouyinPage = (input = null) => {
    const platform = "douyin";
    const url = location.href;
    const root = getDouyinActiveRoot(input);
    const itemId = currentDouyinItemIdFromUrl();
    const candidate = bestDouyinJson(itemId);
    const node = candidate?.node || {};
    const authorNode = candidate?.author || {};
    const title = compact(titleFromDouyin(root, itemId) || document.title, 180);
    const author = compact(
      textFrom(
        [
          "[data-e2e='video-author-name']",
          "[data-e2e='browse-username']",
          "[data-e2e='user-title']",
          "[data-e2e='account-name']",
          "a[href*='/user/'] [class*='name']",
          "[class*='author'] [class*='name']",
          "[class*='user'] [class*='name']"
        ],
        root
      ) || textFromJsonField(authorNode.nickname, authorNode.name, authorNode.unique_id, authorNode.uniqueId),
      80
    );
    const authorProfileId = douyinAuthorProfileIdFromDom(root) || textFromJsonField(authorNode.sec_uid, authorNode.secUid, authorNode.uid, authorNode.user_id, authorNode.userId);
    const viewer = viewerFrom(platform);
    const ownPageConfidence = authorProfileId && viewer.profileId && authorProfileId === viewer.profileId ? "high" : "low";
    const isOwnPage = ownPageConfidence === "high";
    const desc = textFrom(["[data-e2e='video-desc']", "[data-e2e='browse-video-desc']", "[data-e2e='feed-video-desc']", "[data-e2e='aweme-desc']"], root);
    const metaDesc = metaContent(["meta[name='description']", "meta[property='og:description']"]);
    const jsonDesc = textFromJsonField(node.desc, node.description, node.title, node.share_desc, node.shareDesc);
    const content = compact(desc || jsonDesc || metaDesc || document.body.innerText, 5000);
    const comments = collectComments(platform, root);
    const media = collectMedia(platform, root, itemId);

    return {
      ok: true,
      platform,
      platformLabel: platformLabel(platform),
      isSupported: true,
      isXiaohongshu: false,
      isDouyin: true,
      url,
      title,
      author,
      authorProfileId,
      itemId,
      anchorPath: root && root !== document ? pathFor(root) : "",
      viewerName: viewer.name,
      viewerProfileId: viewer.profileId,
      isOwnPage,
      ownPageConfidence,
      content,
      comments,
      media,
      capturedAt: new Date().toISOString()
    };
  };

  const extractUnknownPage = () => {
    return {
      ok: false,
      platform: "unknown",
      platformLabel: platformLabel("unknown"),
      isSupported: false,
      isXiaohongshu: false,
      isDouyin: false,
      url: location.href,
      title: document.title || "AI 浏览助手",
      author: "",
      content: "",
      comments: [],
      media: { type: "unknown", images: [], imageItems: [], videos: [], posters: [], locations: [] },
      capturedAt: new Date().toISOString()
    };
  };

  const extractPage = () => {
    const platform = platformFromLocation();
    if (platform === "xiaohongshu") return extractXhsPage();
    if (platform === "douyin") return extractDouyinPage(findCommentInput(platform));
    return extractUnknownPage();
  };

  const pageSignature = () => {
    const page = extractPage();
    return [page.platform, page.url, page.title, page.author, page.content.slice(0, 800), page.media?.type || ""].join("|");
  };

  const notifyPageChanged = () => {
    const nextSignature = pageSignature();
    if (nextSignature === lastSignature) return;
    lastSignature = nextSignature;
    chrome.runtime.sendMessage({ type: "MEDIA_PAGE_CHANGED", platform: platformFromLocation() }).catch(() => {});
  };

  const patchHistory = () => {
    const wrap = (method) => {
      const original = history[method];
      history[method] = function patchedHistoryMethod(...args) {
        const result = original.apply(this, args);
        startObserver();
        notifyPageChanged();
        return result;
      };
    };

    wrap("pushState");
    wrap("replaceState");
    window.addEventListener("popstate", () => {
      startObserver();
      notifyPageChanged();
    });
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "MEDIA_OPEN_PLATFORM_AI") {
      sendResponse(openDouyinAskAi());
      return true;
    }
    if (message?.type !== "MEDIA_EXTRACT_PAGE" && message?.type !== "XHS_EXTRACT_PAGE") return false;
    const page = extractPage();
    lastSignature = [page.platform, page.url, page.title, page.author, page.content.slice(0, 800), page.media?.type || ""].join("|");
    sendResponse(page);
    return true;
  });

  const observeKeyNodes = () => {
    let observed = false;
    keySelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((target) => {
        if (observedNodes.has(target)) return;
        observedNodes.add(target);
        const observer = new MutationObserver(notifyPageChanged);
        observer.observe(target, {
          childList: true,
          subtree: true,
          characterData: true
        });
        observers.push(observer);
        observed = true;
      });
    });
    return observed;
  };

  const startObserver = () => {
    if (observeKeyNodes()) return;

    const target = document.body || document.documentElement;
    if (!target) return;
    const bootstrapObserver = new MutationObserver(() => {
      if (observeKeyNodes()) {
        bootstrapObserver.disconnect();
        notifyPageChanged();
      }
    });
    bootstrapObserver.observe(target, { childList: true, subtree: true });
  };

  patchHistory();
  startObserver();
  injectAiReplyButton();
  window.addEventListener("scroll", scheduleDouyinOverlayPosition, true);
  window.addEventListener("resize", scheduleDouyinOverlayPosition, true);
  new MutationObserver(scheduleInjectAiReplyButton).observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });
})();
