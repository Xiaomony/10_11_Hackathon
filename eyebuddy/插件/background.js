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
const QWEN_MODEL = "qwen-vl-plus";

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

  const response = await fetch(QWEN_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: QWEN_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageBase64 } },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "无法生成描述";
}

async function handleDescribePage() {
  const state = await getState();

  if (!state.apiKey) {
    return { error: "请先在插件设置中配置 API Key" };
  }

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: "png",
    });
    const description = await callQwenVL(
      dataUrl,
      state.apiKey,
      state.features.colorBlindMode,
    );
    return { description };
  } catch (e) {
    console.error("瞳伴 API 错误:", e.message);
    return { error: "截图或 API 调用失败，请检查 Key 和网络" };
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
