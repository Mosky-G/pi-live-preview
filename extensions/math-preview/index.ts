/**
 * pi 扩展：会话的公式友好预览
 *
 * 命令：
 * - /preview [N] [--keep K]  把会话渲染成静态 HTML 并打开浏览器（手动触发，无常驻资源）
 * - /live                    启动实时镜像（本地随机端口 + SSE，页面只读）
 * - /live open               重新打开实时页面（不重启服务、不换地址）
 * - /live input              解锁页面输入（能力开关，默认关闭，仅本次会话有效）
 * - /live lock               重新锁定页面输入
 * - /live off                停止实时服务并释放端口
 * - /live status             查看地址 / 连接数 / 输入状态
 *
 * 环境变量：PI_PREVIEW_NO_OPEN=1 时不自动打开浏览器（只输出地址）
 *
 * 会话切换（/new、/resume、/fork、/clone）、分支切换（/tree）、压缩（/compact）时，
 * 实时服务会保留，并把页面内容整体重载为当前分支（reset 事件）。
 */
import { execFile } from "node:child_process";
import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { cleanupPages, exists } from "./fsutil.ts";
import { startLiveServer, type LiveServerHandle } from "./live-server.ts";
import { buildHtml, buildItems, buildLiveHtml, messageToItem, tailByRounds, type UsageSummary } from "./render.ts";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 解析 agent 配置目录（默认 ~/.pi/agent）。
 * 优先从 PI_SESSION_FILE 的路径推断，这样改名发行版（非 .pi）也能工作。
 */
function resolveAgentDir(): string {
	const sessionFile = process.env.PI_SESSION_FILE ?? "";
	const m = /^(.*)[/\\]sessions[/\\]/.exec(sessionFile);
	if (m && m[1]) return m[1];
	return join(homedir(), ".pi", "agent");
}

const AGENT_DIR = resolveAgentDir();
const OUT_DIR = join(AGENT_DIR, "math-preview");
const ASSETS_DIR = join(OUT_DIR, "assets");
const DEFAULT_KEEP = 30;

/** katex 资源（相对 katex/dist 目录 → 输出目录相对路径） */
const KATEX_ASSETS: Array<[string, string]> = [
	["katex.min.js", "katex/katex.min.js"],
	["katex.min.css", "katex/katex.min.css"],
];

/** 随扩展一起分发的其他浏览器端资源（相对扩展目录） */
const VENDOR_ASSETS: Array<[string, string]> = [
	["vendor/marked.min.js", "marked.min.js"],
	["vendor/highlight.min.js", "highlight.min.js"],
	["vendor/ansi-to-html.js", "ansi-to-html.js"],
];

/**
 * 找 katex/dist 的位置：
 * - 本地扩展布局（~/.pi/agent/extensions/<name>/）→ node_modules 在同级
 * - pi 包布局（仓库根/ extensions/<name>/）→ node_modules 在包根，即上一级
 */
async function resolveKatexDist(): Promise<string> {
	for (const root of [EXT_DIR, dirname(EXT_DIR), dirname(dirname(EXT_DIR))]) {
		const candidate = join(root, "node_modules", "katex", "dist");
		if (await exists(join(candidate, "katex.min.js"))) return candidate;
	}
	throw new Error("未找到 katex 依赖，请在扩展目录或包根目录执行 npm install");
}

/** 源文件有变化（大小或时间戳）才复制，避免每次触发都白拷 */
async function copyIfChanged(from: string, to: string): Promise<void> {
	try {
		const [src, dst] = await Promise.all([stat(from), stat(to)]);
		if (src.size === dst.size && src.mtimeMs <= dst.mtimeMs) return;
	} catch {
		// 目标不存在，继续复制
	}
	await mkdir(dirname(to), { recursive: true });
	await cp(from, to);
}

/** 首次使用时把浏览器端依赖同步到输出目录 */
async function ensureAssets(): Promise<void> {
	const katexDist = await resolveKatexDist();
	for (const [from, to] of KATEX_ASSETS) {
		await copyIfChanged(join(katexDist, from), join(ASSETS_DIR, to));
	}
	for (const [from, to] of VENDOR_ASSETS) {
		await copyIfChanged(join(EXT_DIR, from), join(ASSETS_DIR, to));
	}
	const fonts = join(ASSETS_DIR, "katex", "fonts");
	if (!(await exists(fonts))) {
		await mkdir(fonts, { recursive: true });
		await cp(join(katexDist, "fonts"), fonts, { recursive: true });
	}
}

function timeStamp(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 取会话 id 前 8 位（扩展进程里读不到 PI_SESSION_ID，需要从 sessionManager / 会话文件名取） */
function sessionShortId(ctx: any): string {
	try {
		const id = ctx?.sessionManager?.getSessionId?.();
		if (typeof id === "string" && id) return id.replace(/[^0-9a-zA-Z]/g, "").slice(0, 8);
	} catch {
		// 忽略，走文件名校验
	}
	const file = process.env.PI_SESSION_FILE ?? ctx?.sessionManager?.getSessionFile?.() ?? "";
	const m = /_([0-9a-fA-F][0-9a-fA-F-]{30,})[^/\\]*\.jsonl$/.exec(String(file));
	if (m) return m[1].replace(/[^0-9a-zA-Z]/g, "").slice(0, 8);
	return "unknown";
}

/** 会话名称（用户通过 /name 设置过才有） */
function sessionNameOf(ctx: any): string {
	try {
		const name = ctx?.sessionManager?.getSessionName?.();
		return typeof name === "string" ? name : "";
	} catch {
		return "";
	}
}

/**
 * 读取当前活跃 goal。
 * @narumitw/pi-goal 把状态存在 session entry（custom / goal-state）里，
 * 取最后一条：不是活跃状态（完成/清除）就当作无目标 —— 与其官方实现一致。
 */
function goalInfo(entries: any[]): { text: string; status: string; iteration: number } | null {
	for (let i = (entries?.length ?? 0) - 1; i >= 0; i--) {
		const e = entries[i];
		if (e?.type !== "custom" || e.customType !== "goal-state") continue;
		const goal = e.data?.goal;
		if (goal && typeof goal.text === "string" && goal.status && goal.status !== "complete") {
			return { text: goal.text, status: String(goal.status), iteration: Number(goal.iteration) || 0 };
		}
		return null;
	}
	return null;
}

/** 上下文用量 + 累计花费（费用由每条 assistant 消息的 usage.cost 累加） */
function usageInfo(ctx: any, entries: any[]): UsageSummary {
	let cost = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let model = "";
	for (const e of entries ?? []) {
		const m = e?.message;
		if (!m || m.role !== "assistant") continue;
		const u = m.usage;
		if (u) {
			cost += Number(u.cost?.total) || 0;
			inputTokens += Number(u.input) || 0;
			outputTokens += Number(u.output) || 0;
			cacheReadTokens += Number(u.cacheRead) || 0;
			cacheWriteTokens += Number(u.cacheWrite) || 0;
		}
		if (typeof m.model === "string" && m.model) model = m.model;
	}
	let usage: any;
	try {
		usage = ctx?.getContextUsage?.();
	} catch {
		usage = undefined;
	}
	return {
		contextTokens: typeof usage?.tokens === "number" ? usage.tokens : null,
		contextWindow: Number(usage?.contextWindow) || 0,
		contextPercent: typeof usage?.percent === "number" ? usage.percent : null,
		cost,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		model,
	};
}

/** 保证页面文件名唯一：同一秒重复触发时追加 -1、-2 … */
async function uniquePagePath(base: string): Promise<string> {
	let path = join(OUT_DIR, `${base}.html`);
	let i = 1;
	while (await exists(path)) path = join(OUT_DIR, `${base}-${i++}.html`);
	return path;
}

function openInBrowser(target: string): void {
	if (process.env.PI_PREVIEW_NO_OPEN === "1") return;
	execFile("rundll32", ["url.dll,FileProtocolHandler", target], { windowsHide: true }, () => {});
}

function parseArgs(args: string): { rounds: number; keep: number } {
	let rounds = 0;
	let keep = DEFAULT_KEEP;
	const tokens = String(args ?? "").trim().split(/\s+/).filter(Boolean);
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok === "--keep" || tok === "-k") {
			keep = Number.parseInt(tokens[++i] ?? "", 10);
			if (!Number.isFinite(keep) || keep < 1) keep = DEFAULT_KEEP;
		} else if (tok === "all" || tok === "*") {
			rounds = 0;
		} else if (/^\d+$/.test(tok)) {
			rounds = Number.parseInt(tok, 10);
		}
	}
	return { rounds, keep };
}

/**
 * 实时服务的状态放在 globalThis 上：
 * 会话切换（/new、/resume、/fork）时 pi 会销毁并重建扩展实例，
 * 状态放在实例里会丢，服务也就随之失联。放全局后服务可以跨会话存活。
 */
interface LiveState {
	handle: LiveServerHandle | null;
	inputEnabled: boolean;
	items: any[];
	openIndex: number | null;
	indexByMessage: WeakMap<object, number>;
	pendingUpdate: { index: number; item: any } | null;
	flushTimer: ReturnType<typeof setTimeout> | null;
	/** 最近一次看到的会话上下文（事件/命令里持续更新） */
	ctx: any | null;
	/**
	 * 服务回调的实现，每个模块实例加载时都会重新安装（见 installImplementations）。
	 * 这样 /reload 后新实例立刻接管，不再用旧代码生成页面/快照。
	 */
	pageHtmlImpl: (() => string | Promise<string>) | null;
	snapshotImpl: (() => { items: unknown[]; meta: Record<string, unknown> }) | null;
}

const STATE_KEY = "__piLivePreviewState";

function liveState(): LiveState {
	const g = globalThis as any;
	if (!g[STATE_KEY]) {
		g[STATE_KEY] = {
			handle: null,
			inputEnabled: false,
			items: [],
			openIndex: null,
			indexByMessage: new WeakMap(),
			pendingUpdate: null,
			flushTimer: null,
			ctx: null,
			pageHtmlImpl: null,
			snapshotImpl: null,
		} satisfies LiveState;
	}
	return g[STATE_KEY] as LiveState;
}

/**
 * 用全局 ctx 安装「当前模块版本」的页面 HTML / 快照实现。
 * 必须在扩展工厂加载时调用：/reload 后新实例立即接管服务回调，
 * 否则服务会一直用启动时那个旧闭包（meta 里永远缺新加的字段）。
 */
function installImplementations(): void {
	const S = liveState();
	S.pageHtmlImpl = () => {
		const ctx = S.ctx;
		return buildLiveHtml({ sessionId: sessionShortId(ctx), sessionName: sessionNameOf(ctx), cwd: ctx?.cwd ?? "" });
	};
	S.snapshotImpl = () => {
		const ctx = S.ctx;
		const entries = ctx?.sessionManager?.getBranch?.() ?? [];
		return {
			items: S.items,
			meta: {
				sessionId: sessionShortId(ctx),
				sessionName: sessionNameOf(ctx),
				cwd: ctx?.cwd ?? "",
				usage: usageInfo(ctx, entries),
				goal: goalInfo(entries),
				generatedAt: new Date().toLocaleString(),
				totalItems: S.items.length,
			},
		};
	};
}

/** 更新全局 ctx（每个事件 / 命令处理器开头调一次，开销极小） */
function syncCtx(ctx: any): void {
	if (ctx) liveState().ctx = ctx;
}

/**
 * 用给定 ctx 重建页面内容并让前端整体重载（会话/分支变化时用）
 */
function reloadForContext(ctx: any, reason: string): void {
	const S = liveState();
	if (!S.handle) return;
	syncCtx(ctx);
	const entries = ctx?.sessionManager?.getBranch?.() ?? [];
	S.items = buildItems(entries);
	S.openIndex = null;
	S.indexByMessage = new WeakMap();
	S.pendingUpdate = null;
	S.handle.broadcast({
		type: "reset",
		reason,
		items: S.items,
		meta: {
			sessionId: sessionShortId(ctx),
			sessionName: sessionNameOf(ctx),
			cwd: ctx?.cwd ?? "",
			usage: usageInfo(ctx, entries),
			goal: goalInfo(entries),
			generatedAt: new Date().toLocaleString(),
			totalItems: S.items.length,
		},
	});
}

export default function mathPreview(pi: ExtensionAPI) {
	const S = liveState();
	// 模块实例一加载就安装实现：/reload 后新代码立即接管服务回调
	installImplementations();

	/** 把最新 meta（含上下文用量、花费、goal）推给页面 */
	function broadcastMeta(ctx: any): void {
		syncCtx(ctx);
		if (!S.handle) return;
		const entries = ctx?.sessionManager?.getBranch?.() ?? [];
		S.handle.broadcast({
			type: "meta",
			meta: {
				sessionId: sessionShortId(ctx),
				sessionName: sessionNameOf(ctx),
				cwd: ctx?.cwd ?? "",
				usage: usageInfo(ctx, entries),
				goal: goalInfo(entries),
				generatedAt: new Date().toLocaleString(),
				totalItems: S.items.length,
			},
		});
	}

	function flushPending(): void {
		S.flushTimer = null;
		if (!S.pendingUpdate || !S.handle) {
			S.pendingUpdate = null;
			return;
		}
		const { index, item } = S.pendingUpdate;
		S.pendingUpdate = null;
		S.items[index] = item;
		S.handle.broadcast({ type: "update", index, item });
	}

	/** 流式更新节流：避免每个 token 都重渲染一次 */
	function scheduleUpdate(index: number, item: any): void {
		S.pendingUpdate = { index, item };
		if (S.flushTimer) return;
		S.flushTimer = setTimeout(flushPending, 120);
		S.flushTimer.unref?.();
	}

	function resolveIndex(message: any): number | undefined {
		const mapped = S.indexByMessage.get(message);
		if (mapped !== undefined) return mapped;
		return S.openIndex ?? undefined;
	}

	pi.on("message_start", (event, ctx) => {
		syncCtx(ctx);
		if (!S.handle) return;
		const message: any = (event as any).message;
		const item = messageToItem(message);
		if (!item) return;
		const index = S.items.length;
		S.items.push(item);
		S.indexByMessage.set(message, index);
		S.openIndex = index;
		S.handle.broadcast({ type: "append", item });
	});

	pi.on("message_update", (event, ctx) => {
		syncCtx(ctx);
		if (!S.handle) return;
		const message: any = (event as any).message;
		const item = messageToItem(message);
		if (!item) return;
		const index = resolveIndex(message);
		if (index === undefined) {
			const next = S.items.length;
			S.items.push(item);
			S.indexByMessage.set(message, next);
			S.openIndex = next;
			S.handle.broadcast({ type: "append", item });
			return;
		}
		S.indexByMessage.set(message, index);
		scheduleUpdate(index, item);
	});

	pi.on("message_end", (event, ctx) => {
		if (!S.handle) return;
		const message: any = (event as any).message;
		const item = messageToItem(message);
		if (!item) return;
		const index = resolveIndex(message);
		if (index === undefined) {
			const next = S.items.length;
			S.items.push(item);
			S.indexByMessage.set(message, next);
			S.handle.broadcast({ type: "append", item });
		} else {
			S.items[index] = item;
			S.handle.broadcast({ type: "update", index, item });
			if (S.openIndex === index) S.openIndex = null;
		}
		// 一轮结束后费用/上下文会变，刷新侧栏信息
		broadcastMeta(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		syncCtx(ctx);
		S.handle?.broadcast({ type: "status", busy: true });
	});
	pi.on("agent_end", (_event, ctx) => {
		syncCtx(ctx);
		S.handle?.broadcast({ type: "status", busy: false });
	});
	pi.on("agent_settled", (_event, ctx) => {
		S.handle?.broadcast({ type: "status", busy: false });
		if (ctx) broadcastMeta(ctx);
	});

	// ---------- 会话 / 分支 / 压缩：让页面整体重载，服务不中断 ----------
	/** 会话名称变化：只更新 meta，不必重载内容 */
	pi.on("session_info_changed", (_event, ctx) => {
		broadcastMeta(ctx);
	});

	/** 新建 / 恢复 / fork 会话：内容整体换成新会话的分支 */
	pi.on("session_start", (event, ctx) => {
		if (!S.handle) return;
		const reason = (event as any)?.reason ?? "startup";
		reloadForContext(ctx, `session:${reason}`);
	});

	/** /tree 切换分支：同一会话内换分支 */
	pi.on("session_tree", (_event, ctx) => {
		reloadForContext(ctx, "tree");
	});

	/** /compact 压缩：条目结构变了，重建一次最省事 */
	pi.on("session_compact", (_event, ctx) => {
		reloadForContext(ctx, "compact");
	});

	/** 退出时关掉服务；会话切换（new/resume/fork/reload）时保留，等 session_start 重绑 */
	pi.on("session_shutdown", async (event) => {
		if (!S.handle) return;
		const reason = (event as any)?.reason ?? "quit";
		if (reason !== "quit") return;
		try {
			await S.handle.close();
		} catch {
			/* 忽略 */
		}
		S.handle = null;
		S.inputEnabled = false;
		S.items = [];
		S.ctx = null;
	});

	async function ensureLive(ctx: ExtensionCommandContext): Promise<LiveServerHandle> {
		syncCtx(ctx);
		if (S.handle) return S.handle;
		await mkdir(OUT_DIR, { recursive: true });
		await ensureAssets();
		S.items = buildItems(ctx.sessionManager.getBranch());
		S.openIndex = null;
		S.indexByMessage = new WeakMap();
		const handle = await startLiveServer({
			assetsDir: ASSETS_DIR,
			// 每次都调当前实例注册的实现，而不是启动时的旧闭包
			pageHtml: () => S.pageHtmlImpl?.() ?? buildLiveHtml({ sessionId: "unknown", sessionName: "", cwd: "" }),
			getSnapshot: () => S.snapshotImpl?.() ?? { items: S.items, meta: {} },
			isInputEnabled: () => S.inputEnabled,
			onPrompt: async (text) => {
				pi.sendUserMessage(text);
			},
			onLog: (message) => ctx.ui.notify(message, "warn"),
		});
		S.handle = handle;
		return handle;
	}

	// ---------- /live：实时镜像 ----------
	pi.registerCommand("live", {
		description: "实时镜像：/live 启动｜/live open 重新打开页面｜/live input 解锁输入｜/live lock 锁定｜/live off 停止",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = [
				{ value: "input", label: "input", description: "解锁页面输入（默认锁定）" },
				{ value: "lock", label: "lock", description: "重新锁定页面输入" },
				{ value: "open", label: "open", description: "重新打开实时页面（不重启服务）" },
				{ value: "status", label: "status", description: "查看地址 / 连接数 / 输入状态" },
				{ value: "off", label: "off", description: "停止实时服务并释放端口" },
			];
			const hit = subcommands.filter((s) => s.value.startsWith(String(prefix ?? "")));
			return hit.length > 0 ? hit : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const sub = (String(args ?? "").trim().toLowerCase().split(/\s+/)[0] ?? "").trim();
			try {
				if (sub === "off" || sub === "stop" || sub === "close") {
					if (!S.handle) {
						ctx.ui.notify("实时服务未运行", "info");
						return;
					}
					const port = S.handle.port;
					await S.handle.close();
					S.handle = null;
					S.inputEnabled = false;
					ctx.ui.notify(`实时服务已停止（端口 ${port} 已释放），页面输入同时锁定`, "info");
					return;
				}
				if (sub === "lock") {
					S.inputEnabled = false;
					S.handle?.broadcast({ type: "input", enabled: false });
					ctx.ui.notify("页面输入已锁定", "info");
					return;
				}
				if (sub === "status") {
					if (!S.handle) {
						ctx.ui.notify("实时服务未运行（/live 启动）", "info");
						return;
					}
					ctx.ui.notify(
						`实时服务：${S.handle.url}\n连接数：${S.handle.clientCount()}｜输入：${S.inputEnabled ? "已解锁" : "已锁定"}`,
						"info",
					);
					return;
				}

				if (sub === "open") {
					const handle = await ensureLive(ctx);
					openInBrowser(handle.url);
					ctx.ui.notify(`已打开实时页面：${handle.url}`, "info");
					return;
				}

				const wasRunning = !!S.handle;
				const handle = await ensureLive(ctx);
				if (sub === "input" || sub === "unlock") {
					S.inputEnabled = true;
					handle.broadcast({ type: "input", enabled: true });
					ctx.ui.notify(
						`页面输入已解锁（仅本次会话有效，/live lock 可重新锁定）\n地址：${handle.url}`,
						"info",
					);
					// 服务是本次才启动的才顺手打开页面，避免平白多开标签页
					if (!wasRunning) openInBrowser(handle.url);
					return;
				}
				if (wasRunning) {
					ctx.ui.notify(
						`实时服务已在运行（随机端口 ${handle.port}）\n地址：${handle.url}\n页面地址未变，可直接切到已打开的标签页；需要重新打开：/live open`,
						"info",
					);
					return;
				}
				ctx.ui.notify(
					`实时服务已启动（随机端口 ${handle.port}，仅监听 127.0.0.1）\n地址：${handle.url}\n页面输入默认锁定，需要时执行 /live input`,
					"info",
				);
				openInBrowser(handle.url);
			} catch (err: any) {
				ctx.ui.notify(`实时服务出错：${err?.stack ?? err?.message ?? String(err)}`, "error");
			}
		},
	});

	// ---------- /preview：静态快照 ----------
	pi.registerCommand("preview", {
		description: "把当前会话渲染成带公式排版的 HTML 并打开浏览器（/preview [最近N轮|all] [--keep N]）",
		getArgumentCompletions: (prefix: string) => {
			const args = [
				{ value: "all", label: "all", description: "渲染全部轮次（默认）" },
				{ value: "5", label: "5", description: "只渲染最近 5 轮" },
				{ value: "20", label: "20", description: "只渲染最近 20 轮" },
				{ value: "--keep", label: "--keep", description: "保留最近 N 个页面（默认 30）" },
			];
			const hit = args.filter((a) => a.value.startsWith(String(prefix ?? "")));
			return hit.length > 0 ? hit : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const started = Date.now();
			try {
				const cfg = parseArgs(args);
				await mkdir(OUT_DIR, { recursive: true });
				await ensureAssets();

				const entries = ctx.sessionManager.getBranch();
				const all = buildItems(entries);
				const items = tailByRounds(all, cfg.rounds);

				const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? process.env.PI_SESSION_FILE ?? "";
				const sessionId = sessionShortId(ctx);
				const file = await uniquePagePath(`${sessionId}-${timeStamp()}`);

				const html = await buildHtml(items, {
					sessionId,
					sessionName: sessionNameOf(ctx),
					sessionFile,
					cwd: ctx.cwd ?? "",
					usage: usageInfo(ctx, entries),
					goal: goalInfo(entries),
					generatedAt: new Date().toLocaleString(),
					totalItems: all.length,
					shownItems: items.length,
				});
				await writeFile(file, html, "utf8");

				const cleaned = await cleanupPages(OUT_DIR, cfg.keep);
				openInBrowser(file);
				const sizeKb = Math.round(Buffer.byteLength(html, "utf8") / 1024);
				ctx.ui.notify(
					`预览已生成并打开：${file}（${items.length} 项 · ${sizeKb} KB · ${Date.now() - started} ms` +
						(cleaned.removed > 0 ? ` · 清理旧页面 ${cleaned.removed} 个` : "") +
						"）",
					"info",
				);
			} catch (err: any) {
				ctx.ui.notify(`预览生成失败：${err?.stack ?? err?.message ?? String(err)}`, "error");
			}
		},
	});
}
