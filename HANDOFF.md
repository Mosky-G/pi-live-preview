# 交接文档（HANDOFF）

给下一个 pi 会话看的开发笔记。**先读完本文件再动手改代码。**

## 1. 项目是什么

pi 扩展：把会话渲染成带公式排版的 HTML 页面，供浏览器阅读。两种用法：

- `/preview` —— 静态快照（自包含 HTML，零常驻资源）
- `/live` —— 实时镜像（本地随机端口 + SSE，可增量推送，带可解锁的输入通道）

- 仓库：`C:\Users\Mosky\pi-live-preview`（GitHub: `github.com/Mosky-G/pi-live-preview`）
- 本机通过 `~/.pi/agent/settings.json` 的 `extensions: ["C:/Users/Mosky/pi-live-preview"]` 加载
- 输出目录：`~/.pi/agent/math-preview/`（页面 + `assets/` 资源缓存）

## 2. 目录结构

```
pi-live-preview/
├── package.json                    # pi 清单：{"pi":{"extensions":["./extensions/math-preview/index.ts"]}}
├── extensions/math-preview/
│   ├── index.ts                    # 命令注册（/preview、/live）、事件桥接、全局状态
│   ├── render.ts                   # entries/message → 页面 HTML（内联 css+js）
│   ├── live-server.ts              # HTTP 服务 + SSE + 安全校验 + 静态资源
│   ├── fsutil.ts                   # 输出目录清理（PAGE_RE + 保留最近 N 个）
│   ├── viewer.js                   # 浏览器端：Markdown/KaTeX/高亮/ANSI/目录/交互
│   ├── viewer-live.js              # 浏览器端：SSE 客户端 + 输入条
│   ├── viewer.css                  # 全部样式
│   └── vendor/                     # marked.min.js / highlight.min.js / ansi-to-html.js
└── HANDOFF.md                      # 本文件
```

## 3. 已实现功能

| 功能 | 要点 |
|---|---|
| 公式排版 | KaTeX 渲染 `$...$`、`$$...$$`、`\(...\)`、`\[...\]` |
| 公式保护 | 先转占位符再交给 marked，避免 `*`/`_` 被吃；`looksLikeMath()` 过滤伪公式 |
| 内容 | 正文、思考过程（折叠）、工具调用参数、工具结果（diff 着色、ANSI 还原） |
| 代码高亮 | hljs，未标语言时 `highlightAuto`（≤20KB/400 行） |
| 目录 | 左侧栏，可拖宽（拖到 <110px 自动收起）、`«`/`»` 按钮、宽度与状态记忆 |
| 动画 | 收起/展开用 `document.startViewTransition`；卡片 `content-visibility:auto` 降低重排 |
| 会话切换 | `/tree`、`/fork`、`/clone`、`/new`、`/resume`、`/compact` → 广播 `reset` 重载页面 |
| 用量/花费 | `ctx.getContextUsage()` + 累加各 assistant 消息 `usage.cost.total`，显示在侧栏底部 |
| 当前 goal | 读 `@narumitw/pi-goal` 写入的 `custom/goal-state` 条目，显示在常驻底栏 |
| 时间 | 侧栏 `MM-DD HH:MM`，正文条目头 `YYYY-MM-DD HH:MM:SS` |
| 输入通道 | 默认锁定；终端 `/live input` 解锁；`/live lock`、`/live off` 立即恢复锁定 |
| 安全 | 随机端口 + 仅 127.0.0.1 + token + Host/Origin/Sec-Fetch-Site 校验 + 路径防穿越 |
| 补全 | `/live` 子命令、`/preview` 参数 |
| 环境变量 | `PI_PREVIEW_NO_OPEN=1` 时不自动打开浏览器 |

命令：

```
/preview [最近N轮|all] [--keep N]
/live | /live open | /live input | /live lock | /live off | /live status
```

## 4. 关键设计约束（改代码前务必知道）

1. **服务跨会话/reload 存活，状态必须放 `globalThis`**
   `liveState()` 返回挂在 `globalThis.__piLivePreviewState` 的共享对象（items、ctx、inputEnabled、
   pageHtmlImpl、snapshotImpl）。pi 在 `/fork`、`/new` 时会**销毁并重建扩展实例**，状态放实例里会丢。

2. **服务回调必须调用「全局实现」，不能捕获启动时的闭包**
   `live-server` 的 `pageHtml` / `getSnapshot` 都写成 `() => S.pageHtmlImpl?.()`。
   `installImplementations()` 在 **factory 加载时**调用，因此 `/reload` 后新实例立刻接管。
   ⚠️ 这是"reload 后页面看不到新字段（如 usage）"的根因，改回调时别退回旧写法。

3. **`/reload` 的生效范围**
   - `index.ts` / `render.ts` / `live-server.ts` → 需要 `/reload`
   - `viewer.js` / `viewer-live.js` / `viewer.css` → 每次请求页面时读取，**刷新页面即可**
   - **静态页面是快照**：改了 HTML 结构/样式后必须重新 `/preview`，光刷页面无效

4. **裸 Markdown 处理有三处易错**
   - 代码块 fence **必须在行首**（CommonMark 规则）。否则正文里的 ```lang 字面量会把
     后面一大段正文吞成"代码块"（曾导致"标题不换行、分点不解析"）
   - 正文里的 `<` 要转义成 `&lt;`，否则 `<script>` 之类会吞掉页面后续内容
   - `looksLikeMath()`：display 公式**允许跨行**（多行公式是标准写法）、长度上限更宽；
     行内公式正则本身不含换行。`|` 是数学里的取值/绝对值符号，**不能当 shell 管道排除**；
     需要排除的是 shell 变量对（含 `;`、引号）、文件扩展名、URL、`${...}`

5. **布局坑**
   - 侧栏曾是 grid + `display:none` 隐藏拖拽条 → 正文被自动放置到宽 0 的列（一行一个字）。
     现在用 flex + `width` 过渡（grid 列宽随 CSS 变量变化不能可靠过渡）
   - **父级 `opacity: 0` 会让整个子树透明**：收起侧栏时按钮曾因此"隐形但可点"，
     现在按钮放在 `#sidebar` 外面、`fixed` 定位跟随宽度
   - 深色主题下按钮/文字对比度要够（`#141414` 在 `#151b23` 上等于看不见）
   - **`scrollbar-width`/`scrollbar-color` 会让 Chromium 禁用 `::-webkit-scrollbar` 自定义**
     （退化成系统白色方块条）。标准属性只能用 `@supports not selector(::-webkit-scrollbar)` 给 Firefox

6. **pi 包清单只接受扩展入口文件**
   `"pi": {"extensions": ["./extensions"]}` 会报 `Cannot find module .../extensions`；
   必须写成 `./extensions/math-preview/index.ts`

## 5. 开发与验证流程

```bash
cd C:/Users/Mosky/pi-live-preview
# 改代码 → 语法检查
node --experimental-strip-types --check extensions/math-preview/index.ts
node --check extensions/math-preview/viewer.js
# 提交推送（不推送用户就不生效于其它设备；网络偶发失败，重试即可）
git add -A && git commit -m "..." && git push
```

**用 jiti 模拟 pi 加载扩展做端到端测试**（注意 alias，否则 `@earendil-works/pi-ai` 解析不到）：

```js
const PI = "C:/Users/Mosky/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(PI + "/node_modules/jiti/lib/jiti.mjs");
const jiti = createJiti(PI, { alias: { "@earendil-works/pi-ai": PI + "/node_modules/@earendil-works/pi-ai/dist/compat.js" } });
const mod = await jiti.import(EXT + "/index.ts");
mod.default({ registerCommand: (n, o) => (commands[n] = o), on: () => {}, sendUserMessage: () => {} });
await commands.preview.handler("", mockCtx);   // mockCtx 见下
```

验证渲染用无头 Chrome dump DOM + 像素分析：

```js
execFile("C:/Program Files/Google/Chrome/Application/chrome.exe",
  ["--headless=new","--disable-gpu","--virtual-time-budget=15000","--dump-dom","file:///"+page]);
// 像素分析可用全局装的 sharp：require("C:/Users/Mosky/AppData/Roaming/npm/node_modules/sharp")
```

测试脚本的坑（都踩过）：
- **`bash heredoc` 会吃掉反斜杠**（`\\rho` → `\r`），含 LaTeX/正则的测试脚本要用 `write` 工具写文件
- 测试页面必须生成到 **输出目录**（`~/.pi/agent/math-preview/`），否则 `assets/` 相对路径失效，页面空白
- headless 的虚拟时间下 **CSS transition 不推进**，测"终态"要临时 `transition: none`
- SSE 长连接会让 `--dump-dom` 挂住，测实时页要 stub `window.EventSource`
- 统计 DOM 时注意 `<script>` 里的源码字面量会污染正则结果

## 6. 环境信息

- 会话数据：`~/.pi/agent/sessions/<项目>/<时间戳>_<uuid>.jsonl`（JSONL，树结构 `id`/`parentId`）
- 凭据：`~/.pi/agent/auth.json`（`deepseek.key`），不要打印明文
- 输出目录与清理：`fsutil.ts` 的 `PAGE_RE` 只匹配 `<8位hex>-<时间戳>.html`，只删自己生成的文件
- 用户偏好：中文交流；改动要说明改了哪些文件；不确定就问，不要擅自做高风险操作

## 7. 已知待办 / 未来方向

- **翻译功能已实现后移除**（用户反馈使用中"难以避免的卡顿"）。历史在 git：
  `git revert ce49e5d 1cf6c14 73f5602` 可恢复（或 revert 移除提交）
  复盘出的卡顿原因：每 2 秒全量遍历并给 700+ 个块注入按钮；译文完成后整体重渲染（含 KaTeX）。
  若要重做：只在 hover/光标所在块注入按钮、译文用轻量渲染、流式节流放宽
- 长会话（700+ 条目）下的渲染与重排成本仍可优化
- 悬浮窗类 UI（曾计划用于翻译）未实现

## 8. 常用排查口诀

| 现象 | 先怀疑 |
|---|---|
| 页面样式/结构没变化 | 静态页没重新 `/preview`；或 `render.ts` 改了没 `/reload` |
| 某字段（usage/goal）有时不显示 | 服务回调没走 `S.xxxImpl`（见约束 2） |
| 正文从某处开始错乱 | 裸 HTML 标签没转义，或代码块 fence 不在行首 |
| 公式没渲染 | `looksLikeMath` 过滤过头（检查是否误排除换行/`|`） |
| 页面一片空白 | `assets/` 路径失效（页面不在输出目录）或某个脚本抛错 |
| 收起侧栏后正文极窄 | flex/grid 布局被改回了自动放置 |
