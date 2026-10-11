const DEFAULT_STATE = {
  onboardingComplete: false,
  features: {
    aiDescription: false,
    imageDescribe: false,
    textReader: false,
    crosshair: false,
    readingGuide: false,
    typography: false,
    bigCursor: false,
    colorBlindMode: "off",
    danmakuSummary: false,
  },
  apiKey: "",
  demoMode: false,
  readingRate: 0.9,
};

// AI 服务：Agnes AI（OpenAI 兼容接口），同一模型同时承担视觉与文本任务。
// 如需切换服务商，只需修改这两个常量（请求/响应格式均为 OpenAI Chat Completions）。
const AGNES_API_URL = "https://api.agnes-ai.cn/v1/chat/completions";
const AGNES_MODEL = "agnes-3.0-flash";

async function getState() {
  const result = await chrome.storage.local.get("eyebuddyState");
  return result.eyebuddyState || DEFAULT_STATE;
}

async function saveState(state) {
  await chrome.storage.local.set({ eyebuddyState: state });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// 把 Agnes（OpenAI 兼容）错误响应转换为用户可读懂的中文提示
async function buildApiError(response) {
  let serverMsg = "";
  try {
    const errText = await response.text();
    try {
      const errJson = JSON.parse(errText);
      serverMsg =
        errJson?.error?.message || errJson?.message || errJson?.msg || errText;
    } catch {
      serverMsg = errText;
    }
  } catch {
    serverMsg = "";
  }
  serverMsg = String(serverMsg || "").trim().slice(0, 300);
  const suffix = serverMsg ? `：${serverMsg}` : "";
  switch (response.status) {
    case 401:
      return "API Key 无效或已失效，请重新检查设置中的 Agnes API Key";
    case 403:
      return `API Key 无访问权限、账户欠费或未开通模型权限${suffix}`;
    case 404:
      return `接口地址或模型名称不存在（404），请确认模型 ${AGNES_MODEL} 是否可用${suffix}`;
    case 429:
      return `请求过于频繁或免费额度已用完（429）${suffix}`;
    default:
      return `API 调用失败（HTTP ${response.status}）${suffix}`;
  }
}

/**
 * Agnes（OpenAI 兼容）接口的统一调用入口。
 * messages 为标准 chat 消息数组（可含图片），后续 AI Agent 的多轮对话直接复用本函数。
 */
async function agnesChat(messages, apiKey, maxTokens = 300) {
  let response;
  try {
    response = await fetch(AGNES_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: AGNES_MODEL,
        max_tokens: maxTokens,
        messages,
      }),
    });
  } catch (networkErr) {
    throw new Error(
      `无法连接 Agnes API 服务器（${AGNES_API_URL}），请检查网络：${networkErr.message}`,
    );
  }

  if (!response.ok) {
    throw new Error(await buildApiError(response));
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(
      "API 返回内容为空或响应格式异常：" + JSON.stringify(data).slice(0, 200),
    );
  }
  return typeof content === "string" ? content : JSON.stringify(content);
}

async function callVisionAPI(
  imageDataUrl,
  apiKey,
  colorBlindMode,
  customPrompt,
) {
  let prompt =
    customPrompt ||
    "请用中文描述这个网页画面的内容，包括页面布局、图片、文字区域、按钮等可见元素，不超过100字。";

  // 四功能协同：色盲模式开启时，AI 描述自动补充颜色信息
  if (colorBlindMode && colorBlindMode !== "off") {
    const modeNames = {
      protanopia: "红绿色盲",
      deuteranomaly: "绿色弱",
      tritanopia: "蓝黄色盲",
    };
    prompt = customPrompt
      ? `${customPrompt}（用户开启了${modeNames[colorBlindMode]}校正模式，请在描述中标注关键元素的颜色，如"红色按钮""蓝色标题"。）`
      : `用户当前处于${modeNames[colorBlindMode]}色盲校正模式。请用中文描述这个网页画面的内容，包括页面布局、图片、文字区域、按钮等可见元素，并在描述中标注关键元素的颜色（如"红色按钮""绿色链接""蓝色标题"），不超过120字。`;
  }

  return agnesChat(
    [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
    apiKey,
  );
}

/**
 * 文本模式：把无障碍树发给 Agnes 生成页面概述。
 * 比截图视觉模型更快、更省 token，且元素编号可被后续 Agent 引用。
 */
async function callA11yText({ title, url, tree, elementCount }, apiKey) {
  const prompt =
    `你是一名面向视障用户的网页阅读助手。以下是网页《${title || "(无标题)"}》（${url}）的无障碍树，` +
    "它是页面可见元素的精简结构：每行格式为「[编号] 角色: 名称」，缩进表示包含关系；" +
    "常见角色有 heading(标题)、link(链接)、button(按钮)、textbox(输入框)、img(图片)、video(视频)，" +
    "以及 navigation/main/banner 等页面分区；共约 " +
    (elementCount || 0) +
    " 个元素。\n" +
    "请用中文向视障用户概述：1)这是什么页面；2)主要分区与布局；3)重点内容和可以进行的操作。" +
    "控制在150字以内，直接输出描述本身，不要分点、不要标题。\n\n" +
    tree;

  return agnesChat([{ role: "user", content: prompt }], apiKey, 400);
}

async function handleDescribePage(msg = {}) {
  const state = await getState();

  // 演示模式：无需 API Key，返回预置的整页描述
  if (state.demoMode) {
    return {
      description:
        "这是一个资讯类网页：顶部是网站标题和导航栏，中间是文章正文，配有两张插图，底部有一排相关内容的链接。",
    };
  }

  if (!state.apiKey) {
    return { error: "请先在插件设置中配置 API Key" };
  }

  const colorBlindOn =
    state.features.colorBlindMode && state.features.colorBlindMode !== "off";

  // 优先：无障碍树 + 文本调用（色盲模式需要标注颜色，仍走视觉模型）
  if (msg.mode === "a11y" && msg.tree && !colorBlindOn) {
    try {
      const description = await callA11yText(msg, state.apiKey);
      return { description, mode: "a11y" };
    } catch (e) {
      console.warn("无障碍树解析失败，回退截图模式：", e.message);
    }
  }

  // 兜底：可视区域截图 + 视觉模型
  try {
    // JPEG 压缩：整页 PNG 可达数 MB，JPEG q80 通常仅几百 KB
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: "jpeg",
      quality: 80,
    });
    const description = await callVisionAPI(
      dataUrl,
      state.apiKey,
      state.features.colorBlindMode,
    );
    return { description, mode: "screenshot" };
  } catch (e) {
    console.error("瞳伴 API 错误:", e);
    return { error: e.message || "截图或 API 调用失败" };
  }
}

// 图片悬停描述：接收内容脚本裁剪好的单张图片，走视觉模型
async function handleDescribeImage(imageBase64) {
  const state = await getState();

  if (!state.apiKey) {
    return { error: "请先在插件设置中配置 API Key" };
  }

  try {
    const description = await callVisionAPI(
      imageBase64,
      state.apiKey,
      state.features.colorBlindMode,
      "请用中文向视障用户描述这张网页截图中的图片：画面主体是什么、如有文字请读出来、并推测它的用途，不超过60字。",
    );
    return { description };
  } catch (e) {
    console.error("瞳伴图片描述错误:", e);
    return { error: e.message || "图片描述失败" };
  }
}

const DANMAKU_API_URL = "https://api.bilibili.com/x/v1/dm/list.so";
const MAX_DANMAKU_ITEMS = 4000;

function formatDanmakuTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseDanmakuXML(xmlText) {
  const items = [];
  const re = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let m;
  while ((m = re.exec(xmlText)) !== null) {
    const p = m[1].split(",");
    if (p.length < 8) continue;
    const type = parseInt(p[1]);
    if (![1, 2, 3].includes(type)) continue;
    const content = decodeXmlEntities(m[2]).trim();
    if (!content) continue;
    items.push({
      time: parseFloat(p[0]),
      sendTime: parseInt(p[4]),
      content,
    });
  }
  return items.sort((a, b) => a.time - b.time);
}

async function fetchDanmaku(cid) {
  const urls = [
    `${DANMAKU_API_URL}?oid=${cid}`,
    `https://comment.bilibili.com/${cid}.xml`,
  ];
  let lastError = null;

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { Referer: "https://www.bilibili.com" },
        credentials: "include",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const xmlText = await response.text();
      if (!xmlText.includes("<d ")) {
        throw new Error("响应不是有效弹幕XML");
      }
      return parseDanmakuXML(xmlText);
    } catch (e) {
      console.error(`瞳伴弹幕接口失败(${url}):`, e.message);
      lastError = e;
    }
  }
  throw lastError || new Error("弹幕接口全部失败");
}

async function summarizeDanmaku(items, apiKey) {
  const lines = items
    .slice(0, MAX_DANMAKU_ITEMS)
    .map((it) => `${formatDanmakuTime(it.time)} ${it.content}`)
    .join("\n");

  const prompt = `以下是B站视频的全部弹幕数据（含时间点与内容）。
请总结弹幕中观众讨论的核心观点、高频话题和热点评论。
要求：口语化、适合语音播报、不超过120字。
按时间顺序提及2-3个关键时间节点。

弹幕数据：
---
${lines}
---`;

  const response = await fetch(AGNES_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: AGNES_MODEL,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "无法生成总结";
}

async function resolveCid(bvid, page) {
  const resp = await fetch(
    `https://api.bilibili.com/x/player/pagelist?bvid=${bvid}&jsonp=jsonp`,
    { headers: { Referer: "https://www.bilibili.com" } },
  );
  if (!resp.ok) throw new Error(`pagelist ${resp.status}`);
  const data = await resp.json();
  const pages = data?.data || [];
  if (pages.length === 0) return null;
  const idx = Math.min(Math.max((page || 1) - 1, 0), pages.length - 1);
  return pages[idx]?.cid || null;
}

async function handleDanmakuSummary(cid, bvid, page) {
  const state = await getState();

  if (!state.apiKey && !state.demoMode) {
    return { error: "请先在插件设置中配置 API Key" };
  }

  if (!cid && bvid) {
    try {
      cid = await resolveCid(bvid, page);
    } catch (e) {
      console.error("瞳伴cid解析错误:", e.message);
    }
  }
  if (!cid) {
    return { error: "无法获取视频弹幕ID" };
  }

  let items;
  try {
    items = await fetchDanmaku(cid);
  } catch (e) {
    console.error("瞳伴弹幕获取错误:", e.message);
    return { error: "弹幕获取失败，可能视频无弹幕或接口限制" };
  }

  if (!items || items.length === 0) {
    return { error: "该视频暂无弹幕" };
  }

  if (state.demoMode) {
    await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1000));
    return {
      summary: `这条视频共抓取到${items.length}条弹幕，讨论非常热烈。开场2分钟大家刷"前排"和"来了"，12分左右集中讨论主角操作细节，结尾处"泪目"和"完结撒花"刷屏。整体情绪以感动和认可为主。`,
    };
  }

  try {
    const summary = await summarizeDanmaku(items, state.apiKey);
    return { summary };
  } catch (e) {
    console.error("瞳伴弹幕总结错误:", e.message);
    return { error: "弹幕总结失败，请检查 Key 和网络" };
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  const state = await getState();
  const tab = await getActiveTab();
  if (!tab) return;

  try {
    if (command === "toggle-crosshair") {
      const newValue = !state.features.crosshair;
      state.features.crosshair = newValue;
      await saveState(state);
      await chrome.tabs.sendMessage(tab.id, {
        type: "TOGGLE_FEATURE",
        feature: "crosshair",
        enabled: newValue,
      });
    } else if (command === "describe-page") {
      await chrome.tabs.sendMessage(tab.id, { type: "SCAN_NOW" });
    } else if (command === "danmaku-summary") {
      await chrome.tabs.sendMessage(tab.id, { type: "DANMAKU_SUMMARY_NOW" });
    } else if (command === "toggle-reader") {
      const newValue = !state.features.textReader;
      state.features.textReader = newValue;
      await saveState(state);
      await chrome.tabs.sendMessage(tab.id, {
        type: "TOGGLE_FEATURE",
        feature: "textReader",
        enabled: newValue,
      });
    } else if (command === "toggle-reading-guide") {
      const newValue = !state.features.readingGuide;
      state.features.readingGuide = newValue;
      await saveState(state);
      await chrome.tabs.sendMessage(tab.id, {
        type: "TOGGLE_FEATURE",
        feature: "readingGuide",
        enabled: newValue,
      });
    } else if (command === "toggle-typography") {
      const newValue = !state.features.typography;
      state.features.typography = newValue;
      await saveState(state);
      await chrome.tabs.sendMessage(tab.id, {
        type: "TOGGLE_FEATURE",
        feature: "typography",
        enabled: newValue,
      });
    } else if (command === "toggle-bigcursor") {
      const newValue = !state.features.bigCursor;
      state.features.bigCursor = newValue;
      await saveState(state);
      await chrome.tabs.sendMessage(tab.id, {
        type: "TOGGLE_FEATURE",
        feature: "bigCursor",
        enabled: newValue,
      });
    } else if (command === "cycle-colorblind") {
      const modes = ["off", "protanopia", "deuteranomaly", "tritanopia"];
      const currentIdx = modes.indexOf(state.features.colorBlindMode);
      const nextMode = modes[(currentIdx + 1) % modes.length];
      state.features.colorBlindMode = nextMode;
      await saveState(state);
      await chrome.tabs.sendMessage(tab.id, {
        type: "SET_CB_MODE",
        mode: nextMode,
      });
    }
  } catch (e) {
    console.log("瞳伴：当前页面不可用");
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "DESCRIBE_PAGE") {
    handleDescribePage(msg).then(sendResponse);
    return true;
  }
  if (msg.type === "CAPTURE_SCREEN") {
    // 供内容脚本截取当前可视区域，用于裁剪单张图片
    chrome.tabs
      .captureVisibleTab(null, { format: "png" })
      .then((dataUrl) => sendResponse({ dataUrl }))
      .catch((e) => sendResponse({ error: "截图失败：" + e.message }));
    return true;
  }
  if (msg.type === "DESCRIBE_IMAGE_AI") {
    handleDescribeImage(msg.imageBase64).then(sendResponse);
    return true;
  }
  if (msg.type === "FETCH_DANMAKU") {
    handleDanmakuSummary(msg.cid, msg.bvid, msg.page).then(sendResponse);
    return true;
  }
});
