const DEFAULT_STATE = {
  onboardingComplete: false,
  features: {
    aiDescription: false,
    imageDescribe: false,
    textReader: false,
    crosshair: false,
    readingGuide: false,
    colorBlindMode: "off",
  },
  apiKey: "",
  demoMode: false,
  readingRate: 0.9,
};

// AI 视觉服务：Agnes AI（OpenAI 兼容接口）。
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
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
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

async function handleDescribePage() {
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
    return { description };
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
    } else if (command === "toggle-reading-guide") {
      const newValue = !state.features.readingGuide;
      state.features.readingGuide = newValue;
      await saveState(state);
      await chrome.tabs.sendMessage(tab.id, {
        type: "TOGGLE_FEATURE",
        feature: "readingGuide",
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
    handleDescribePage().then(sendResponse);
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
