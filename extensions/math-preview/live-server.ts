/**
 * 实时预览的本地 HTTP 服务。
 *
 * 安全设计（按使用方要求）：
 * - 随机端口：listen(0) 由系统分配，不占用任何固定端口
 * - 仅绑定 127.0.0.1，不暴露到局域网
 * - token 校验（页面 URL 携带）
 * - Origin / Host / Sec-Fetch-Site 校验，防 CSRF 与 DNS rebinding
 * - 输入通道默认关闭，需在终端执行 /live input 才放行 POST /prompt
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
};

export interface LiveServerOptions {
	assetsDir: string;
	/** 生成实时页面 HTML（内联 css / viewer.js / viewer-live.js） */
	pageHtml: () => Promise<string> | string;
	token?: string;
	getSnapshot: () => { items: unknown[]; meta: Record<string, unknown> };
	isInputEnabled: () => boolean;
	onPrompt: (text: string) => Promise<void>;
	onLog?: (message: string) => void;
	/**
	 * 额外路由钩子（插件用，如翻译）：返回 true 表示已处理该请求。
	 * 调用时机：Host/Origin 校验之后、内置路由之前；token 校验由钩子自行处理。
	 */
	extraRoutes?: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>;
}

export interface LiveServerHandle {
	token: string;
	port: number;
	url: string;
	broadcast: (event: unknown) => void;
	clientCount: () => number;
	close: () => Promise<void>;
}

function send(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
	res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
	res.end(body);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
	send(res, status, JSON.stringify(data), "application/json; charset=utf-8");
}

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
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
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

export async function startLiveServer(opts: LiveServerOptions): Promise<LiveServerHandle> {
	const token = opts.token ?? randomBytes(24).toString("base64url");
	const allowedHosts = new Set<string>();
	const allowedOrigins = new Set<string>();
	const clients = new Set<ServerResponse>();

	const broadcast = (event: unknown): void => {
		const payload = `data: ${JSON.stringify(event)}\n\n`;
		for (const client of clients) {
			try {
				client.write(payload);
			} catch {
				clients.delete(client);
			}
		}
	};

	const hostOk = (req: IncomingMessage): boolean => {
		const host = String(req.headers.host ?? "").toLowerCase();
		return allowedHosts.has(host);
	};
	/** 防 CSRF / DNS rebinding：带 Origin 的请求必须来自本服务自身 */
	const originOk = (req: IncomingMessage): boolean => {
		const origin = req.headers.origin;
		if (origin && !allowedOrigins.has(String(origin).toLowerCase())) return false;
		const site = req.headers["sec-fetch-site"];
		if (typeof site === "string" && site !== "same-origin" && site !== "none") return false;
		return true;
	};
	const tokenOk = (url: URL, req: IncomingMessage): boolean =>
		url.searchParams.get("token") === token || req.headers["x-pi-token"] === token;

	const server = createServer((req, res) => {
		void handle(req, res);
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://127.0.0.1/");
		try {
			if (!hostOk(req)) return send(res, 403, "forbidden: bad host");
			if (!originOk(req)) return send(res, 403, "forbidden: bad origin");

			// 插件路由（翻译等，由调用方按 settings 开关注入）
			if (opts.extraRoutes) {
				const handled = await opts.extraRoutes(req, res, url);
				if (handled) return;
			}

			// SSE 事件流
			if (url.pathname === "/events") {
				if (!tokenOk(url, req)) return send(res, 403, "forbidden: bad token");
				res.writeHead(200, {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-store, no-transform",
					connection: "keep-alive",
					"x-accel-buffering": "no",
				});
				clients.add(res);
				const snap = opts.getSnapshot();
				res.write(
					`data: ${JSON.stringify({
						type: "hello",
						inputEnabled: opts.isInputEnabled(),
						meta: snap.meta,
					})}\n\n`,
				);
				res.write(`data: ${JSON.stringify({ type: "init", items: snap.items })}\n\n`);
				req.on("close", () => clients.delete(res));
				return;
			}

			// 输入通道：默认锁定
			if (url.pathname === "/prompt") {
				if (req.method !== "POST") return send(res, 405, "method not allowed");
				if (!tokenOk(url, req)) return sendJson(res, 403, { ok: false, error: "bad token" });
				if (!opts.isInputEnabled()) {
					return sendJson(res, 403, { ok: false, error: "输入已在终端锁定（执行 /live input 解锁）" });
				}
				let text = "";
				try {
					const body = await readBody(req);
					text = String((JSON.parse(body) as { text?: unknown }).text ?? "").trim();
				} catch {
					return sendJson(res, 400, { ok: false, error: "bad request" });
				}
				if (!text) return sendJson(res, 400, { ok: false, error: "空消息" });
				try {
					await opts.onPrompt(text);
					sendJson(res, 200, { ok: true });
				} catch (err) {
					sendJson(res, 500, { ok: false, error: String((err as Error)?.message ?? err) });
				}
				return;
			}

			// 静态资源（KaTeX / marked / hljs / ansi）
			if (url.pathname.startsWith("/assets/")) {
				const rel = decodeURIComponent(url.pathname.slice("/assets/".length));
				const root = resolve(opts.assetsDir);
				const target = resolve(root, rel);
				if (target !== root && !target.startsWith(root + sep)) return send(res, 403, "forbidden: bad path");
				try {
					const data = await readFile(target);
					res.writeHead(200, {
						"content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
						"cache-control": "no-store",
					});
					res.end(data);
				} catch {
					send(res, 404, "not found");
				}
				return;
			}

			// 页面
			if (url.pathname === "/" || url.pathname === "/index.html") {
				if (!tokenOk(url, req)) return send(res, 403, "forbidden: bad token（请用终端输出的完整地址打开）");
				const html = await opts.pageHtml();
				send(res, 200, html, "text/html; charset=utf-8");
				return;
			}

			send(res, 404, "not found");
		} catch (err) {
			opts.onLog?.(`请求处理出错：${String((err as Error)?.message ?? err)}`);
			try {
				send(res, 500, "internal error");
			} catch {
				/* 连接可能已断开 */
			}
		}
	}

	const port = await new Promise<number>((resolvePort, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolvePort(typeof address === "object" && address ? address.port : 0);
		});
	});

	for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
		allowedHosts.add(host);
	}
	for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]) {
		allowedOrigins.add(origin);
	}

	const heartbeat = setInterval(() => {
		for (const client of clients) {
			try {
				client.write(": ping\n\n");
			} catch {
				clients.delete(client);
			}
		}
	}, 20000);
	heartbeat.unref?.();

	const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;

	return {
		token,
		port,
		url,
		broadcast,
		clientCount: () => clients.size,
		close: async () => {
			clearInterval(heartbeat);
			for (const client of clients) {
				try {
					client.end();
				} catch {
					/* 忽略 */
				}
			}
			clients.clear();
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		},
	};
}
