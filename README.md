# pi-live-preview

[pi](https://pi.dev) 扩展：把当前会话渲染成一个排版良好的 HTML 页面，用浏览器阅读。

终端里读数学公式一直很痛苦——`$...$` 会被原样打印，`*`、`_` 还会被 Markdown 吃掉。这个扩展把会话（正文、思考过程、工具调用与结果）渲染成一篇独立的 HTML 文档，公式交给 KaTeX 排版，代码块带语法高亮，终端里的 ANSI 颜色也会被还原。

提供两种用法：

- **静态快照**（`/preview`）：把当前会话导出成一个自包含 HTML 并打开，零常驻资源。
- **实时镜像**（`/live`）：起一个本地服务，用 SSE 把会话增量推送到浏览器页面，可以边生成边看，还可以（手动解锁后）直接在页面里发消息。

## 功能

| 能力 | 说明 |
| --- | --- |
| 公式排版 | KaTeX 渲染 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`，含矩阵、多行公式 |
| 公式保护 | 先把公式换成占位符再交给 Markdown，`$a*b*c$`、`$x_i$` 不会被强调符破坏；正文里的正则、代码片段不会被误判成公式 |
| 内容还原 | 正文、思考过程（折叠）、工具调用参数、工具结果（含 diff 着色）、模型切换记录 |
| 代码块 | highlight.js 语法高亮，配色对齐 pi 的 dark 主题 |
| 终端颜色 | 工具输出里的 ANSI 转义（16 色 / 256 色 / 真彩色 / 粗体等）会被还原成 HTML |
| 中文字体 | 浏览器字体栈，无需任何字体配置 |
| 目录导航 | 左侧可拖拽宽度的会话目录，拖到很窄会自动收起，跳转定位准确 |
| 深色主题 | 卡片、表格（白边框）、引用、公式配色与终端阅读习惯一致 |

## 安装

### 从 GitHub（推荐）

```bash
pi install git:github.com/Mosky-G/pi-live-preview
```

或使用完整 URL：

```bash
pi install https://github.com/Mosky-G/pi-live-preview
```

pi 会把仓库克隆到 `~/.pi/agent/git/...` 并自动执行 `npm install`（KaTeX 依赖）。

### 本地目录（开发用）

```bash
git clone https://github.com/Mosky-G/pi-live-preview.git ~/pi-live-preview
cd ~/pi-live-preview && npm install
```

然后在 `~/.pi/agent/settings.json` 里把这个目录加进 `extensions`：

```json
{
  "extensions": ["C:/Users/you/pi-live-preview"]
}
```

> 注意：不要在 `~/.pi/agent/extensions/` 里再放一份同名扩展，否则命令会重复注册（pi 会把后来的改成 `/live:1`）。

## 使用

```
/preview                 # 静态快照：渲染整个会话并打开浏览器
/preview 10              # 只渲染最近 10 轮
/preview --keep 50       # 最多保留 50 个历史页面（默认 30）
```

```
/live                    # 启动实时镜像并打开页面
/live open               # 重新打开页面（不重启服务、地址不变）
/live input              # 解锁页面输入（默认锁定）
/live lock               # 重新锁定页面输入
/live status             # 查看地址 / 连接数 / 输入状态
/live off                # 停止服务并释放端口
```

两个命令都支持参数补全。

实时页面底部的输入条：`Enter` 发送，`Shift` / `Ctrl` / `Alt` + `Enter` 换行，`Esc` 清空；上缘可拖动调整高度（38px 到 60vh，会自动记住）。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `PI_PREVIEW_NO_OPEN=1` | 不自动打开浏览器，只输出地址 |

### 输出位置

- 静态页面：`~/.pi/agent/math-preview/*.html`（自动只保留最近 30 个，只删自己生成的文件）
- 浏览器端资源缓存：`~/.pi/agent/math-preview/assets/`

## 实时模式的安全设计

`/live` 会在本机起一个 HTTP 服务，因此按最小暴露面设计：

- **随机端口**：`listen(0)` 由系统分配，不占用固定端口，不会和你本地测试用的服务冲突
- **仅监听 `127.0.0.1`**，不暴露到局域网，不需要管理员权限
- **访问令牌**：每次启动生成随机 token，写在页面 URL 里，服务端逐个校验
- **防 CSRF / DNS rebinding**：校验 `Host` 白名单、`Origin` 白名单、`Sec-Fetch-Site`
- **输入默认锁定**：`POST /prompt` 在锁定状态下直接 403，页面输入框也是禁用状态，必须在终端执行 `/live input` 才解锁；`/live lock`、`/live off`、退出 pi 都会立即恢复锁定
- **请求限制**：只接受 JSON、请求体上限 64 KB、静态资源路径防目录穿越
- 服务随 pi 退出自动关闭（`session_shutdown`），端口随之释放

页面地址里含 token，**不要把这个 URL 分享或截图给别人**——拿到它就能往你的会话里发消息。

## 依赖与致谢

- [KaTeX](https://katex.org/)（MIT）——公式排版
- `vendor/marked.min.js`：Markdown 解析，取自 pi 自带的 `@earendil-works/pi-coding-agent`（MIT）
- `vendor/highlight.min.js`：代码高亮，同上（BSD-3-Clause，highlight.js）
- `vendor/ansi-to-html.js`：ANSI → HTML，移植自 pi 的实现（MIT），配色改为 Windows Terminal 的 Campbell 调色板

## 已知限制

- 本扩展的界面在**浏览器**里，终端内不显示公式（终端图形协议支持有限）
- 实时页面的"重新打开"是打开同一地址的新标签页——浏览器没有跨标签聚焦的通用接口

## 许可证

MIT，见 [LICENSE](LICENSE)。
