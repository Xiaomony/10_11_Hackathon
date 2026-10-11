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
    danmakuSummary: false,
  },
  readingRate: 0.9,
};

const CB_MATRICES = {
  protanopia: "0.567 0.433 0 0 0 0.558 0.442 0 0 0 0 0.242 0.758 0 0 0 0 0 1 0",
  deuteranomaly: "0.8 0.2 0 0 0 0.258 0.742 0 0 0 0 0.142 0.858 0 0 0 0 0 1 0",
  tritanopia: "0.95 0.05 0 0 0 0 0.433 0.567 0 0 0 0.475 0.525 0 0 0 0 0 1 0",
};

async function getState() {
  const result = await chrome.storage.local.get('eyebuddyState');
  return result.eyebuddyState || DEFAULT_STATE;
}

/**
 * A11yTree：把渲染后的 DOM 压缩成"无障碍树"文本。
 * - 只保留可见、有语义的元素（标题/链接/按钮/输入框/图片/媒体/页面分区/正文）
 * - 每个入树元素分配数字 ref，并登记到 registry —— 供后续 AI Agent 按编号操作页面
 * - 输出面向大模型的精简文本（缩进表示层级），带字符预算，避免超 token
 */
const A11yTree = {
  registry: new Map(),
  version: 0,
  MAX_CHARS: 12000,
  MAX_DEPTH: 24,

  /**
   * 抓取当前页面快照：{ version, text, count, truncated }
   * walk 只负责收集有序条目，渲染时才按阅读顺序分配 ref，
   * 保证编号从上到下单调递增，便于 AI 与后续 Agent 引用。
   */
  capture() {
    this.registry.clear();
    this.version += 1;

    const entries = [];
    this.walk(document.body, 0, entries);

    const lines = [];
    let refSeq = 0;
    let chars = 0;
    let truncated = false;

    for (const item of entries) {
      let line;
      if (item.el) {
        const ref = ++refSeq;
        this.registry.set(ref, item.el);
        line = `${'  '.repeat(item.depth)}[${ref}] ${item.label}`;
        if (item.extra) line += ` ${item.extra}`;
        if (item.name) line += `: ${this.truncate(item.name, 120)}`;
      } else {
        line = `${'  '.repeat(item.depth)}${this.truncate(item.text, 200)}`;
      }

      chars += line.length;
      if (chars > this.MAX_CHARS) {
        truncated = true;
        break;
      }
      lines.push(line);
    }

    let text =
      `页面标题: ${document.title || '(无标题)'}\n` +
      `URL: ${location.href}\n` +
      `页面结构（[编号]用于引用元素，缩进表示层级）:\n` +
      lines.join('\n');

    if (truncated) {
      text += '\n...(页面过长，仅展示前半部分)';
    }

    return {
      version: this.version,
      text,
      count: refSeq,
      truncated
    };
  },

  getElement(ref) {
    return this.registry.get(Number(ref)) || null;
  },

  // ---------- 内部实现 ----------

  SKIP_TAGS: new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META',
    'HEAD', 'TITLE', 'BR', 'HR', 'SVG', 'PATH', 'OPTGROUP'
  ]),

  // 叶子角色：名称已聚合内部文本，不再向下展开，避免重复
  LEAF_ROLES: new Set([
    'button', 'link', 'heading', 'img', 'textbox', 'checkbox', 'radio',
    'switch', 'tab', 'menuitem', 'option', 'slider', 'combobox',
    'video', 'audio', 'canvas'
  ]),

  ARIA_ROLES: new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
    'listbox', 'option', 'heading', 'list', 'listitem', 'img',
    'navigation', 'main', 'banner', 'contentinfo', 'complementary',
    'region', 'tab', 'tablist', 'menuitem', 'menu', 'slider',
    'switch', 'search', 'dialog', 'toolbar', 'table', 'row', 'cell',
    'columnheader', 'rowheader', 'group', 'article', 'form', 'alert'
  ]),

  isVisible(el) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    if (typeof el.checkVisibility === 'function') {
      try {
        return el.checkVisibility();
      } catch (e) { /* 回退到几何判断 */ }
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  },

  isOwnUI(el) {
    return typeof el.closest === 'function' &&
      Boolean(el.closest(`[class^="${PREFIX}-"]`));
  },

  cleanText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  },

  truncate(s, n) {
    return s.length > n ? s.slice(0, n) + '…' : s;
  },

  /** 计算元素的无障碍名称 */
  accessibleName(el) {
    const labelledby = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledby) {
      const parts = labelledby.split(/\s+/).map((id) => {
        const node = document.getElementById(id);
        return node ? this.cleanText(node.innerText) : '';
      }).filter(Boolean);
      if (parts.length) return this.truncate(parts.join(' '), 120);
    }

    const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
    if (ariaLabel) return this.truncate(this.cleanText(ariaLabel), 120);

    const tag = el.tagName;
    if (tag === 'IMG') return this.truncate(this.cleanText(el.alt || el.title), 120);
    if (tag === 'AREA') return this.truncate(this.cleanText(el.alt), 120);
    if (tag === 'INPUT') {
      // placeholder 已作为"提示"单独展示，这里只取关联 label / title，避免重复
      const labelText = el.labels && el.labels[0] ? el.labels[0].innerText : '';
      return this.truncate(this.cleanText(labelText || el.title), 120);
    }
    if (tag === 'SELECT') {
      const selected = el.selectedOptions && el.selectedOptions[0];
      return this.truncate(this.cleanText(
        selected ? selected.textContent : el.value
      ), 120);
    }
    if (tag === 'VIDEO' || tag === 'AUDIO') {
      return this.truncate(this.cleanText(el.title), 120);
    }
    return this.truncate(this.cleanText(el.innerText || el.textContent), 120);
  },

  /** 由标签/ARIA 推断语义角色，返回 { role, level } 或 null */
  resolveRole(el) {
    const ariaRole = el.getAttribute && el.getAttribute('role');
    if (ariaRole) {
      const role = ariaRole.split(/\s+/)[0];
      if (this.ARIA_ROLES.has(role)) {
        const level = el.getAttribute('aria-level');
        return { role, level: level ? Number(level) : null };
      }
    }

    switch (el.tagName) {
      case 'A': return { role: 'link' };
      case 'BUTTON':
      case 'SUMMARY':
        return { role: 'button' };
      case 'H1': return { role: 'heading', level: 1 };
      case 'H2': return { role: 'heading', level: 2 };
      case 'H3': return { role: 'heading', level: 3 };
      case 'H4': return { role: 'heading', level: 4 };
      case 'H5': return { role: 'heading', level: 5 };
      case 'H6': return { role: 'heading', level: 6 };
      case 'NAV': return { role: 'navigation' };
      case 'MAIN': return { role: 'main' };
      case 'HEADER': return { role: 'banner' };
      case 'FOOTER': return { role: 'contentinfo' };
      case 'ASIDE': return { role: 'complementary' };
      case 'ARTICLE': return { role: 'article' };
      case 'FORM':
        return el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')
          ? { role: 'form' } : null;
      case 'SECTION':
        return el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')
          ? { role: 'region' } : null;
      case 'UL':
      case 'OL':
        return { role: 'list' };
      case 'LI': return { role: 'listitem' };
      case 'IMG': return { role: 'img' };
      case 'CANVAS': return { role: 'canvas' };
      case 'VIDEO': return { role: 'video' };
      case 'AUDIO': return { role: 'audio' };
      case 'TABLE': return { role: 'table' };
      case 'TR': return { role: 'row' };
      case 'TH': return { role: 'columnheader' };
      case 'TD': return { role: 'cell' };
      case 'SELECT': return { role: 'combobox' };
      case 'TEXTAREA': return { role: 'textbox' };
      case 'INPUT': {
        const t = (el.type || 'text').toLowerCase();
        if (['hidden', 'reset'].includes(t)) return null;
        if (t === 'checkbox') return { role: 'checkbox' };
        if (t === 'radio') return { role: 'radio' };
        if (['submit', 'button', 'image'].includes(t)) return { role: 'button' };
        if (t === 'range') return { role: 'slider' };
        return { role: 'textbox', inputType: t };
      }
      default:
        // 带 tabindex 的可交互元素（组件库常把 div 做成按钮）
        if (el.tabIndex >= 0) return { role: 'button', guessed: true };
        return null;
    }
  },

  /** 节点直接包含的文本（不含子元素） */
  ownDirectText(el) {
    let t = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) t += node.textContent;
    }
    return this.cleanText(t);
  },

  /** 收集一个元素条目（ref 在最终渲染时才统一分配） */
  pushEntry(sink, depth, label, el, name, extra) {
    sink.push({ el, depth, label, name: name || '', extra: extra || '' });
  },

  /** 收集一个纯文本条目 */
  pushText(sink, depth, text) {
    if (text.length < 2) return;
    sink.push({ depth, text });
  },

  buildExtra(role, el, roleInfo) {
    const flags = [];
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      flags.push(el.checked ? '[已选中]' : '[未选中]');
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
      flags.push('[禁用]');
    }
    if (el.getAttribute('aria-expanded') === 'true') flags.push('[已展开]');
    if (el.getAttribute('aria-expanded') === 'false') flags.push('[已折叠]');
    if (role === 'textbox' && el.placeholder) {
      flags.push(`提示="${this.truncate(this.cleanText(el.placeholder), 40)}"`);
    }
    if (role === 'link' && el.href) {
      try {
        const u = new URL(el.href);
        flags.push('-> ' + (u.pathname === '/' ? '/' : u.pathname + u.search).slice(0, 80));
      } catch (e) { /* 忽略异常 URL */ }
    }
    if (roleInfo && roleInfo.guessed) flags.push('[可点击]');
    return flags.join(' ');
  },

  /**
   * 递归遍历，收集"父先于子"的先序条目到 sink；
   * 返回该子树是否产出了内容。
   */
  walk(el, depth, sink) {
    if (depth > this.MAX_DEPTH) return false;
    if (el.nodeType !== Node.ELEMENT_NODE) return false;
    if (this.SKIP_TAGS.has(el.tagName)) return false;
    if (this.isOwnUI(el)) return false;
    if (!this.isVisible(el)) return false;

    // iframe / plugin：跨域无法进入，作为占位元素提示
    if (el.tagName === 'IFRAME' || el.tagName === 'OBJECT') {
      this.pushEntry(sink, depth, el.tagName === 'IFRAME' ? 'iframe' : 'plugin', el,
        this.accessibleName(el), el.src ? `src="${el.src.slice(0, 80)}"` : '');
      return true;
    }

    const roleInfo = this.resolveRole(el);
    const role = roleInfo ? roleInfo.role : null;

    // ---------- 叶子语义元素：名称聚合自身文本，不向下展开 ----------
    if (role && this.LEAF_ROLES.has(role)) {
      let name = this.accessibleName(el);

      // 链接/按钮常嵌套图片图标：innerText 拿不到 img alt，这里补全
      if (!name && (role === 'link' || role === 'button')) {
        const parts = [];
        el.querySelectorAll?.('img[alt], [aria-label]').forEach((n) => {
          parts.push(n.getAttribute('alt') || n.getAttribute('aria-label') || '');
        });
        name = this.truncate(this.cleanText(parts.join(' ')), 120);
      }

      // 空标题是纯噪声，直接丢弃（空按钮/输入框等控件仍保留）
      if (role === 'heading' && !name) return false;

      const label = role === 'heading'
        ? `heading(${roleInfo.level || 2})`
        : role;
      this.pushEntry(sink, depth, label, el,
        name, this.buildExtra(role, el, roleInfo));
      return true;
    }

    // 先递归收集子树（语义容器增加缩进，无语义包裹层不增加层级）
    const childSink = [];
    const childDepth = role ? depth + 1 : depth;
    let hasChild = false;
    for (const child of el.children) {
      if (this.walk(child, childDepth, childSink)) hasChild = true;
    }

    // ---------- 无语义元素：包裹层透传，仅保留文本 ----------
    if (!role) {
      if (hasChild) {
        const ownText = this.ownDirectText(el);
        if (ownText.length >= 2) this.pushText(sink, depth, ownText);
        sink.push(...childSink);
        return true;
      }
      const fullText = this.cleanText(el.innerText || el.textContent);
      if (fullText.length >= 2) {
        this.pushText(sink, depth, fullText);
        return true;
      }
      return false;
    }

    // ---------- 容器语义元素（nav/main/list/table 等） ----------
    // 优先 aria 名称；没有子元素时才聚合自身文本，避免与子元素文本重复
    const ariaName = this.cleanText(el.getAttribute('aria-label') || '');
    if (!hasChild && !ariaName) return false;

    const name = ariaName || (hasChild ? '' : this.accessibleName(el));
    this.pushEntry(sink, depth, role, el,
      name, this.buildExtra(role, el, roleInfo));
    sink.push(...childSink);
    return true;
  }
};

/**
 * AgentActions：AI 操作页面的执行层（第二个功能的预留接口）。
 * ref 来自最近一次 A11yTree.capture() 的注册表；
 * SPA 页面变化后旧 ref 会失效，Agent 每步执行前应重新 GET_SNAPSHOT。
 */
const AgentActions = {
  async execute({ ref, action, value } = {}) {
    const el = A11yTree.getElement(ref);
    if (!el) {
      return { ok: false, error: '元素编号已失效，请重新获取页面快照' };
    }

    try {
      switch (action) {
        case 'click':
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          el.click();
          return { ok: true };

        case 'focus':
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          el.focus();
          return { ok: true };

        case 'type': {
          // 兼容 React/Vue：用原生 setter 赋值再派发 input/change
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          el.focus();
          const text = String(value ?? '');
          if (el.isContentEditable) {
            el.textContent = text;
          } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            const proto = el.tagName === 'TEXTAREA'
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(el, text);
          } else {
            return { ok: false, error: '该元素不支持输入' };
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true };
        }

        case 'scrollIntoView':
          el.scrollIntoView({
            block: 'center',
            behavior: 'instant'
          });
          return { ok: true };

        default:
          return { ok: false, error: `不支持的操作: ${action}` };
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
};

const AIDescription = {
  panel: null,

  enable() {},

  disable() {
    this.closePanel();
  },

  async describePage() {
    this.showLoading();

    try {
      // 优先走无障碍树文本解析（更快、更省 token）；
      // background 侧会在色盲模式或文本解析失败时自动回退到截图视觉模型
      const snapshot = A11yTree.capture();
      const response = await chrome.runtime.sendMessage({
        type: "DESCRIBE_PAGE",
        mode: "a11y",
        url: location.href,
        title: document.title,
        tree: snapshot.text,
        elementCount: snapshot.count,
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

  showLoading(text = "🔍 正在分析页面画面...") {
    this.closePanel();
    const panel = document.createElement("div");
    panel.className = `${PREFIX}-ai-panel`;
    panel.textContent = text;
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

  speak(text, el, onEnd) {
    if (!("speechSynthesis" in window)) {
      if (onEnd) onEnd();
      return;
    }

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
      if (onEnd) onEnd();
    };
    utterance.onerror = () => {
      if (this.highlightedEl === targetEl) this.clearHighlight();
      if (onEnd) onEnd();
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

const DanmakuSummary = {
  enabled: false,
  busy: false,
  autoTimer: null,
  urlWatcher: null,
  lastUrl: "",
  summarizedUrl: "",
  state: "idle",

  setState(s) {
    this.state = s;
    if (typeof DanmakuButton !== "undefined") DanmakuButton.update(s);
  },

  isBilibiliVideoPage() {
    return /^https?:\/\/www\.bilibili\.com\/video\/BV[\w]+/.test(
      location.href,
    );
  },

  extractVideoIds() {
    const bvid = location.pathname.match(/BV[\w]+/)?.[0] || "";
    const html = document.documentElement.innerHTML;
    const match = html.match(/"cid":(\d+)/);
    if (match) return { bvid, cid: parseInt(match[1]) };
    return null;
  },

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.lastUrl = location.href;
    this.scheduleAuto();
    this.urlWatcher = setInterval(() => this.checkUrlChange(), 1500);
  },

  disable() {
    this.enabled = false;
    clearTimeout(this.autoTimer);
    if (this.urlWatcher) {
      clearInterval(this.urlWatcher);
      this.urlWatcher = null;
    }
  },

  checkUrlChange() {
    if (location.href !== this.lastUrl) {
      this.lastUrl = location.href;
      this.scheduleAuto();
    }
  },

  scheduleAuto() {
    clearTimeout(this.autoTimer);
    if (!this.isBilibiliVideoPage()) return;
    if (location.href === this.summarizedUrl) return;
    this.autoTimer = setTimeout(() => {
      if (this.enabled && this.isBilibiliVideoPage()) this.run(true);
    }, 3000);
  },

  async run(isAuto = false) {
    if (this.busy) return;

    if (!this.isBilibiliVideoPage()) {
      AIDescription.showPanel("⚠️ 当前页面不是B站视频页", true);
      return;
    }

    const ids = this.extractVideoIds();
    if (!ids || !ids.cid) {
      AIDescription.showPanel("⚠️ 无法获取视频弹幕ID", true);
      return;
    }

    this.busy = true;
    this.setState("loading");
    AIDescription.showLoading("💬 正在抓取并总结弹幕...");

    try {
      const resp = await chrome.runtime.sendMessage({
        type: "FETCH_DANMAKU",
        bvid: ids.bvid,
        cid: ids.cid,
      });

      if (resp && resp.summary) {
        this.summarizedUrl = location.href;
        AIDescription.showPanel("💬 弹幕总结：" + resp.summary);
        this.setState("speaking");
        TextReader.speak(resp.summary, null, () => this.setState("idle"));
      } else if (resp && resp.error) {
        AIDescription.showPanel("⚠️ " + resp.error, true);
        this.setState("idle");
      } else {
        AIDescription.showPanel("⚠️ 弹幕总结失败", true);
        this.setState("idle");
      }
    } catch (e) {
      AIDescription.showPanel("⚠️ 弹幕总结失败", true);
      this.setState("idle");
    } finally {
      this.busy = false;
    }
  },
};

const DanmakuButton = {
  btn: null,
  state: "idle",

  ensure() {
    if (this.btn || !document.body) return;

    const btn = document.createElement("button");
    btn.id = `${PREFIX}-dm-btn`;
    btn.type = "button";
    btn.setAttribute("aria-label", "总结本视频弹幕并语音播报");
    btn.style.cssText = `
      position: fixed;
      right: 24px;
      top: 45%;
      z-index: 2147483645;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 10px 16px;
      border: none;
      border-radius: 22px;
      background: #fb7299;
      color: #fff;
      font-size: 14px;
      font-weight: 600;
      font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      box-shadow: 0 4px 16px rgba(251, 114, 153, 0.4);
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s, background 0.2s;
      pointer-events: auto;
    `;
    btn.innerHTML = `<span style="font-size:16px;line-height:1">💬</span><span class="${PREFIX}-dm-label">弹幕总结</span>`;

    btn.addEventListener("mouseenter", () => {
      if (this.state !== "idle") return;
      btn.style.transform = "scale(1.06)";
      btn.style.boxShadow = "0 6px 20px rgba(251, 114, 153, 0.55)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.transform = "";
      btn.style.boxShadow = "0 4px 16px rgba(251, 114, 153, 0.4)";
    });
    btn.addEventListener("click", () => {
      if (DanmakuSummary.busy) return;
      DanmakuSummary.run(false);
    });

    document.body.appendChild(btn);
    this.btn = btn;
    this.update(DanmakuSummary.state);
  },

  remove() {
    if (this.btn) {
      this.btn.remove();
      this.btn = null;
    }
  },

  update(state) {
    this.state = state;
    if (!this.btn) return;
    const label = this.btn.querySelector(`.${PREFIX}-dm-label`);
    if (!label) return;

    if (state === "loading") {
      label.textContent = "分析中…";
      this.btn.style.background = "#f4a7bc";
      this.btn.style.cursor = "wait";
    } else if (state === "speaking") {
      label.textContent = "播报中…";
      this.btn.style.background = "#fb7299";
      this.btn.style.cursor = "default";
    } else {
      label.textContent = "弹幕总结";
      this.btn.style.background = "#fb7299";
      this.btn.style.cursor = "pointer";
    }
  },

  syncVisibility() {
    if (DanmakuSummary.isBilibiliVideoPage()) {
      if (document.body) this.ensure();
      else
        document.addEventListener("DOMContentLoaded", () => this.ensure(), {
          once: true,
        });
    } else {
      this.remove();
    }
  },

  init() {
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        this.syncVisibility();
      }
    }, 1500);
    this.syncVisibility();
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

  if (features.danmakuSummary) {
    DanmakuSummary.enable();
  } else {
    DanmakuSummary.disable();
  }
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
      } else if (msg.feature === "danmakuSummary") {
        msg.enabled ? DanmakuSummary.enable() : DanmakuSummary.disable();
      }
      break;

    case "SET_CB_MODE":
      ColorBlindness.apply(msg.mode);
      break;

    case "SCAN_NOW":
      AIDescription.describePage();
      break;

    case "DANMAKU_SUMMARY_NOW":
      DanmakuSummary.run();
      break;

    // ---- AI Agent 预留接口：每步操作前取快照，按 ref 执行动作 ----
    case "GET_SNAPSHOT":
      // 同步返回，无需 return true
      sendResponse(A11yTree.capture());
      break;

    case "EXEC_ACTION":
      AgentActions.execute(msg.action).then(sendResponse);
      return true; // 异步响应

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
  DanmakuButton.init();
}

init();
