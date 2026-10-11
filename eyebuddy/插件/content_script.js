const PREFIX = "eyebuddy";
// 演示模式通用描述池：悬停任意无描述图片时按顺序轮换
const DEMO_DESCRIPTIONS = [
  "这是一张风景照片，远处有连绵的山峦和一片湖泊，天空呈现日出时的金色。",
  "这是一张人物肖像照片，背景虚化，看起来是新闻或博客文章的配图。",
  "画面中是一个产品展示图，主体居中，下方有文字说明区域。",
  "这是一张活动现场照片，能看到人群和舞台，可能拍摄于某次活动或聚会。",
];
const DEFAULT_STATE = {
  features: {
    aiDescription: false,
    imageDescribe: false,
    textReader: false,
    crosshair: false,
    readingGuide: false,
    typography: false,
    bigCursor: false,
    colorBlindMode: "off",
  },
  readingRate: 0.9,
};

const CB_MATRICES = {
  protanopia: "0.567 0.433 0 0 0 0.558 0.442 0 0 0 0 0.242 0.758 0 0 0 0 0 1 0",
  deuteranomaly: "0.8 0.2 0 0 0 0.258 0.742 0 0 0 0 0.142 0.858 0 0 0 0 0 1 0",
  tritanopia: "0.95 0.05 0 0 0 0 0.433 0.567 0 0 0 0.475 0.525 0 0 0 0 0 1 0",
};

async function getState() {
  const result = await chrome.storage.local.get("eyebuddyState");
  return result.eyebuddyState || DEFAULT_STATE;
}

const AIDescription = {
  panel: null,

  enable() {},

  disable() {
    this.closePanel();
  },

  async describePage() {
    this.showLoading();

    try {
      const response = await chrome.runtime.sendMessage({
        type: "DESCRIBE_PAGE",
      });

      if (response && response.description) {
        this.showPanel(response.description);
        if (TextReader.enabled) {
          TextReader.speak(response.description);
        }
      } else if (response && response.error) {
        this.showPanel("⚠️ " + response.error, true);
      }
    } catch (e) {
      this.showPanel("⚠️ 描述失败", true);
    }
  },

  showLoading() {
    this.closePanel();
    const panel = document.createElement("div");
    panel.className = `${PREFIX}-ai-panel`;
    panel.textContent = "🔍 正在分析页面画面...";
    panel.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      padding: 20px 32px;
      background: #fff;
      color: #006064;
      font-size: 16px;
      font-family: -apple-system, "Microsoft YaHei", sans-serif;
      border-radius: 12px;
      border: 2px solid #00b8d4;
      box-shadow: 0 4px 24px rgba(0,0,0,0.2);
      z-index: 2147483647;
      pointer-events: none;
    `;
    document.body.appendChild(panel);
    this.panel = panel;
  },

  showPanel(text, isError = false) {
    this.closePanel();

    const panel = document.createElement("div");
    panel.className = `${PREFIX}-ai-panel`;
    panel.textContent = text;
    panel.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      max-width: 420px;
      padding: 20px 24px;
      background: ${isError ? "#fff3e0" : "#fff"};
      color: ${isError ? "#e65100" : "#1a1a1a"};
      font-size: 15px;
      line-height: 1.6;
      font-family: -apple-system, "Microsoft YaHei", sans-serif;
      border-radius: 12px;
      border: 2px solid ${isError ? "#ff9800" : "#00b8d4"};
      box-shadow: 0 4px 24px rgba(0,0,0,0.2);
      z-index: 2147483647;
      pointer-events: auto;
    `;

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.style.cssText = `
      position: absolute;
      top: 8px;
      right: 12px;
      border: none;
      background: none;
      font-size: 18px;
      color: #999;
      cursor: pointer;
    `;
    closeBtn.onclick = () => this.closePanel();
    panel.appendChild(closeBtn);

    document.body.appendChild(panel);
    this.panel = panel;

    setTimeout(() => this.closePanel(), 15000);
  },

  closePanel() {
    if (this.panel) {
      this.panel.remove();
      this.panel = null;
    }
  },
};

// 图片悬停描述：有 alt/aria-label 直接朗读（零 API 成本），没有则截图裁剪走视觉模型
const ImageDescriber = {
  enabled: false,
  hoverTimer: null,
  busy: false,
  lastEl: null,
  lastTime: 0,
  demoIdx: 0,

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.hoverHandler = (e) => this.handleHover(e);
    document.addEventListener("mouseover", this.hoverHandler);
  },

  disable() {
    this.enabled = false;
    clearTimeout(this.hoverTimer);
    if (this.hoverHandler) {
      document.removeEventListener("mouseover", this.hoverHandler);
      this.hoverHandler = null;
    }
  },

  handleHover(e) {
    const el = e.target;
    if (!this.enabled || !el || el.tagName !== "IMG") return;
    if (this.busy) return;

    const rect = el.getBoundingClientRect();
    // 太小或不在可视区域内的图跳过
    if (rect.width < 40 || rect.height < 40) return;
    if (
      rect.bottom < 0 ||
      rect.right < 0 ||
      rect.top > innerHeight ||
      rect.left > innerWidth
    )
      return;

    // 同一张图 4 秒内不重复描述
    if (el === this.lastEl && Date.now() - this.lastTime < 4000) return;

    clearTimeout(this.hoverTimer);
    this.hoverTimer = setTimeout(() => this.describe(el, rect), 600);
  },

  async describe(el, rect) {
    // 已有替代文本：直接用，不耗 API
    const alt = el.getAttribute("alt")?.trim();
    const aria = el.getAttribute("aria-label")?.trim();
    const label = alt || aria;
    if (label && label.length > 1) {
      if (TextReader.enabled) {
        TextReader.speak("图片：" + label, el);
      } else {
        AIDescription.showPanel("🖼️ 图片：" + label);
      }
      this.lastEl = el;
      this.lastTime = Date.now();
      return;
    }

    if (this.busy) return;
    this.busy = true;

    try {
      const state = await getState();

      // 演示模式：不调 API，模拟真实延迟后返回预置描述（现场无 API Key 时的兜底）
      if (state.demoMode) {
        AIDescription.showLoading();
        await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1000));
        const description =
          el.dataset.demoDesc ||
          DEMO_DESCRIPTIONS[this.demoIdx++ % DEMO_DESCRIPTIONS.length];
        AIDescription.showPanel("🖼️ " + description);
        if (TextReader.enabled) {
          TextReader.speak(description);
        }
        this.lastEl = el;
        this.lastTime = Date.now();
        return;
      }

      // 先截图再显示加载面板，避免面板被截进图里
      const cap = await chrome.runtime.sendMessage({ type: "CAPTURE_SCREEN" });
      if (!cap || cap.error || !cap.dataUrl)
        throw new Error(cap?.error || "截图失败");

      AIDescription.showLoading();
      const cropped = await this.cropImage(cap.dataUrl, rect);
      const resp = await chrome.runtime.sendMessage({
        type: "DESCRIBE_IMAGE_AI",
        imageBase64: cropped,
      });

      if (resp && resp.description) {
        AIDescription.showPanel("🖼️ " + resp.description);
        if (TextReader.enabled) {
          TextReader.speak(resp.description);
        }
      } else if (resp && resp.error) {
        AIDescription.showPanel("⚠️ " + resp.error, true);
      }

      this.lastEl = el;
      this.lastTime = Date.now();
    } catch (err) {
      AIDescription.showPanel("⚠️ 图片描述失败", true);
    } finally {
      this.busy = false;
    }
  },

  // 从整页截图中按元素位置裁出单张图片
  cropImage(dataUrl, rect) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const dpr = img.width / window.innerWidth || 1;
          const sx = Math.max(0, rect.left * dpr);
          const sy = Math.max(0, rect.top * dpr);
          const sw = Math.min(img.width - sx, rect.width * dpr);
          const sh = Math.min(img.height - sy, rect.height * dpr);
          if (sw < 5 || sh < 5) throw new Error("图片区域无效");
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(sw);
          canvas.height = Math.round(sh);
          canvas
            .getContext("2d")
            .drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.85));
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  },
};

const TextReader = {
  enabled: false,
  hoverTimer: null,
  lastSpoken: "",
  highlightedEl: null,
  rate: 0.9,

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.hoverHandler = (e) => this.handleHover(e);
    this.selectHandler = () => this.handleSelection();
    document.addEventListener("mouseover", this.hoverHandler);
    document.addEventListener("selectionchange", this.selectHandler);
  },

  disable() {
    this.enabled = false;
    this.stop();
    this.clearHighlight();
    if (this.hoverHandler) {
      document.removeEventListener("mouseover", this.hoverHandler);
      this.hoverHandler = null;
    }
    if (this.selectHandler) {
      document.removeEventListener("selectionchange", this.selectHandler);
      this.selectHandler = null;
    }
    clearTimeout(this.hoverTimer);
  },

  handleHover(e) {
    const el = e.target;
    if (!el || el === document.body) return;

    const tag = el.tagName;
    if (
      ![
        "P",
        "H1",
        "H2",
        "H3",
        "H4",
        "H5",
        "H6",
        "LI",
        "TD",
        "SPAN",
        "A",
        "LABEL",
        "BUTTON",
      ].includes(tag)
    )
      return;

    const text = el.innerText?.trim();
    if (!text || text.length < 2 || text === this.lastSpoken) return;

    clearTimeout(this.hoverTimer);
    this.hoverTimer = setTimeout(() => {
      if (!this.enabled) return;
      this.speak(text, el);
    }, 500);
  },

  handleSelection() {
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!text || text.length < 2) return;
    this.speak(text);
  },

  speak(text, el) {
    if (!("speechSynthesis" in window)) return;

    this.clearHighlight();
    this.stop();
    this.lastSpoken = text;

    if (el) this.highlight(el);

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = this.rate || 0.9;
    utterance.pitch = 1;

    const voices = window.speechSynthesis.getVoices();
    const zhVoice = voices.find((v) => v.lang.startsWith("zh"));
    if (zhVoice) utterance.voice = zhVoice;

    const targetEl = el || null;
    utterance.onend = () => {
      if (this.highlightedEl === targetEl) this.clearHighlight();
    };
    utterance.onerror = () => {
      if (this.highlightedEl === targetEl) this.clearHighlight();
    };

    window.speechSynthesis.speak(utterance);
  },

  highlight(el) {
    this.highlightedEl = el;
    this.savedBg = el.style.backgroundColor;
    this.savedColor = el.style.color;
    this.savedBorder = el.style.outline;
    this.savedRadius = el.style.borderRadius;
    el.style.backgroundColor = "#fff9c4";
    el.style.color = "#1a1a1a";
    el.style.outline = "3px solid #fdd835";
    el.style.borderRadius = "4px";
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });

    // 四功能协同：朗读时十字准星自动跟随当前高亮元素
    if (Crosshair.elements.length > 0) {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      Crosshair.update(cx, cy);
    }
  },

  clearHighlight() {
    if (this.highlightedEl) {
      this.highlightedEl.style.backgroundColor = this.savedBg || "";
      this.highlightedEl.style.color = this.savedColor || "";
      this.highlightedEl.style.outline = this.savedBorder || "";
      this.highlightedEl.style.borderRadius = this.savedRadius || "";
      this.highlightedEl = null;
    }
  },

  stop() {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  },
};

// 阅读辅助线：跟随鼠标的聚焦遮罩，上下暗化、中间留出清晰阅读窗口，帮助专注当前行
const ReadingGuide = {
  elements: [],
  enabled: false,
  windowHeight: 90, // 中间清晰窗口的高度（px）

  create() {
    if (this.elements.length > 0) return;
    this.enabled = true;

    const maskStyle = `
      position: fixed;
      left: 0;
      width: 100vw;
      background: rgba(0, 0, 0, 0.45);
      z-index: 2147483646;
      pointer-events: none;
    `;
    const lineStyle = `
      position: fixed;
      left: 0;
      width: 100vw;
      height: 2px;
      background: #ffd54f;
      box-shadow: 0 0 4px rgba(255, 213, 79, 0.8);
      z-index: 2147483646;
      pointer-events: none;
    `;

    const topMask = document.createElement("div");
    topMask.style.cssText = maskStyle + "top: 0; height: 0;";
    const bottomMask = document.createElement("div");
    bottomMask.style.cssText = maskStyle + "top: 0; height: 0;";
    const topLine = document.createElement("div");
    topLine.style.cssText = lineStyle;
    const bottomLine = document.createElement("div");
    bottomLine.style.cssText = lineStyle;

    this.elements = [topMask, bottomMask, topLine, bottomLine];
    this.elements.forEach((el) => document.body.appendChild(el));

    this.moveHandler = (e) => this.update(e.clientY);
    document.addEventListener("mousemove", this.moveHandler);
  },

  update(y) {
    if (this.elements.length < 4) return;
    const half = this.windowHeight / 2;
    const top = Math.max(0, y - half);
    const bottom = y + half;
    const vh = window.innerHeight;

    this.elements[0].style.height = `${top}px`; // 上遮罩
    this.elements[1].style.top = `${bottom}px`; // 下遮罩
    this.elements[1].style.height = `${Math.max(0, vh - bottom)}px`;
    this.elements[2].style.top = `${top}px`; // 窗口上沿参考线
    this.elements[3].style.top = `${bottom}px`; // 窗口下沿参考线
  },

  destroy() {
    this.elements.forEach((el) => el.remove());
    this.elements = [];
    this.enabled = false;
    if (this.moveHandler) {
      document.removeEventListener("mousemove", this.moveHandler);
      this.moveHandler = null;
    }
  },
};

// 文字排版增强：放大字号、加宽行距与字距，提升整页文字可读性（纯 CSS，不影响页面逻辑）
const Typography = {
  styleId: `${PREFIX}-typo-style`,
  class: `${PREFIX}-typo`,

  apply() {
    document.documentElement.classList.add(this.class);
    if (document.getElementById(this.styleId)) return;

    const style = document.createElement("style");
    style.id = this.styleId;
    style.textContent = `
      html.${this.class} { font-size: 112% !important; }
      html.${this.class} p, html.${this.class} li, html.${this.class} td,
      html.${this.class} dd, html.${this.class} blockquote,
      html.${this.class} article, html.${this.class} section,
      html.${this.class} h1, html.${this.class} h2, html.${this.class} h3,
      html.${this.class} h4, html.${this.class} h5, html.${this.class} h6 {
        line-height: 1.8 !important;
        letter-spacing: 0.03em !important;
        word-spacing: 0.08em !important;
      }
    `;
    document.documentElement.appendChild(style);
  },

  remove() {
    document.documentElement.classList.remove(this.class);
    const style = document.getElementById(this.styleId);
    if (style) style.remove();
  },
};

// 大光标与点击反馈：放大鼠标指针 + 点击涟漪 + 轻微拖尾，解决"找不到鼠标"
const BigCursor = {
  styleId: `${PREFIX}-cursor-style`,
  class: `${PREFIX}-bigcursor`,
  active: false,
  cursorUrl: null,
  trailEls: [],
  lastTrail: 0,

  // 用 canvas 现画一个 48px 的大箭头（白填充 + 黑描边），任何背景上都醒目
  buildCursor() {
    if (this.cursorUrl) return this.cursorUrl;
    const size = 48;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.beginPath();
    ctx.moveTo(6, 2);
    ctx.lineTo(6, 38);
    ctx.lineTo(15, 29);
    ctx.lineTo(22, 44);
    ctx.lineTo(29, 41);
    ctx.lineTo(22, 26);
    ctx.lineTo(34, 26);
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.fill();
    ctx.stroke();
    this.cursorUrl = canvas.toDataURL("image/png");
    return this.cursorUrl;
  },

  create() {
    if (this.active) return;
    this.active = true;

    const url = this.buildCursor();
    const style = document.createElement("style");
    style.id = this.styleId;
    style.textContent = `
      html.${this.class}, html.${this.class} * {
        cursor: url("${url}") 6 2, auto !important;
      }
    `;
    document.documentElement.appendChild(style);
    document.documentElement.classList.add(this.class);

    this.clickHandler = (e) => this.ripple(e.clientX, e.clientY);
    this.moveHandler = (e) => this.trail(e.clientX, e.clientY);
    document.addEventListener("pointerdown", this.clickHandler, true);
    document.addEventListener("mousemove", this.moveHandler);
  },

  // 点击涟漪：以点击点为圆心扩散的粉色圆环
  ripple(x, y) {
    const el = document.createElement("div");
    el.className = `${PREFIX}-ripple`;
    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: 14px;
      height: 14px;
      margin: -7px 0 0 -7px;
      border: 3px solid #ff4081;
      border-radius: 50%;
      pointer-events: none;
      z-index: 2147483647;
      transition: transform 0.45s ease-out, opacity 0.45s ease-out;
    `;
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.style.transform = "scale(4)";
      el.style.opacity = "0";
    });
    setTimeout(() => el.remove(), 500);
  },

  // 鼠标拖尾：淡出的青色小圆点（限流，最多保留 12 个）
  trail(x, y) {
    const now = Date.now();
    if (now - this.lastTrail < 60) return;
    this.lastTrail = now;

    const dot = document.createElement("div");
    dot.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: 8px;
      height: 8px;
      margin: -4px 0 0 -4px;
      border-radius: 50%;
      background: #00e5ff;
      opacity: 0.55;
      pointer-events: none;
      z-index: 2147483645;
      transition: opacity 0.5s ease-out, transform 0.5s ease-out;
    `;
    document.body.appendChild(dot);
    this.trailEls.push(dot);

    requestAnimationFrame(() => {
      dot.style.opacity = "0";
      dot.style.transform = "scale(0.4)";
    });
    setTimeout(() => {
      dot.remove();
      this.trailEls = this.trailEls.filter((d) => d !== dot);
    }, 550);

    if (this.trailEls.length > 12) {
      const oldest = this.trailEls.shift();
      oldest.remove();
    }
  },

  destroy() {
    this.active = false;
    document.documentElement.classList.remove(this.class);
    const style = document.getElementById(this.styleId);
    if (style) style.remove();

    if (this.clickHandler) {
      document.removeEventListener("pointerdown", this.clickHandler, true);
      this.clickHandler = null;
    }
    if (this.moveHandler) {
      document.removeEventListener("mousemove", this.moveHandler);
      this.moveHandler = null;
    }

    this.trailEls.forEach((d) => d.remove());
    this.trailEls = [];
    document
      .querySelectorAll(`.${PREFIX}-ripple`)
      .forEach((r) => r.remove());
  },
};

const Crosshair = {
  elements: [],

  create() {
    if (this.elements.length > 0) return;

    const lineStyle = `
      position: fixed;
      background: #00FFFF;
      box-shadow: 0 0 4px #00FFFF, 0 0 8px rgba(0,255,255,0.6);
      z-index: 2147483646;
      pointer-events: none;
    `;

    const vLine = document.createElement("div");
    vLine.style.cssText =
      lineStyle + "width: 2px; height: 100vh; top: 0; left: 0;";

    const hLine = document.createElement("div");
    hLine.style.cssText =
      lineStyle + "width: 100vw; height: 2px; top: 0; left: 0;";

    const ring = document.createElement("div");
    ring.style.cssText = `
      position: fixed;
      width: 8px;
      height: 8px;
      border: 2px solid #00FFFF;
      border-radius: 50%;
      box-shadow: 0 0 4px #00FFFF;
      z-index: 2147483646;
      pointer-events: none;
      top: 0;
      left: 0;
    `;

    this.elements = [vLine, hLine, ring];
    this.elements.forEach((el) => document.body.appendChild(el));

    this.moveHandler = (e) => this.update(e.clientX, e.clientY);
    document.addEventListener("mousemove", this.moveHandler);
  },

  update(x, y) {
    if (this.elements.length < 3) return;
    this.elements[0].style.left = `${x}px`;
    this.elements[1].style.top = `${y}px`;
    this.elements[2].style.left = `${x - 4}px`;
    this.elements[2].style.top = `${y - 4}px`;
  },

  destroy() {
    this.elements.forEach((el) => el.remove());
    this.elements = [];
    if (this.moveHandler) {
      document.removeEventListener("mousemove", this.moveHandler);
      this.moveHandler = null;
    }
  },
};

const ColorBlindness = {
  svgId: `${PREFIX}-cb-filters`,

  injectSVG() {
    if (document.getElementById(this.svgId)) return;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = this.svgId;
    svg.style.cssText = "position:absolute;width:0;height:0;";

    for (const [mode, values] of Object.entries(CB_MATRICES)) {
      const filter = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "filter",
      );
      filter.id = `${PREFIX}-${mode}`;

      const feColorMatrix = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "feColorMatrix",
      );
      feColorMatrix.setAttribute("type", "matrix");
      feColorMatrix.setAttribute("values", values);
      filter.appendChild(feColorMatrix);

      svg.appendChild(filter);
    }

    document.documentElement.appendChild(svg);
  },

  apply(mode) {
    if (mode === "off") {
      this.remove();
      return;
    }
    this.injectSVG();
    document.documentElement.style.filter = `url(#${PREFIX}-${mode})`;
  },

  remove() {
    document.documentElement.style.filter = "";
  },
};

function applyFeatures(features) {
  if (features.aiDescription) {
    AIDescription.enable();
  } else {
    AIDescription.disable();
  }

  if (features.imageDescribe) {
    ImageDescriber.enable();
  } else {
    ImageDescriber.disable();
  }

  if (features.textReader) {
    TextReader.enable();
  } else {
    TextReader.disable();
  }

  if (features.crosshair) {
    Crosshair.create();
  } else {
    Crosshair.destroy();
  }

  if (features.readingGuide) {
    ReadingGuide.create();
  } else {
    ReadingGuide.destroy();
  }

  if (features.typography) {
    Typography.apply();
  } else {
    Typography.remove();
  }

  if (features.bigCursor) {
    BigCursor.create();
  } else {
    BigCursor.destroy();
  }

  ColorBlindness.apply(features.colorBlindMode);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "TOGGLE_FEATURE":
      if (msg.feature === "aiDescription") {
        msg.enabled ? AIDescription.enable() : AIDescription.disable();
      } else if (msg.feature === "imageDescribe") {
        msg.enabled ? ImageDescriber.enable() : ImageDescriber.disable();
      } else if (msg.feature === "textReader") {
        msg.enabled ? TextReader.enable() : TextReader.disable();
      } else if (msg.feature === "crosshair") {
        msg.enabled ? Crosshair.create() : Crosshair.destroy();
      } else if (msg.feature === "readingGuide") {
        msg.enabled ? ReadingGuide.create() : ReadingGuide.destroy();
      } else if (msg.feature === "typography") {
        msg.enabled ? Typography.apply() : Typography.remove();
      } else if (msg.feature === "bigCursor") {
        msg.enabled ? BigCursor.create() : BigCursor.destroy();
      }
      break;

    case "SET_CB_MODE":
      ColorBlindness.apply(msg.mode);
      break;

    case "SCAN_NOW":
      AIDescription.describePage();
      break;

    case "SET_READING_RATE":
      TextReader.rate = msg.rate;
      break;

    case "INIT_FEATURES":
      applyFeatures(msg.features);
      break;
  }
});

async function init() {
  const state = await getState();
  TextReader.rate = state.readingRate || 0.9;
  applyFeatures(state.features);
}

init();
