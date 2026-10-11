# 瞳伴 EyeBuddy · 无障碍浏览器插件

南科大无障碍公益黑客松作品。给视障/低视力用户的浏览器"眼睛"：AI 描述页面、悬停朗读图片和文字、十字准星、色盲校正、图片悬停描述。

---

## 🖱️ 怎么打开演示页面（选一种）

### 方式一：本地打开（推荐，最稳）

仓库已经下载到电脑上的话，用**文件资源管理器**进入仓库文件夹，**双击**对应的 `.html` 文件即可（会用默认浏览器打开），或把文件**拖进 Chrome 窗口**。

> 仓库位置（本机）：`C:\Users\James Yip\Documents\trae_projects\heikesong\10_13_Hackathon`

### 方式二：在线打开

如果仓库开启了 GitHub Pages，直接点下面的"在线打开"链接即可。

---

## 📄 演示页面一览

| 页面 | 用途 | 本地打开 | 在线打开 |
|---|---|---|---|
| 路演演示页 | 主舞台：三张图按演示顺序排好，配合插件完整走流程 | `eyebuddy\demo-page.html` 双击 | [demo-page.html](eyebuddy/demo-page.html) |
| 功能测试页 | 4 个用例逐一验证插件各分支 | `eyebuddy\test-page.html` 双击 | [test-page.html](eyebuddy/test-page.html) |
| 语音助手演示 | 输入/点麦克风"帮我打开bilibili"→ 真的打开 bilibili（仅演示） | `eyebuddy\voice-demo.html` 双击 | [voice-demo.html](eyebuddy/voice-demo.html) |
| 2 分钟逐字稿 | 台词、检查清单、翻车预案 | `eyebuddy\demo-script.md` | [demo-script.md](eyebuddy/demo-script.md) |

> 注意：`demo-page.html` 和 `test-page.html` 需要**先装好插件**才能看到完整效果（见下文）；`voice-demo.html` 单独打开就能玩。

---

## 🧩 插件安装（3 步）

1. Chrome 打开 `chrome://extensions`，右上角开启**开发者模式**
2. 点**加载已解压的扩展程序**，选择本仓库的 `eyebuddy\插件` 文件夹
3. 点浏览器右上角的瞳伴图标，按场景开启功能；想无 API Key 演示，进 ⚙️ 设置勾选**演示模式**

## 🎬 路演演示流程（120 秒）

1. 打开 `demo-page.html`，浏览器缩放 150%
2. 悬停第一张图（有 alt）→ 秒出描述 + 朗读
3. 悬停第二张图（无 alt）→ 转圈 1.5~2.5 秒 → AI 说出峡湾风光
4. 顺手展示色盲校正、十字准星（Ctrl+Shift+X）
5. 收尾词见 [demo-script.md](eyebuddy/demo-script.md)

## 📁 目录结构

```
10_13_Hackathon/
└── eyebuddy/
    ├── 插件/            # Chrome 插件本体（background / content_script / popup）
    ├── demo-images/     # 演示图片（本地化，断网可用）
    ├── demo-page.html   # 路演演示页
    ├── test-page.html   # 功能测试页
    ├── voice-demo.html  # 语音助手演示页
    └── demo-script.md   # 逐字稿与检查清单
```
