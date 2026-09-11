/**
 * 会话 entries / message → 可阅读 HTML 页面
 *
 * 只依赖 node 内置模块，方便脱离 pi 单独测试。
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));

/** 上下文用量 + 累计花费 */
export interface UsageSummary {
	contextTokens: number | null;
	contextWindow: number;
	contextPercent: number | null;
	cost: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	model: string;
}

export interface PreviewMeta {
	sessionId: string;
	sessionFile: string;
	cwd: string;
	generatedAt: string;
	totalItems: number;
	shownItems: number;
	/** 会话名称（用户通过 /name 设置过才有） */
	sessionName?: string;
	/** 上下文用量与累计花费 */
	usage?: UsageSummary;
	/** 当前活跃 goal（由 @narumitw/pi-goal 写入的 session entry 提供） */
	goal?: { text: string; status: string; iteration: number } | null;
}

/** 消息 content（string 或多模态数组）→ 纯文本 */
function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const out: string[] = [];
	for (const block of content as any[]) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text") out.push(String(block.text ?? ""));
		else if (block.type === "image") out.push("[图片]");
	}
	return out.join("\n\n");
}

/** 单条 AgentMessage → 展示项（静态与实时共用） */
export function messageToItem(m: any, time?: unknown): any | null {
	if (!m || typeof m !== "object") return null;
	const t = time ?? m.timestamp;
	switch (m.role) {
		case "user":
			return { kind: "user", time: t, text: contentToText(m.content) };
		case "assistant": {
			const text: string[] = [];
			const thinking: string[] = [];
			const tools: any[] = [];
			for (const b of Array.isArray(m.content) ? m.content : []) {
				if (b?.type === "text") text.push(String(b.text ?? ""));
				else if (b?.type === "thinking") thinking.push(String(b.thinking ?? ""));
				else if (b?.type === "toolCall") tools.push({ id: b.id, name: b.name, args: b.arguments ?? {} });
			}
			return {
				kind: "assistant",
				time: t,
				text: text.join("\n\n"),
				thinking: thinking.join("\n\n"),
				tools,
				model: m.model,
				provider: m.provider,
				stopReason: m.stopReason,
				error: m.errorMessage,
			};
		}
		case "toolResult":
			return {
				kind: "toolResult",
				time: t,
				toolName: m.toolName,
				toolCallId: m.toolCallId,
				text: contentToText(m.content),
				isError: !!m.isError,
				diff: typeof m.details?.diff === "string" ? m.details.diff : null,
			};
		case "bashExecution":
			return {
				kind: "bash",
				time: t,
				command: m.command,
				output: m.output,
				exitCode: m.exitCode,
				truncated: !!m.truncated,
			};
		case "custom":
			return { kind: "custom", time: t, customType: m.customType, text: contentToText(m.content) };
		case "branchSummary":
		case "compactionSummary":
			return { kind: "summary", time: t, label: m.role, text: String(m.summary ?? "") };
		default:
			return null;
	}
}

/** entry → 展示项（非 message 类型的 entry 走这里） */
export function entryToItem(e: any): any | null {
	if (!e || typeof e !== "object") return null;
	if (e.type === "message") return messageToItem(e.message, e.timestamp);
	if (e.type === "model_change") {
		return { kind: "note", time: e.timestamp, text: `模型切换 → ${e.provider ?? "?"}/${e.modelId ?? "?"}` };
	}
	if (e.type === "thinking_level_change") {
		return { kind: "note", time: e.timestamp, text: `思考等级 → ${e.thinkingLevel ?? "?"}` };
	}
	if (e.type === "compaction") {
		return { kind: "summary", time: e.timestamp, label: "compaction", text: String(e.summary ?? "") };
	}
	return null;
}

/** 把会话 entries 归一化成顺序的展示项 */
export function buildItems(entries: any[]): any[] {
	const items: any[] = [];
	for (const e of entries ?? []) {
		const item = entryToItem(e);
		if (item) items.push(item);
	}
	return items;
}

/** 从倒数第 rounds 个用户消息开始截取（rounds <= 0 表示全部） */
export function tailByRounds(items: any[], rounds: number): any[] {
	if (!Number.isFinite(rounds) || rounds <= 0) return items;
	let seen = 0;
	for (let i = items.length - 1; i >= 0; i--) {
		if (items[i].kind === "user") {
			seen++;
			if (seen >= rounds) return items.slice(i);
		}
	}
	return items;
}

function escapeForHtml(s: string): string {
	return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** 防止内联脚本里出现 </script 提前结束 */
function safeScript(js: string): string {
	return js.replace(/<\/script/gi, "<\\/script");
}

async function readViewerAssets(): Promise<{ viewerJs: string; viewerCss: string }> {
	const [viewerJs, viewerCss] = await Promise.all([
		readFile(join(EXT_DIR, "viewer.js"), "utf8"),
		readFile(join(EXT_DIR, "viewer.css"), "utf8"),
	]);
	return { viewerJs, viewerCss };
}

const COMMON_SCRIPTS = `<script src="assets/marked.min.js"></script>
<script src="assets/katex/katex.min.js"></script>
<script src="assets/highlight.min.js"></script>
<script src="assets/ansi-to-html.js"></script>`;

/** 生成静态页面（自包含，数据内嵌） */
export async function buildHtml(items: any[], meta: PreviewMeta): Promise<string> {
	const { viewerJs, viewerCss } = await readViewerAssets();
	const payload = JSON.stringify({ meta, items }).replace(/</g, "\\u003c");
	// 标签页名：有会话名用会话名，否则叫「新的对话」；加后缀区分静态快照
	const title = `${meta.sessionName || "新的对话"} · 快照`;
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeForHtml(title)}</title>
<link rel="stylesheet" href="assets/katex/katex.min.css">
<style>
${viewerCss}
</style>
</head>
<body>
<button id="side-toggle" type="button">«</button>
<div id="shell">
	<aside id="sidebar">
		<div class="side-head">会话预览<span class="dim" id="t-session"></span></div>
		<div class="side-goal" id="t-goal" hidden></div>
		<nav class="side-nav" id="toc"></nav>
		<div class="side-foot dim" id="t-meta"></div>
	</aside>
	<div id="side-resizer"></div>
	<section id="pane">
		<main id="content"></main>
	</section>
</div>
<script id="session-data" type="application/json">${payload}</script>
${COMMON_SCRIPTS}
<script>
${safeScript(viewerJs)}
</script>
</body>
</html>
`;
}

/** 生成实时页面（数据由 SSE 推送，带输入通道） */
export async function buildLiveHtml(meta: Partial<PreviewMeta>): Promise<string> {
	const { viewerJs, viewerCss } = await readViewerAssets();
	const liveJs = await readFile(join(EXT_DIR, "viewer-live.js"), "utf8");
	const title = meta.sessionName || "新的对话";
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeForHtml(title)}</title>
<link rel="stylesheet" href="assets/katex/katex.min.css">
<style>
${viewerCss}
</style>
</head>
<body>
<button id="side-toggle" type="button">«</button>
<div id="shell">
	<aside id="sidebar">
		<div class="side-head">实时预览<span class="dim" id="t-session"></span></div>
		<div class="side-goal" id="t-goal" hidden></div>
		<nav class="side-nav" id="toc"></nav>
		<div class="side-foot dim" id="t-meta"></div>
	</aside>
	<div id="side-resizer"></div>
	<section id="pane">
		<main id="content"></main>
		<div id="live-bar" class="locked">
			<div id="live-resizer"></div>
			<textarea id="live-input" rows="1" disabled placeholder="输入已在终端锁定：在 pi 里执行 /live input 解锁"></textarea>
			<button id="live-send" type="button" disabled>发送</button>
			<span id="live-status" class="live-status">连接中…</span>
		</div>
	</section>
</div>
${COMMON_SCRIPTS}
<script>window.__PI_LIVE_MODE__ = true;</script>
<script>
${safeScript(viewerJs)}
</script>
<script>
${safeScript(liveJs)}
</script>
</body>
</html>
`;
}
