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
 */
import { execFile } from "node:child_process";
import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { cleanupPages, exists } from "./fsutil.ts";
import { startLiveServer, type LiveServerHandle } from "./live-server.ts";
import { buildHtml, buildItems, buildLiveHtml, messageToItem, tailByRounds } from "./render.ts";

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

/** 同一秒重复触发时避免覆盖：追加 -1、-2 … */
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

export default function mathPreview(pi: ExtensionAPI) {
	// ---------- 实时服务状态（仅 /live 之后才存在） ----------
	let live: LiveServerHandle | null = null;
	let liveItems: any[] = [];
	let inputEnabled = false;
	let openIndex: number | null = null;
	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingUpdate: { index: number; item: any } | null = null;
	const indexByMessage = new WeakMap<object, number>();

	function flushPending(): void {
		flushTimer = null;
		if (!pendingUpdate || !live) {
			pendingUpdate = null;
			return;
		}
		const { index, item } = pendingUpdate;
		pendingUpdate = null;
		liveItems[index] = item;
		live.broadcast({ type: "update", index, item });
	}

	/** 流式更新节流：避免每个 token 都重渲染一次 */
	function scheduleUpdate(index: number, item: any): void {
		pendingUpdate = { index, item };
		if (flushTimer) return;
		flushTimer = setTimeout(flushPending, 120);
		flushTimer.unref?.();
	}

	function resolveIndex(message: any): number | undefined {
		const mapped = indexByMessage.get(message);
		if (mapped !== undefined) return mapped;
		return openIndex ?? undefined;
	}

	pi.on("message_start", (event) => {
		if (!live) return;
		const message: any = (event as any).message;
		const item = messageToItem(message);
		if (!item) return;
		const index = liveItems.length;
		liveItems.push(item);
		indexByMessage.set(message, index);
		openIndex = index;
		live.broadcast({ type: "append", item });
	});

	pi.on("message_update", (event) => {
		if (!live) return;
		const message: any = (event as any).message;
		const item = messageToItem(message);
		if (!item) return;
		const index = resolveIndex(message);
		if (index === undefined) {
			const next = liveItems.length;
			liveItems.push(item);
			indexByMessage.set(message, next);
			openIndex = next;
			live.broadcast({ type: "append", item });
			return;
		}
		indexByMessage.set(message, index);
		scheduleUpdate(index, item);
	});

	pi.on("message_end", (event) => {
		if (!live) return;
		const message: any = (event as any).message;
		const item = messageToItem(message);
		if (!item) return;
		const index = resolveIndex(message);
		if (index === undefined) {
			const next = liveItems.length;
			liveItems.push(item);
			indexByMessage.set(message, next);
			live.broadcast({ type: "append", item });
			return;
		}
		liveItems[index] = item;
		live.broadcast({ type: "update", index, item });
		if (openIndex === index) openIndex = null;
	});

	pi.on("agent_start", () => {
		live?.broadcast({ type: "status", busy: true });
	});
	pi.on("agent_end", () => {
		live?.broadcast({ type: "status", busy: false });
	});
	pi.on("agent_settled", () => {
		live?.broadcast({ type: "status", busy: false });
	});

	pi.on("session_shutdown", async () => {
		if (!live) return;
		try {
			await live.close();
		} catch {
			/* 忽略 */
		}
		live = null;
		inputEnabled = false;
	});

	async function ensureLive(ctx: ExtensionCommandContext): Promise<LiveServerHandle> {
		if (live) return live;
		await mkdir(OUT_DIR, { recursive: true });
		await ensureAssets();
		liveItems = buildItems(ctx.sessionManager.getBranch());
		openIndex = null;
		const handle = await startLiveServer({
			assetsDir: ASSETS_DIR,
			pageHtml: () => buildLiveHtml({ sessionId: sessionShortId(ctx), cwd: ctx.cwd }),
			getSnapshot: () => ({
				items: liveItems,
				meta: {
					sessionId: sessionShortId(ctx),
					sessionName: sessionNameOf(ctx),
					cwd: ctx.cwd,
					generatedAt: new Date().toLocaleString(),
					totalItems: liveItems.length,
				},
			}),
			isInputEnabled: () => inputEnabled,
			onPrompt: async (text) => {
				pi.sendUserMessage(text);
			},
			onLog: (message) => ctx.ui.notify(message, "warn"),
		});
		live = handle;
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
					if (!live) {
						ctx.ui.notify("实时服务未运行", "info");
						return;
					}
					const port = live.port;
					await live.close();
					live = null;
					inputEnabled = false;
					ctx.ui.notify(`实时服务已停止（端口 ${port} 已释放），页面输入同时锁定`, "info");
					return;
				}
				if (sub === "lock") {
					inputEnabled = false;
					live?.broadcast({ type: "input", enabled: false });
					ctx.ui.notify("页面输入已锁定", "info");
					return;
				}
				if (sub === "status") {
					if (!live) {
						ctx.ui.notify("实时服务未运行（/live 启动）", "info");
						return;
					}
					ctx.ui.notify(
						`实时服务：${live.url}\n连接数：${live.clientCount()}｜输入：${inputEnabled ? "已解锁" : "已锁定"}`,
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

				const wasRunning = !!live;
				const handle = await ensureLive(ctx);
				if (sub === "input" || sub === "unlock") {
					inputEnabled = true;
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
