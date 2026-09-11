/* 浏览器端渲染：Markdown + KaTeX + 语法高亮 + ANSI（由 pi 扩展 math-preview 注入，勿单独引用）
   两种模式：
   - 静态：页面内嵌 session-data，脚本自己执行 main()
   - 实时（window.__PI_LIVE_MODE__）：数据由 viewer-live.js 通过 SSE 推送，本文件只暴露 window.PiPreview */
(function () {
	"use strict";
	var LIVE = !!window.__PI_LIVE_MODE__;
	var BOOT = (window.performance && performance.now && performance.now()) || 0;

	var items = [];
	var meta = {};
	if (!LIVE) {
		try {
			var data = JSON.parse(document.getElementById("session-data").textContent || "{}");
			items = data.items || [];
			meta = data.meta || {};
		} catch (e) {
			items = [];
			meta = {};
		}
	}

	// marked 缺失（资源未加载 / 页面被移位）时用 typeof 保护，降级为纯文本而不是直接崩溃
	var markedFn = null;
	if (typeof marked === "function") markedFn = marked;
	else if (typeof marked === "object" && marked && typeof marked.parse === "function") markedFn = marked.parse.bind(marked);

	/** 由 setupSidebarToggle 赋值，供拖拽自动收起复用 */
	var setCollapsed = function () {};
	var tocObserver = null;
	/** 静态页标题带后缀，与实时页区分 */
	var TITLE_SUFFIX = LIVE ? "" : " · 快照";

	function esc(s) {
		return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
		});
	}

	/** 侧栏目录用：月-日 时:分（长会话可能跨天，但不需要秒级精度） */
	function timeShort(t) {
		if (!t) return "";
		var d = new Date(t);
		if (isNaN(d.getTime())) return "";
		var p = function (n) { return String(n).padStart(2, "0"); };
		return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
	}

	/** 正文条目头用：年-月-日 时:分:秒（空间充足，便于定位） */
	function timeFull(t) {
		if (!t) return "";
		var d = new Date(t);
		if (isNaN(d.getTime())) return "";
		var p = function (n) { return String(n).padStart(2, "0"); };
		return (
			d.getFullYear() +
			"-" + p(d.getMonth() + 1) +
			"-" + p(d.getDate()) +
			" " + p(d.getHours()) +
			":" + p(d.getMinutes()) +
			":" + p(d.getSeconds())
		);
	}

	function truncate(s, n) {
		s = String(s == null ? "" : s);
		if (s.length <= n) return { text: s, truncated: false };
		return { text: s.slice(0, n) + "\n…（预览已截断，共 " + s.length + " 字符）", truncated: true };
	}

	/**
	 * 判断 $...$ 里的内容是否真的像数学公式，避免把代码/正则/说明误当公式。
	 * isDisplay：display 公式（$$...$$ / \[...\]）允许跨行、长度也更宽松；
	 * 行内公式的匹配正则本身就不含换行，所以无须重复限制。
	 */
	function looksLikeMath(tex, isDisplay) {
		var t = String(tex).trim();
		var limit = isDisplay ? 2000 : 400;
		if (!t || t.length > limit) return false;
		// \s \d \w \n … 后面不再跟字母 → 是 JS 正则/字符串转义；若是 \sum \sqrt \nabla 等 LaTeX 命令则放行
		if (/\\[dswntrDSWNTRbB](?![a-zA-Z])/.test(t)) return false;
		if (/\(\?|\*\/|\/\/|=>|\[\^/.test(t)) return false;
		// 中文且没有 \text 类命令 → 不是数学
		if (/[\u4e00-\u9fff]/.test(t) && !/\\(text|mathrm|mbox|operatorname|textbf|textit|mathbf)\b/.test(t)) return false;
		// 命令行 / 路径 / 文件名特征：shell 变量对、引号、扩展名、URL、${...}
		// 注意不能把 | 算进来：数学里 | 是取值/绝对值符号（如 \left.\dfrac{...}\right|{r=0}）
		if (/[;"'`]/.test(t)) return false;
		if (/\\/.test(t) && !/\\[a-zA-Z]/.test(t)) return false;
		if (/\.(xlsx?|csv|py|js|ts|json|txt|md|html?|exe|sh|bat|log|png|jpe?g|gif|pdf|zip)\b/i.test(t)) return false;
		if (/:\/\//.test(t) || /\$\{/.test(t)) return false;
		// 明确的数学信号
		if (/\\[a-zA-Z]+/.test(t)) return true; // \frac \sum \alpha …
		if (/[≤≥≠≈∑∫√∞±×÷→←∈∀∃∂∇]/.test(t)) return true;
		if (/[=+\-*/^_{}<>|]/.test(t) && /[0-9a-zA-Z]/.test(t)) return true;
		// 简单数学表达式：单个变量、下标、函数调用、参数列表（如 C、T_0、f(x)、(r,z)、r,z）
		// 字符集刻意排除 / \ : 等路径字符，避免把 $TEMP/x$ 这类当成公式
		if (/^[a-zA-Z0-9(\[{][a-zA-Z0-9\s,^_(){}[\].+\-*]*$/.test(t) && /[a-zA-Z]/.test(t)) return true;
		return false;
	}

	/** 代码高亮（指定语言 → 自动识别 → 纯转义） */
	function highlightCode(code, lang) {
		if (typeof hljs === "undefined") return esc(code);
		var l = String(lang || "").trim().toLowerCase();
		if (l && hljs.getLanguage && hljs.getLanguage(l)) {
			try {
				return hljs.highlight(code, { language: l }).value;
			} catch (e) {
				/* 回退 */
			}
		}
		// 代码块没标语言时自动识别（限长，避免大段文本卡顿）
		if (!l && hljs.highlightAuto && code.length <= 20000 && code.split("\n").length <= 400) {
			try {
				var auto = hljs.highlightAuto(code);
				if (auto && typeof auto.value === "string") return auto.value;
			} catch (e) {
				/* 回退 */
			}
		}
		return esc(code);
	}

	/** 预格式化文本：含 ANSI 转义则还原颜色，否则普通转义 */
	function preBlock(text, cls) {
		var raw = String(text == null ? "" : text);
		var body = /\u001b\[/.test(raw) && typeof ansiToHtml === "function" ? ansiToHtml(raw) : esc(raw);
		return "<pre" + (cls ? ' class="' + cls + '"' : "") + ">" + body + "</pre>";
	}

	/** diff 行着色 */
	function diffBlock(diff) {
		var body = String(diff)
			.split("\n")
			.map(function (line) {
				var c0 = line.charAt(0);
				var cls = c0 === "+" ? "diff-added" : c0 === "-" ? "diff-removed" : "diff-context";
				return '<span class="' + cls + '">' + esc(line) + "</span>";
			})
			.join("\n");
		return '<pre class="diff">' + body + "</pre>";
	}

	/**
	 * Markdown 渲染，并保护公式不被 Markdown 语法破坏：
	 * fenced code / 行内 code / $$..$$ / \[..\] / \(..\) / $..$ 全部先换成占位符，
	 * 交给 marked 后再还原（代码块顺便做语法高亮），最后由 KaTeX 渲染。
	 */
	function renderMarkdown(src) {
		if (!src) return "";
		// 随机前缀：避免与正文/思考里出现的字面量占位符撞车
		var uid = "@@M" + Math.random().toString(36).slice(2, 8) + "X";
		var codes = [];
		var codeLangs = [];
		var inlines = [];
		var maths = [];
		var addMath = function (tex, display) {
			maths.push({ tex: tex, display: display });
			return uid + "MATH" + (maths.length - 1) + "@@";
		};
		var s = String(src);

		// 代码块：按行扫描，fence 必须在行首（CommonMark 规则）。
		// 否则正文里的 ```lang 字面量会把一大段正文当成代码块吃掉。
		var lines = s.split("\n");
		var outLines = [];
		var li = 0;
		while (li < lines.length) {
			var open = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\n`]*)$/.exec(lines[li]);
			if (!open) {
				outLines.push(lines[li]);
				li++;
				continue;
			}
			var fence = open[1];
			var ch = fence.charAt(0);
			var lang = open[2].trim();
			var closeRe = new RegExp("^ {0,3}" + (ch === "`" ? "`" : "~") + "{" + fence.length + ",}[ \\t]*$");
			var body = [];
			var lj = li + 1;
			while (lj < lines.length && !closeRe.test(lines[lj])) {
				body.push(lines[lj]);
				lj++;
			}
			if (lj >= lines.length) {
				// 未闭合：当普通文本，不吞后续内容
				outLines.push(lines[li]);
				li++;
				continue;
			}
			codes.push(body.join("\n"));
			codeLangs.push(lang);
			outLines.push("```" + lang);
			outLines.push(uid + "CODEBLOCK" + (codes.length - 1) + "@@");
			outLines.push("```");
			li = lj + 1;
		}
		s = outLines.join("\n");

		s = s.replace(/`([^`\n]+)`/g, function (_m, body) {
			inlines.push(body);
			return uid + "INLINECODE" + (inlines.length - 1) + "@@";
		});
		s = s.replace(/\$\$([\s\S]+?)\$\$/g, function (_m, tex) {
			return looksLikeMath(tex, true) ? addMath(tex.trim(), true) : _m;
		});
		s = s.replace(/\\\[([\s\S]+?)\\\]/g, function (_m, tex) {
			return looksLikeMath(tex, true) ? addMath(tex.trim(), true) : _m;
		});
		s = s.replace(/\\\(([\s\S]+?)\\\)/g, function (_m, tex) {
			return looksLikeMath(tex, false) ? addMath(tex.trim(), false) : _m;
		});
		s = s.replace(/(^|[^\\$])\$(?!\s)([^\n$]+?)(?<!\s)\$(?!\$)/g, function (m, pre, tex) {
			return looksLikeMath(tex, false) ? pre + addMath(tex, false) : m;
		});

		// 正文里的 HTML 标签不能当真实标签（否则 <script> 之类会吞掉页面后续内容），统一转义
		s = s.replace(/<(?=[a-zA-Z!/])/g, "&lt;");

		var html = markedFn ? markedFn(s, { gfm: true, breaks: true }) : "<pre>" + esc(s) + "</pre>";

		html = html.replace(new RegExp(uid + "CODEBLOCK(\\d+)@@", "g"), function (_m, i) {
			var v = codes[+i];
			return v === undefined ? "" : highlightCode(v, codeLangs[+i]);
		});
		html = html.replace(new RegExp(uid + "INLINECODE(\\d+)@@", "g"), function (_m, i) {
			var v = inlines[+i];
			return v === undefined ? "" : "<code>" + esc(v) + "</code>";
		});
		html = html.replace(new RegExp("<p>\\s*" + uid + "MATH(\\d+)@@\\s*</p>", "g"), function (_m, i) {
			var it = maths[+i];
			if (!it) return _m;
			return '<div class="math-display" data-tex="' + esc(it.tex) + '"></div>';
		});
		html = html.replace(new RegExp(uid + "MATH(\\d+)@@", "g"), function (_m, i) {
			var it = maths[+i];
			if (!it) return _m;
			return it.display
				? '<div class="math-display" data-tex="' + esc(it.tex) + '"></div>'
				: '<span class="math-inline" data-tex="' + esc(it.tex) + '"></span>';
		});
		return html;
	}

	function renderMath(root) {
		if (!root) return;
		if (typeof katex === "undefined") {
			(window.__mathErrors = window.__mathErrors || []).push("katex 未加载");
			return;
		}
		root.querySelectorAll("[data-tex]").forEach(function (el) {
			var display = el.classList.contains("math-display");
			try {
				katex.render(el.getAttribute("data-tex") || "", el, {
					displayMode: display,
					throwOnError: false,
					strict: "ignore",
					trust: false,
				});
			} catch (e) {
				el.classList.add("math-error");
				(window.__mathErrors = window.__mathErrors || []).push(String((e && e.message) || e));
			}
		});
	}

	function argsPreview(args) {
		try {
			return JSON.stringify(args, null, 2);
		} catch (e) {
			return String(args);
		}
	}

	function itemHtml(it, idx) {
		var time = timeFull(it.time);
		switch (it.kind) {
			case "user":
				return (
					'<article class="item user" id="item-' + idx + '"><header><span class="who">用户</span>' +
					'<span class="time">' + time + "</span></header>" +
					'<div class="md">' + renderMarkdown(it.text) + "</div></article>"
				);
			case "assistant": {
				var metaBits = [it.model, it.provider].filter(Boolean).join(" · ");
				if (it.stopReason && it.stopReason !== "stop") metaBits += " · " + it.stopReason;
				var thinking = it.thinking
					? '<details class="thinking"><summary>思考过程</summary><div class="md thinking-body">' +
						renderMarkdown(it.thinking) + "</div></details>"
					: "";
				var err = it.error ? '<div class="item-error">' + esc(it.error) + "</div>" : "";
				var tools = (it.tools || [])
					.map(function (t) {
						return (
							'<details class="tool-call"><summary>工具调用 · ' + esc(t.name) + "</summary>" +
							preBlock(argsPreview(t.args)) + "</details>"
						);
					})
					.join("");
				var body = it.text ? '<div class="md">' + renderMarkdown(it.text) + "</div>" : "";
				return (
					'<article class="item assistant" id="item-' + idx + '"><header><span class="who">Assistant</span>' +
					'<span class="time">' + time + '</span><span class="meta">' + esc(metaBits) + "</span></header>" +
					thinking + err + body + tools + "</article>"
				);
			}
			case "toolResult": {
				var t = truncate(it.text, 4000);
				var body = it.diff ? diffBlock(String(it.diff).slice(0, 20000)) : preBlock(t.text);
				return (
					'<details class="item tool-result' + (it.isError ? " is-error" : "") + '" id="item-' + idx + '">' +
					"<summary>" + (it.isError ? "✗" : "✓") + " 工具结果 · " + esc(it.toolName || "") +
					(it.diff ? "（diff）" : "") + "</summary>" +
					body + "</details>"
				);
			}
			case "bash": {
				var b = truncate(it.output, 4000);
				return (
					'<details class="item bash" id="item-' + idx + '"><summary>$ ' + esc(it.command || "") +
					(it.exitCode ? " （exit " + it.exitCode + "）" : "") + "</summary>" +
					preBlock(b.text) + "</details>"
				);
			}
			case "custom":
				return (
					'<article class="item custom" id="item-' + idx + '"><header><span class="who">' + esc(it.customType || "custom") +
					'</span><span class="time">' + time + "</span></header>" +
					'<div class="md">' + renderMarkdown(it.text) + "</div></article>"
				);
			case "summary":
				return (
					'<article class="item summary" id="item-' + idx + '"><header><span class="who">' + esc(it.label) +
					'</span><span class="time">' + time + "</span></header>" +
					'<div class="md">' + renderMarkdown(it.text) + "</div></article>"
				);
			case "note":
				return '<div class="note" id="item-' + idx + '">' + esc(it.text) + "</div>";
			default:
				return "";
		}
	}

	function htmlFor(it, idx) {
		var h = itemHtml(it, idx);
		return h || '<div class="item empty" id="item-' + idx + '" hidden></div>';
	}

	function formatTokens(n) {
		if (typeof n !== "number" || !isFinite(n)) return "?";
		if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
		if (n >= 100000) return Math.round(n / 1000) + "k";
		if (n >= 1000) return (n / 1000).toFixed(1) + "k";
		return String(n);
	}

	function formatCost(c) {
		if (typeof c !== "number" || !isFinite(c)) return "";
		if (c <= 0) return "$0";
		if (c < 0.01) return "$" + c.toFixed(4);
		if (c < 1) return "$" + c.toFixed(3);
		return "$" + c.toFixed(2);
	}

	function updateHeader() {
		var s = document.getElementById("t-session");
		var m = document.getElementById("t-meta");
		// 只在会话有名字时显示名字，否则留空（不再显示会话 id 前 8 位）
		if (s) s.textContent = meta.sessionName ? " " + meta.sessionName : "";
		// meta 尚未到达（实时页刚加载）时不要覆盖 HTML 里已有的标题
		if (meta.sessionName !== undefined || meta.sessionId || meta.totalItems !== undefined) {
			document.title = (meta.sessionName || "新的对话") + TITLE_SUFFIX;
		}
		if (m) {
			var lines = [];
			lines.push(meta.totalItems && meta.totalItems !== items.length ? items.length + "/" + meta.totalItems + " 项" : items.length + " 项");
			var u = meta.usage;
			if (u) {
				var ctxLine = "上下文 " + formatTokens(u.contextTokens);
				if (u.contextWindow) ctxLine += " / " + formatTokens(u.contextWindow);
				if (typeof u.contextPercent === "number") ctxLine += "（" + Math.round(u.contextPercent) + "%）";
				lines.push(ctxLine);
				var cost = formatCost(u.cost);
				if (cost) lines.push("花费 " + cost);
			}
			if (meta.generatedAt) lines.push(meta.generatedAt);
			if (meta.cwd) lines.push(meta.cwd);
			m.textContent = lines.join("\n");
		}
		// 当前 goal（由 /goal 写入的 session entry 提供）
		var g = document.getElementById("t-goal");
		if (g) {
			var goal = meta.goal;
			if (goal && goal.text) {
				g.hidden = false;
				var tagText = goal.iteration > 1 ? "目标 · 第 " + goal.iteration + " 轮" : "当前目标";
				g.innerHTML = '<span class="goal-tag">' + esc(tagText) + "</span>" + esc(goal.text);
				g.title = goal.text;
			} else {
				g.hidden = true;
			}
		}
	}

	function buildSidebar() {
		var nav = document.getElementById("toc");
		if (!nav) return;
		var links = [];
		items.forEach(function (it, idx) {
			if (it.kind !== "user") return;
			var label = String(it.text || "").replace(/\s+/g, " ").trim().slice(0, 46) || "（空输入）";
			links.push(
				'<a href="#item-' + idx + '" data-idx="' + idx + '" title="' + esc(timeFull(it.time) + "  " + label) + '">' +
				'<span class="t">' + timeShort(it.time) + "</span>" + esc(label) + "</a>",
			);
		});
		nav.innerHTML = links.length
			? links.join("")
			: '<div class="dim" style="padding:4px 8px">（本次会话暂无用户输入）</div>';
	}

	function trackActive() {
		if (typeof IntersectionObserver === "undefined") return;
		var side = document.getElementById("sidebar");
		var byIdx = {};
		document.querySelectorAll("#toc a").forEach(function (a) {
			byIdx[a.getAttribute("data-idx")] = a;
		});
		if (tocObserver) tocObserver.disconnect();
		tocObserver = new IntersectionObserver(
			function (entries) {
				entries.forEach(function (en) {
					if (!en.isIntersecting) return;
					var idx = en.target.id.replace("item-", "");
					document.querySelectorAll("#toc a.active").forEach(function (a) {
						a.classList.remove("active");
					});
					var a = byIdx[idx];
					if (!a || !side) return;
					a.classList.add("active");
					if (a.offsetTop < side.scrollTop || a.offsetTop > side.scrollTop + side.clientHeight - 40) {
						side.scrollTop = Math.max(0, a.offsetTop - side.clientHeight / 2);
					}
				});
			},
			{ rootMargin: "-8% 0px -78% 0px" },
		);
		items.forEach(function (it, idx) {
			if (it.kind !== "user") return;
			var el = document.getElementById("item-" + idx);
			if (el) tocObserver.observe(el);
		});
	}

	function isNearBottom() {
		return window.innerHeight + window.scrollY >= (document.body.scrollHeight || 0) - 140;
	}

	function scrollToBottom() {
		window.scrollTo(0, document.body.scrollHeight);
	}

	// ---------- 渲染入口（静态与实时共用） ----------
	function renderAll() {
		var content = document.getElementById("content");
		if (!content) return;
		content.innerHTML = items.map(htmlFor).join("\n");
		content.querySelectorAll("a[href]").forEach(function (a) {
			var href = a.getAttribute("href") || "";
			if (href.charAt(0) !== "#") {
				a.setAttribute("target", "_blank");
				a.setAttribute("rel", "noreferrer");
			}
		});
		renderMath(content);
		updateHeader();
		buildSidebar();
		trackActive();
	}

	function appendItem(item) {
		var content = document.getElementById("content");
		var idx = items.length;
		items.push(item);
		var keepBottom = isNearBottom();
		if (content) {
			var wrapper = document.createElement("div");
			wrapper.innerHTML = htmlFor(item, idx);
			var el = wrapper.firstElementChild;
			if (el) {
				content.appendChild(el);
				renderMath(el);
			}
		}
		updateHeader();
		buildSidebar();
		if (keepBottom) scrollToBottom();
	}

	function updateItem(index, item) {
		if (!(index >= 0) || index >= items.length) return;
		items[index] = item;
		var el = document.getElementById("item-" + index);
		if (!el) return;
		var keepBottom = isNearBottom();
		var wrapper = document.createElement("div");
		wrapper.innerHTML = htmlFor(item, index);
		var next = wrapper.firstElementChild;
		if (!next) return;
		el.replaceWith(next);
		renderMath(next);
		if (keepBottom) scrollToBottom();
	}

	function setItems(list) {
		items = Array.isArray(list) ? list : [];
	}

	function setMeta(m) {
		meta = m || {};
	}

	/** 侧栏展开/收起，状态记在 localStorage */
	function setupSidebarToggle() {
		var btn = document.getElementById("side-toggle");
		if (!btn) return;
		var KEY = "pi-preview-side-collapsed";
		var apply = function (collapsed) {
			var change = function () {
				document.body.classList.toggle("side-collapsed", collapsed);
			};
			// 用 View Transitions 做整体交叉淡化：避免正文宽度突变时逐字重排的卡顶感
			if (typeof document.startViewTransition === "function") {
				document.startViewTransition(change);
			} else {
				change();
			}
			btn.textContent = collapsed ? "»" : "«";
			btn.title = collapsed ? "展开目录" : "收起目录";
		};
		setCollapsed = apply;
		var saved = false;
		try {
			saved = localStorage.getItem(KEY) === "1";
		} catch (e) {
			/* file:// 下可能不可用，忽略 */
		}
		apply(saved);
		btn.addEventListener("click", function () {
			var collapsed = !document.body.classList.contains("side-collapsed");
			apply(collapsed);
			try {
				localStorage.setItem(KEY, collapsed ? "1" : "0");
			} catch (e) {
				/* 忽略 */
			}
		});
	}

	/** 拖拽调整侧栏宽度，拖到阈值以下自动收起 */
	function setupResizer() {
		var resizer = document.getElementById("side-resizer");
		if (!resizer) return;
		var MIN_W = 140;
		var COLLAPSE_AT = 110;
		var MAX_RATIO = 0.5; // 侧栏最多占视口一半，保证正文可见
		var WIDTH_KEY = "pi-preview-side-width";
		var dragging = false;

		var maxWidth = function () {
			return Math.max(MIN_W, Math.round((window.innerWidth || 1200) * MAX_RATIO));
		};
		var clampW = function (w) {
			return Math.min(Math.max(w, MIN_W), maxWidth());
		};
		var setWidth = function (w) {
			document.documentElement.style.setProperty("--side-w", w + "px");
			return w;
		};
		var saveWidth = function (w) {
			try {
				localStorage.setItem(WIDTH_KEY, String(w));
			} catch (e) {
				/* 忽略 */
			}
		};
		var savedWidth = 0;
		try {
			savedWidth = parseInt(localStorage.getItem(WIDTH_KEY) || "0", 10) || 0;
		} catch (e) {
			/* 忽略 */
		}
		window.__sideWidth = savedWidth >= MIN_W ? clampW(savedWidth) : 0; // 0 = 用 CSS 默认值
		if (window.__sideWidth) setWidth(window.__sideWidth);

		resizer.addEventListener("mousedown", function (e) {
			dragging = true;
			document.body.classList.add("resizing");
			e.preventDefault();
		});
		window.addEventListener("mousemove", function (e) {
			if (!dragging) return;
			var raw = Math.round(e.clientX);
			if (raw < COLLAPSE_AT) {
				// 拖到阈值以下：自动收起，保留当前有效宽度以便重新展开
				dragging = false;
				document.body.classList.remove("resizing");
				setCollapsed(true);
				return;
			}
			window.__sideWidth = setWidth(clampW(raw));
		});
		window.addEventListener("mouseup", function () {
			if (!dragging) return;
			dragging = false;
			document.body.classList.remove("resizing");
			if (window.__sideWidth) saveWidth(window.__sideWidth);
		});
		// 窗口变小时也收在合理范围，避免正文被挤成一条
		window.addEventListener("resize", function () {
			if (window.__sideWidth) window.__sideWidth = setWidth(clampW(window.__sideWidth));
		});
	}

	function writeDiag(extra) {
		var content = document.getElementById("content");
		var diag = document.createElement("div");
		diag.id = "diag";
		diag.hidden = true;
		diag.textContent = JSON.stringify(
			Object.assign(
				{
					mode: LIVE ? "live" : "static",
					items: items.length,
					mathEls: content ? content.querySelectorAll("[data-tex]").length : 0,
					katex: typeof katex,
					marked: typeof marked,
					hljs: typeof hljs,
					ansi: typeof ansiToHtml,
					rendered: content ? content.querySelectorAll(".katex").length : 0,
					failed: content ? content.querySelectorAll(".math-error").length : 0,
					highlighted: content ? content.querySelectorAll("pre code span").length : 0,
					errors: window.__mathErrors || [],
					renderMs: Math.round((((window.performance && performance.now && performance.now()) || 0) - BOOT) * 10) / 10,
				},
				extra || {},
			),
		);
		document.body.appendChild(diag);
	}

	function main() {
		renderAll();
		writeDiag();
	}

	window.PiPreview = {
		setItems: setItems,
		setMeta: setMeta,
		renderAll: renderAll,
		appendItem: appendItem,
		updateItem: updateItem,
		updateHeader: updateHeader,
		buildSidebar: buildSidebar,
		trackActive: trackActive,
		renderMarkdown: renderMarkdown,
		renderMath: renderMath,
		itemHtml: htmlFor,
		esc: esc,
		timeShort: timeShort,
		timeFull: timeFull,
		setupSidebarToggle: setupSidebarToggle,
		setupResizer: setupResizer,
		writeDiag: writeDiag,
		getItems: function () {
			return items;
		},
	};

	if (LIVE) {
		setupSidebarToggle();
		setupResizer();
		updateHeader();
	} else {
		try {
			main();
		} catch (e) {
			var box = document.getElementById("content");
			if (box) box.innerHTML = '<pre class="fatal">渲染失败：' + esc((e && e.stack) || e) + "</pre>";
			throw e;
		}
	}
})();
