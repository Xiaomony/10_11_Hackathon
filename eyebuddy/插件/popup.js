const DEFAULT_STATE = {
  onboardingComplete: false,
  features: {
    aiDescription: false,
    imageDescribe: false,
    textReader: false,
    crosshair: false,
    colorBlindMode: "off",
    danmakuSummary: false,
  },
  apiKey: "",
  demoMode: false,
  readingRate: 0.9,
};

const $ = (id) => document.getElementById(id);

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

async function sendToContentScript(message) {
  const tab = await getActiveTab();
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, message);
  } catch (e) {
    console.log("瞳伴：当前页面不可用");
  }
}

async function toggleFeature(feature, enabled) {
  const state = await getState();
  state.features[feature] = enabled;
  await saveState(state);
  await sendToContentScript({ type: "TOGGLE_FEATURE", feature, enabled });
  updateUI(state);
}

async function setColorBlindMode(mode) {
  const state = await getState();
  state.features.colorBlindMode = mode;
  await saveState(state);
  await sendToContentScript({ type: "SET_CB_MODE", mode });
  updateUI(state);
}

const CB_LABELS = {
  protanopia: "红绿色盲",
  deuteranomaly: "绿色弱",
  tritanopia: "蓝黄色盲",
};

function updateUI(state) {
  const { features, onboardingComplete } = state;

  if (onboardingComplete) {
    $("onboarding").classList.add("hidden");
    $("control-panel").classList.remove("hidden");
  } else {
    $("onboarding").classList.remove("hidden");
    $("control-panel").classList.add("hidden");
  }

  $("toggle-ai").checked = features.aiDescription;
  $("ai-status").textContent = features.aiDescription ? "已开启" : "未开启";
  $("ai-status").classList.toggle("active", features.aiDescription);
  $("scan-now").classList.toggle("hidden", !features.aiDescription);

  $("toggle-imgdesc").checked = features.imageDescribe;
  $("imgdesc-status").textContent = features.imageDescribe
    ? "已开启"
    : "未开启";
  $("imgdesc-status").classList.toggle("active", features.imageDescribe);

  $("toggle-danmaku").checked = !!features.danmakuSummary;
  $("dm-status").textContent = features.danmakuSummary ? "已开启" : "未开启";
  $("dm-status").classList.toggle("active", !!features.danmakuSummary);

  $("toggle-tts").checked = features.textReader;
  $("tts-status").textContent = features.textReader ? "已开启" : "未开启";
  $("tts-status").classList.toggle("active", features.textReader);

  $("toggle-crosshair").checked = features.crosshair;
  $("crosshair-status").textContent = features.crosshair ? "已开启" : "未开启";
  $("crosshair-status").classList.toggle("active", features.crosshair);

  const cbEnabled = features.colorBlindMode !== "off";
  $("toggle-cb").checked = cbEnabled;
  $("cb-status").textContent = cbEnabled
    ? CB_LABELS[features.colorBlindMode]
    : "未开启";
  $("cb-status").classList.toggle("active", cbEnabled);
  $("cb-modes").classList.toggle("hidden", !cbEnabled);

  if (cbEnabled) {
    const radio = document.querySelector(
      `input[name="cb-mode"][value="${features.colorBlindMode}"]`,
    );
    if (radio) radio.checked = true;
  }
}

async function completeOnboarding(features) {
  const state = await getState();
  state.onboardingComplete = true;
  if (features === "all") {
    state.features.aiDescription = true;
    state.features.imageDescribe = true;
    state.features.textReader = true;
    state.features.crosshair = true;
    state.features.colorBlindMode = "protanopia";
  } else if (features === "aiDescription") {
    state.features.aiDescription = true;
    state.features.textReader = true;
  } else if (features === "imageDescribe") {
    state.features.imageDescribe = true;
  } else if (features === "crosshair") {
    state.features.crosshair = true;
  } else if (features === "textReader") {
    state.features.textReader = true;
  } else if (features === "colorBlindness") {
    state.features.colorBlindMode = "protanopia";
  }
  await saveState(state);
  await sendToContentScript({
    type: "INIT_FEATURES",
    features: state.features,
  });
  updateUI(state);
}

function bindOnboarding() {
  document.querySelectorAll(".scene-card").forEach((card) => {
    card.addEventListener("click", () => {
      document
        .querySelectorAll(".scene-card")
        .forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      completeOnboarding(card.dataset.feature);
    });
  });

  $("enable-all").addEventListener("click", () => completeOnboarding("all"));
  $("skip-onboarding").addEventListener("click", () =>
    completeOnboarding("none"),
  );
}

function bindToggles() {
  $("toggle-ai").addEventListener("change", (e) => {
    toggleFeature("aiDescription", e.target.checked);
  });

  $("toggle-imgdesc").addEventListener("change", (e) => {
    toggleFeature("imageDescribe", e.target.checked);
  });

  $("toggle-danmaku").addEventListener("change", (e) => {
    toggleFeature("danmakuSummary", e.target.checked);
  });

  $("toggle-tts").addEventListener("change", (e) => {
    toggleFeature("textReader", e.target.checked);
  });

  $("toggle-crosshair").addEventListener("change", (e) => {
    toggleFeature("crosshair", e.target.checked);
  });

  $("toggle-cb").addEventListener("change", (e) => {
    if (e.target.checked) {
      setColorBlindMode("protanopia");
    } else {
      setColorBlindMode("off");
    }
  });

  document.querySelectorAll('input[name="cb-mode"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      setColorBlindMode(e.target.value);
    });
  });

  $("scan-now").addEventListener("click", () => {
    sendToContentScript({ type: "SCAN_NOW" });
  });
}

function bindSettings() {
  $("api-key-input").addEventListener("change", async (e) => {
    const state = await getState();
    state.apiKey = e.target.value.trim();
    await saveState(state);
  });

  $("reading-rate-input").addEventListener("input", async (e) => {
    const rate = parseFloat(e.target.value);
    $("reading-rate-value").textContent = rate.toFixed(1);
    const state = await getState();
    state.readingRate = rate;
    await saveState(state);
    await sendToContentScript({ type: "SET_READING_RATE", rate });
  });

  $("toggle-demo").addEventListener("change", async (e) => {
    const state = await getState();
    state.demoMode = e.target.checked;
    await saveState(state);
  });

  $("show-onboarding").addEventListener("click", async () => {
    const state = await getState();
    state.onboardingComplete = false;
    await saveState(state);
    updateUI(state);
  });

  $("help-btn").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://github.com/Wayhhow" });
  });
}

function bindVoice() {
  $("open-voice").addEventListener("click", () => {
    $("control-panel").classList.add("hidden");
    $("voice-panel").classList.remove("hidden");
  });

  $("voice-back").addEventListener("click", async () => {
    $("voice-panel").classList.add("hidden");
    const state = await getState();
    updateUI(state);
  });

  // 演示逻辑：不管说什么，都“执行”同一条指令——打开 bilibili
  const runVoiceCommand = (text) => {
    const t = (text || "").trim();
    if (!t) return;
    $("voice-user").textContent = "你：" + t;
    $("voice-user").classList.remove("hidden");
    $("voice-ai").textContent = "好的，正在为你打开 bilibili…";
    $("voice-ai").classList.remove("hidden");
    $("voice-status").textContent = "指令已识别，正在执行";
    setTimeout(
      () => chrome.tabs.create({ url: "https://www.bilibili.com" }),
      800,
    );
  };

  $("voice-send").addEventListener("click", () =>
    runVoiceCommand($("voice-input").value),
  );
  $("voice-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runVoiceCommand($("voice-input").value);
  });

  // 麦克风：模拟语音识别——聆听 1.5 秒后自动“听”到指令，再执行
  $("voice-mic").addEventListener("click", () => {
    const mic = $("voice-mic");
    if (mic.classList.contains("listening")) return;
    mic.classList.add("listening");
    $("voice-status").textContent = "正在聆听…（演示识别）";
    $("voice-status").classList.add("listening");
    $("voice-input").value = "";

    setTimeout(() => {
      mic.classList.remove("listening");
      $("voice-status").classList.remove("listening");
      $("voice-status").textContent = "识别完成：帮我打开bilibili";
      $("voice-input").value = "帮我打开bilibili";
      setTimeout(() => runVoiceCommand($("voice-input").value), 2500);
    }, 1500);
  });
}

async function init() {
  const state = await getState();
  $("api-key-input").value = state.apiKey || "";
  $("toggle-demo").checked = !!state.demoMode;
  const rate = state.readingRate || 0.9;
  $("reading-rate-input").value = rate;
  $("reading-rate-value").textContent = rate.toFixed(1);
  updateUI(state);
  bindOnboarding();
  bindToggles();
  bindSettings();
  bindVoice();
}

init();
