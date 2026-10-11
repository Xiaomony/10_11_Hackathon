const DEFAULT_STATE = {
  onboardingComplete: false,
  features: {
    aiDescription: false,
    imageDescribe: false,
    textReader: false,
    crosshair: false,
    colorBlindMode: "off",
  },
  apiKey: "",
  readingRate: 0.9,
};

const QWEN_API_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const QWEN_MODEL = "qwen-vl-plus"; // 视觉模型：截图/图片描述
const QWEN_TEXT_MODEL = "qwen-plus"; // 文本模型：无障碍树解析（后续 Agent 对话也复用）

/**
 * DashScope OpenAI 兼容接口的统一调用入口。
 * messages 为标准 chat 消息数组，后续 AI Agent 的多轮对话直接复用本函数。
 */
async function dashscopeChat(messages, apiKey, model = QWEN_TEXT_MODEL) {
  const response = await fetch(QWEN_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("模型返回为空");
  return typeof content === "string" ? content : JSON.stringify(content);
}

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

async function callQwenVL(imageBase64, apiKey, colorBlindMode, customPrompt) {
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

  return dashscopeChat(
    [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageBase64 } },
        ],
      },
    ],
    apiKey,
    QWEN_MODEL,
  );
}

/**
 * 文本模式：把无障碍树发给 qwen-plus 生成页面概述。
 * 比截图视觉模型更快、更省 token，且元素编号可被后续 Agent 引用。
 */
async function callQwenText({ title, url, tree, elementCount }, apiKey) {
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

  return dashscopeChat(
    [{ role: "user", content: prompt }],
    apiKey,
    QWEN_TEXT_MODEL,
  );
}

async function handleDescribePage(msg = {}) {
  const state = await getState();

  if (!state.apiKey) {
    return { error: "请先在插件设置中配置 API Key" };
  }

  const colorBlindOn =
    state.features.colorBlindMode && state.features.colorBlindMode !== "off";

  // 优先：无障碍树 + 文本模型（色盲模式需要标注颜色，仍走视觉模型）
  if (msg.mode === "a11y" && msg.tree && !colorBlindOn) {
    try {
      const description = await callQwenText(msg, state.apiKey);
      return { description, mode: "a11y" };
    } catch (e) {
      console.warn("无障碍树解析失败，回退截图模式：", e.message);
    }
  }

  // 兜底：可视区域截图 + 视觉模型
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: "png",
    });
    const description = await callQwenVL(
      dataUrl,
      state.apiKey,
      state.features.colorBlindMode,
    );
    return { description, mode: "screenshot" };
  } catch (e) {
    console.error("瞳伴 API 错误:", e.message);
    return { error: "页面解析失败，请检查 Key 和网络" };
  }
}

// 图片悬停描述：接收内容脚本裁剪好的单张图片，走视觉模型
async function handleDescribeImage(imageBase64) {
  const state = await getState();

  if (!state.apiKey) {
    return { error: "请先在插件设置中配置 API Key" };
  }

  try {
    const description = await callQwenVL(
      imageBase64,
      state.apiKey,
      state.features.colorBlindMode,
      "请用中文向视障用户描述这张网页截图中的图片：画面主体是什么、如有文字请读出来、并推测它的用途，不超过60字。",
    );
    return { description };
  } catch (e) {
    console.error("瞳伴图片描述错误:", e.message);
    return { error: "图片描述失败，请检查 Key 和网络" };
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
    } else if (command === "toggle-reader") {
      const newValue = !state.features.textReader;
      state.features.textReader = newValue;
      await saveState(state);
      await chrome.tabs.sendMessage(tab.id, {
        type: "TOGGLE_FEATURE",
        feature: "textReader",
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
});
