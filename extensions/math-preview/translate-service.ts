/**
 * 翻译服务（独立文件）
 *
 * 只在 settings.json 里把 mathPreview.translate.enabled 打开时，才由 index.ts 动态
 * 加载本文件 —— 关闭状态下这两个文件根本不会被读入，对现有功能零影响。
 *
 * 设计要点：
 * - 用 pi-ai 的 stream() 与 modelRegistry 里的凭据调用模型，API key 不出 pi 进程
 * - 译文只通过现有 SSE 推给浏览器，**绝不写入会话消息**（不碰 pi 的上下文与缓存）
 * - 单次长度上限 / 每分钟次数上限 / 并发上限，防失控调用（不是限制手动使用）
 */
// pi 加载扩展时会把 @earendil-works/pi-ai 别名到 compat 入口（见其 loader 的 alias 表），
// 因此这里用主入口写法即可拿到 stream()；key 也不出进程。
import { stream } from "@earendil-works/pi-ai";

export interface TranslateConfig {
	/** 总开关（默认关闭） */
	enabled: boolean;
	/** "provider/modelId"；缺省时自动挑选最便宜的可用文本模型 */
	model?: string;
	/** 目标语言 */
	targetLang: string;
	/** 允许翻译的内容类型（预留：thinking / text） */
	scope: string[];
	/** 单次请求的最大字符数，超出会分段 */
	maxCharsPerRequest: number;
	/** 每分钟最多请求次数 */
	maxRequestsPerMinute: number;
	/** 同时进行的翻译任务上限 */
	maxConcurrent: number;
}

export const DEFAULT_TRANSLATE_CONFIG: TranslateConfig = {
	enabled: false,
	targetLang: "简体中文",
	scope: ["thinking"],
	maxCharsPerRequest: 20000,
	maxRequestsPerMinute: 30,
	maxConcurrent: 2,
};

/** 宽松解析 settings 里的配置，非法值一律退回默认（避免一个手误让扩展报错） */
export function normalizeTranslateConfig(raw: unknown): TranslateConfig {
	const c = (raw ?? {}) as Record<string, unknown>;
	const num = (v: unknown, fallback: number, min: number, max: number): number => {
		const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
		if (!Number.isFinite(n)) return fallback;
		return Math.min(Math.max(Math.trunc(n), min), max);
	};
	const scope = Array.isArray(c.scope) ? c.scope.filter((s): s is string => typeof s === "string") : DEFAULT_TRANSLATE_CONFIG.scope;
	return {
		enabled: c.enabled === true,
		model: typeof c.model === "string" && c.model.trim() ? c.model.trim() : undefined,
		targetLang: typeof c.targetLang === "string" && c.targetLang.trim() ? c.targetLang.trim() : DEFAULT_TRANSLATE_CONFIG.targetLang,
		scope: scope.length ? scope : DEFAULT_TRANSLATE_CONFIG.scope,
		maxCharsPerRequest: num(c.maxCharsPerRequest, DEFAULT_TRANSLATE_CONFIG.maxCharsPerRequest, 200, 200000),
		maxRequestsPerMinute: num(c.maxRequestsPerMinute, DEFAULT_TRANSLATE_CONFIG.maxRequestsPerMinute, 1, 600),
		maxConcurrent: num(c.maxConcurrent, DEFAULT_TRANSLATE_CONFIG.maxConcurrent, 1, 8),
	};
}

/** 每分钟次数限制 */
export class RateLimiter {
	private hits: number[] = [];
	constructor(private readonly maxPerMinute: number) {}
	tryAcquire(): boolean {
		const now = Date.now();
		this.hits = this.hits.filter((t) => now - t < 60000);
		if (this.hits.length >= this.maxPerMinute) return false;
		this.hits.push(now);
		return true;
	}
	retryAfterSeconds(): number {
		if (!this.hits.length) return 0;
		return Math.max(1, Math.ceil((60000 - (Date.now() - this.hits[0])) / 1000));
	}
}

/** 简单的并发闸门 */
export class ConcurrencyGate {
	private active = 0;
	constructor(private readonly max: number) {}
	tryEnter(): boolean {
		if (this.active >= this.max) return false;
		this.active++;
		return true;
	}
	leave(): void {
		if (this.active > 0) this.active--;
	}
	get inFlight(): number {
		return this.active;
	}
}

/**
 * 选翻译模型：优先配置；否则在「可用的文本模型」里挑输入+输出单价最低的。
 * 选最便宜而不是跟随当前会话模型，是为了避免用贵模型翻译而悄悄烧钱。
 */
export function pickTranslatorModel(registry: any, config: TranslateConfig): any | null {
	if (!registry?.getAvailable) return null;
	if (config.model) {
		const slash = config.model.indexOf("/");
		if (slash > 0) {
			const found = registry.find?.(config.model.slice(0, slash), config.model.slice(slash + 1));
			if (found) return found;
		}
	}
	const available: any[] = registry.getAvailable() ?? [];
	const textModels = available.filter((m) => Array.isArray(m?.input) && m.input.includes("text") && m?.id && m?.provider);
	if (!textModels.length) return null;
	const price = (m: any): number => (Number(m?.cost?.input) || 0) + (Number(m?.cost?.output) || 0);
	return textModels.slice().sort((a, b) => price(a) - price(b))[0];
}

/**
 * 翻译提示词。
 * 关键：输入是原始 Markdown 源码，要求模型保持结构、不Translate代码与公式。
 */
export function buildTranslatePrompt(text: string, targetLang: string): string {
	return [
		`把下面的 Markdown 内容翻译成${targetLang}。要求：`,
		"1. 只输出译文，不要解释、不要加引号或代码块包裹整段结果；",
		"2. 保持 Markdown 结构：标题、列表、引用、分隔线、**表格（继续用 Markdown 表格语法，行列对齐）**都原样保留结构；",
		"3. 代码块（``` 围起来的部分）及其内部内容一律原样照抄，绝对不要翻译代码、命令、路径、变量名、报错信息；",
		"4. 数学公式（$...$、$$...$$、\\[...\\]）原样保留；",
		"5. 行内代码（`...`）内容原样保留；",
		"6. 忠实原意，不增删、不总结、不润色；",
		"7. 遇到没有把握的词直接保留原词（必要时加括号），不要猜着意译。",
		"",
		"原文（Markdown）：",
		text,
	].join("\n");
}

/** 按字符数把长文本切成若干段（尽量在空行/换行处切） */
export function splitForTranslation(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) return [text];
	const parts: string[] = [];
	let rest = text;
	while (rest.length > maxChars) {
		let cut = rest.lastIndexOf("\n\n", maxChars);
		if (cut < maxChars * 0.5) cut = rest.lastIndexOf("\n", maxChars);
		if (cut < maxChars * 0.5) cut = maxChars;
		parts.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest.trim()) parts.push(rest);
	return parts;
}

/** 读请求体（上限 256KB，翻译文本可能较长） */
async function readJsonBody(req: any, limit = 256 * 1024): Promise<any> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("请求体过大"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(new Error("请求体不是合法 JSON"));
			}
		});
		req.on("error", reject);
	});
}

function sendJson(res: any, status: number, data: unknown): void {
	try {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(JSON.stringify(data));
	} catch {
		/* 连接可能已断开 */
	}
}

export interface TranslateRequestOptions {
	req: any;
	res: any;
	url: URL;
	token: string;
	/** 取当前会话上下文（拿 modelRegistry；服务跨会话存活，所以用 getter） */
	getCtx: () => any;
	config: TranslateConfig;
	limiter: RateLimiter;
	gate: ConcurrencyGate;
	/** 通过现有 SSE 把译文推给页面（绝不写入会话） */
	broadcast: (event: unknown) => void;
	onLog?: (message: string) => void;
}

/**
 * 处理 POST /translate：立即回 202，真正的翻译在后台进行，
 * 逐段把 delta 经现有 SSE 推给页面。
 */
export async function handleTranslateRequest(o: TranslateRequestOptions): Promise<void> {
	if (o.req.method !== "POST") {
		sendJson(o.res, 405, { ok: false, error: "method not allowed" });
		return;
	}
	if (o.url.searchParams.get("token") !== o.token) {
		sendJson(o.res, 403, { ok: false, error: "bad token" });
		return;
	}
	if (!o.limiter.tryAcquire()) {
		sendJson(o.res, 429, { ok: false, error: `请求过于频繁，请约 ${o.limiter.retryAfterSeconds()} 秒后再试` });
		return;
	}
	if (!o.gate.tryEnter()) {
		sendJson(o.res, 429, { ok: false, error: "已有翻译在进行，请稍候" });
		return;
	}

	let payload: any;
	try {
		payload = await readJsonBody(o.req);
	} catch (err) {
		o.gate.leave();
		sendJson(o.res, 400, { ok: false, error: String((err as Error)?.message ?? err) });
		return;
	}

	const blockId = String(payload?.blockId ?? "");
	const text = String(payload?.text ?? "");
	const targetLang =
		typeof payload?.targetLang === "string" && payload.targetLang.trim() ? payload.targetLang.trim() : o.config.targetLang;
	if (!text.trim()) {
		o.gate.leave();
		sendJson(o.res, 400, { ok: false, error: "空内容" });
		return;
	}

	const ctx = o.getCtx?.();
	const registry = ctx?.modelRegistry;
	if (!registry) {
		o.gate.leave();
		sendJson(o.res, 503, { ok: false, error: "会话上下文不可用（先在会话里发一条消息）" });
		return;
	}
	const model = pickTranslatorModel(registry, o.config);
	if (!model) {
		o.gate.leave();
		sendJson(o.res, 503, { ok: false, error: "没有可用的翻译模型（检查 provider 凭据或 translate.model）" });
		return;
	}

	sendJson(o.res, 202, { ok: true, model: `${model.provider}/${model.id}` });

	const controller = new AbortController();
	const segments = splitForTranslation(text, o.config.maxCharsPerRequest);
	void (async () => {
		const startedAt = Date.now();
		let full = "";
		try {
			o.broadcast({ type: "translate-start", blockId, model: `${model.provider}/${model.id}`, segments: segments.length });
			for (const segment of segments) {
				await runTranslation({
					registry,
					model,
					text: segment,
					targetLang,
					signal: controller.signal,
					onDelta: (delta) => {
						full += delta;
						o.broadcast({ type: "translate", blockId, delta });
					},
				});
			}
			if (!full.trim()) throw new Error("模型没有返回内容");
			o.broadcast({ type: "translate-done", blockId, text: full.trim(), ms: Date.now() - startedAt });
		} catch (err) {
			o.onLog?.(`翻译失败：${String((err as Error)?.message ?? err)}`);
			o.broadcast({ type: "translate-error", blockId, error: String((err as Error)?.message ?? err) });
		} finally {
			o.gate.leave();
		}
	})();
}

export interface TranslateRunOptions {
	registry: any;
	model: any;
	text: string;
	targetLang: string;
	signal?: AbortSignal;
	/** 每收到一段译文就回调（用于流式推送给页面） */
	onDelta?: (delta: string) => void;
}

/**
 * 执行一次（或分段执行多次）翻译并流式返回。
 * 注意：这里只把结果交给回调，调用方负责通过 SSE 送给浏览器 —— 不写入会话。
 */
export async function runTranslation(options: TranslateRunOptions): Promise<{ text: string; usage?: any }> {
	const { registry, model, text, targetLang, signal, onDelta } = options;
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth?.apiKey && !auth?.headers) {
		throw new Error(`模型 ${model.provider}/${model.id} 没有可用凭据`);
	}
	const prompt = buildTranslatePrompt(text, targetLang);
	const maxTokens = Math.min(8192, Math.max(1024, Math.ceil(text.length * 1.5)));

	const eventStream = stream(
		model,
		{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens,
			signal,
		},
	);

	let out = "";
	let usage: any;
	for await (const event of eventStream) {
		if (signal?.aborted) break;
		if (event.type === "text_delta" && typeof (event as any).delta === "string") {
			out += (event as any).delta;
			onDelta?.((event as any).delta);
		} else if (event.type === "done" || event.type === "error") {
			usage = (event as any).message?.usage ?? (event as any).usage;
		}
	}
	return { text: out, usage };
}
