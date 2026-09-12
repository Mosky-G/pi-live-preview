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

	// 分阶段耗时打点（Step 0 起用于分片渲染的对比基线）。
	// ⚠ headless 的 --virtual-time-budget 下 performance.now() 不推进，
	//   读数必须用真实时钟（见临时测试脚本的最小 CDP 客户端）。
	var PERF = (window.__perf = {
		mode: LIVE ? "live" : "static",
		items: items.length,
		marks: {},
		chunks: 0,
		maxChunkMs: 0,
		/** 分片渲染已启用（Step 2 起）：测试脚本据此等待 marks.done 而非 marks.total */
		progressive: true,
		/** genMs 的内部归因（累计值，单位 ms） */
		attr: { markedMs: 0, hljsMs: 0, katexMs: 0 },
	});
	function perfNow() {
		return (window.performance && performance.now && performance.now()) || 0;
	}
	function mark(name) {
		PERF.marks[name] = Math.round((perfNow() - BOOT) * 10) / 10;
	}

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

		var tMarked = perfNow();
		var html = markedFn ? markedFn(s, { gfm: true, breaks: true }) : "<pre>" + esc(s) + "</pre>";
		PERF.attr.markedMs += perfNow() - tMarked;

		var tHljs = perfNow();
		html = html.replace(new RegExp(uid + "CODEBLOCK(\\d+)@@", "g"), function (_m, i) {
			var v = codes[+i];
			return v === undefined ? "" : highlightCode(v, codeLangs[+i]);
		});
		PERF.attr.hljsMs += perfNow() - tHljs;
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
		// 表格套一层横向滚动容器：单元格里有长 inline code 这类不可断词内容时，
		// 表格 min-content 会超过正文列宽。不直接给 table 加 overflow（那会把 table
		// 变成 block，旧版 Firefox 会丢失 table 语义），而由外层 wrapper 承担滚动。
		html = html
			.replace(/<table>/g, '<div class="md-table-wrap"><table>')
			.replace(/<\/table>/g, "</table></div>");
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
			var t = perfNow();
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
			} finally {
				PERF.attr.katexMs += perfNow() - t;
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
		// 当前 goal：底部固定条（始终可见）
		var g = document.getElementById("goal-bar");
		if (g) {
			var goal = meta.goal;
			if (goal && goal.text) {
				g.hidden = false;
				var tagText = goal.iteration > 1 ? "目标 · 第 " + goal.iteration + " 轮" : "当前目标";
				g.innerHTML =
					'<span class="goal-tag">' + esc(tagText) + '</span><span class="goal-text">' + esc(goal.text) + "</span>";
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

	/**
	 * 是否跟随底部：粘性状态，由“用户是否主动向上滚”决定。
	 * 不能用 isNearBottom() 每次重算：用户在距底部 140px 内向上滚时仍会被判为
	 * “在底部”，于是流式 update / append 会把他反复拉回去（表现为“滚不上去”）。
	 * 分片渲染把主线程交还得更早，这个旧行为才变得容易撞上。
	 */
	var followBottom = false;
	var lastScrollY = 0;

	function bottomGap() {
		return (document.body.scrollHeight || 0) - (window.innerHeight + window.scrollY);
	}

	function onScroll() {
		var y = window.scrollY;
		// 向上移 >1px 才算用户主动上滚（避开平滑滚动/锚定修正的抖动）
		if (y < lastScrollY - 1) followBottom = false;
		else if (bottomGap() <= 24) followBottom = true; // 滚回底部才重新跟随
		lastScrollY = y;
	}
	window.addEventListener("scroll", onScroll, { passive: true });

	function scrollToBottom() {
		window.scrollTo(0, document.body.scrollHeight);
		// 程序滚动也会触发 scroll 事件，先同步基准值，避免被 onScroll 误判成用户上滚
		lastScrollY = window.scrollY;
	}

	// ---------- 渲染入口（静态与实时共用） ----------

	/** 给正文里的外链补 target=_blank（# 锚点除外） */
	function markExternalLinks(root) {
		root.querySelectorAll("a[href]").forEach(function (a) {
			var href = a.getAttribute("href") || "";
			if (href.charAt(0) !== "#") {
				a.setAttribute("target", "_blank");
				a.setAttribute("rel", "noreferrer");
			}
		});
	}

	// ---------- 分片渲染 ----------
	// 目的：先出首屏，剩余条目在后台 idle 分批填充，避免一次构造 970 条把主线程占满。
	// 骨架已保证总高度 / #item-N 锚点立即存在，所以分片过程不改变文档高度。
	var CHUNK_FIRST_MIN = 30; // 首屏至少这么多条
	var FIRST_SCREEN_RATIO = 1.5; // 或覆盖约 1.5 屏
	var FIRST_BUDGET_MS = 80; // 首屏硬预算
	var CHUNK_SIZE = 12; // 每批条数上限（实测单条约 1ms）
	var CHUNK_BUDGET_MS = 10; // 每批时间预算（避免 >50ms 长任务）
	var IDLE_TIMEOUT_MS = 400; // requestIdleCallback 兜底超时
	var prog = {
		gen: 0, // 代际：renderAll 时自增，旧队列看到不匹配就退出
		ptr: 0, // 下一个待填充下标
		handle: 0, // rIC / setTimeout handle
		filled: null, // 已填充标记
	};

	function scheduleIdle(cb) {
		if (window.requestIdleCallback) return window.requestIdleCallback(cb, { timeout: IDLE_TIMEOUT_MS });
		return window.setTimeout(function () {
			cb({
				timeRemaining: function () {
					return CHUNK_BUDGET_MS;
				},
			});
		}, 16);
	}
	function cancelIdle(handle) {
		if (!handle) return;
		if (window.cancelIdleCallback) window.cancelIdleCallback(handle);
		else window.clearTimeout(handle);
	}
	function isFilled(idx) {
		return !!(prog.filled && prog.filled[idx]);
	}

	/**
	 * 填充单条（幂等：已填充的会跳过）。把 #item-N 的占位元素换成真实渲染结果。
	 * 内容从 items[idx] 现读 → 写入方先改 items 再调它，不会拿到脏数据。
	 * 分片渲染、appendItem、updateItem 都复用这个函数。
	 */
	function fillItem(idx) {
		if (isFilled(idx)) return;
		var placeholder = document.getElementById("item-" + idx);
		if (!placeholder) return;
		if (prog.filled) prog.filled[idx] = true;
		var box = document.createElement("div");
		box.innerHTML = htmlFor(items[idx], idx);
		var el = box.firstElementChild;
		if (!el) return;
		placeholder.replaceWith(el);
		markExternalLinks(el);
		renderMath(el);
		// 侧栏高亮观察的是元素本身：元素被替换后要重新注册，否则该条不再触发高亮
		if (tocObserver && items[idx] && items[idx].kind === "user") tocObserver.observe(el);
	}

	/** 确保某条已渲染（深链 / 侧栏跳到未填充项时用） */
	function ensureRendered(idx) {
		if (!(idx >= 0) || idx >= items.length) return;
		if (isFilled(idx)) return;
		fillItem(idx);
	}

	/** 跳到未填充项时先把它渲染出来，别停在空白骨架上 */
	function applyHashAnchor() {
		var m = /^#item-(\d+)$/.exec(location.hash || "");
		if (!m) return;
		var idx = parseInt(m[1], 10);
		if (!(idx >= 0) || idx >= items.length) return;
		ensureRendered(idx);
		var el = document.getElementById("item-" + idx);
		if (el && el.scrollIntoView) el.scrollIntoView();
	}
	window.addEventListener("hashchange", applyHashAnchor);

	/** 后台分批填充：条数与时间双重预算，批间让出主线程 */
	function runChunk(gen) {
		if (gen !== prog.gen) return; // 已被新的 renderAll 作废
		var t0 = perfNow();
		var from = prog.ptr;
		var n = 0;
		while (prog.ptr < items.length && n < CHUNK_SIZE && perfNow() - t0 < CHUNK_BUDGET_MS) {
			fillItem(prog.ptr++);
			n++;
		}
		var dt = perfNow() - t0;
		PERF.chunks++;
		if (dt > PERF.maxChunkMs) {
			PERF.maxChunkMs = Math.round(dt * 10) / 10;
			// 诊断：哪一段、多少条造成长任务（单条内部无法切分）
			PERF.slowestChunk = { from: from, to: prog.ptr, items: n, ms: PERF.maxChunkMs };
		}
		if (gen !== prog.gen) return;
		if (prog.ptr < items.length) {
			prog.handle = scheduleIdle(function () {
				runChunk(gen);
			});
		} else {
			prog.handle = 0;
			mark("done");
		}
	}

	function renderAll() {
		var content = document.getElementById("content");
		if (!content) return;
		mark("start");
		// 作废旧队列：init / reset 连续触发时避免两套队列同时填充、错位
		prog.gen++;
		cancelIdle(prog.handle);
		prog.handle = 0;
		prog.ptr = 0;
		prog.filled = Object.create(null);
		PERF.chunks = 0;
		PERF.maxChunkMs = 0;
		// 内容整体换掉后，滚动基准同步一次（用户若在底部，下一次 onScroll 会修正 followBottom）
		lastScrollY = window.scrollY;

		// 1) 占位骨架：总高度 / #item-N 锚点 / 侧栏跳转立即可用（不可见，见 .item-skeleton）
		var skeleton = [];
		for (var i = 0; i < items.length; i++) {
			skeleton.push('<div class="item item-skeleton" id="item-' + i + '" data-idx="' + i + '"></div>');
		}
		content.innerHTML = skeleton.join("\n");
		mark("skeleton");

		// 2) 首屏：条数下限 / 覆盖约 1.5 屏 / 时间预算，三者取先满足者
		var vh = window.innerHeight || 800;
		var t0 = perfNow();
		while (
			prog.ptr < items.length &&
			(prog.ptr < CHUNK_FIRST_MIN || content.scrollHeight < vh * FIRST_SCREEN_RATIO) &&
			perfNow() - t0 < FIRST_BUDGET_MS
		) {
			fillItem(prog.ptr++);
		}
		mark("first");

		// 3) 头部 / 侧栏 / 高亮
		updateHeader();
		buildSidebar();
		mark("sidebar");
		trackActive();
		PERF.items = items.length;
		mark("total");

		// 4) 剩余条目交给后台 idle（首次也让出，让首屏先绘制）
		if (prog.ptr < items.length) {
			prog.handle = scheduleIdle(function () {
				runChunk(prog.gen);
			});
		} else {
			mark("done");
		}

		applyHashAnchor();
	}

	function appendItem(item) {
		var content = document.getElementById("content");
		var idx = items.length;
		items.push(item);
		// 标记已填充，避免分片队列回头把新条目再填一次
		if (prog.filled) prog.filled[idx] = true;
		var keepBottom = followBottom;
		if (content) {
			var wrapper = document.createElement("div");
			wrapper.innerHTML = htmlFor(item, idx);
			var el = wrapper.firstElementChild;
			if (el) {
				content.appendChild(el);
				markExternalLinks(el);
				renderMath(el);
				if (tocObserver && item && item.kind === "user") tocObserver.observe(el);
			}
		}
		updateHeader();
		buildSidebar();
		if (keepBottom) scrollToBottom();
	}

	function updateItem(index, item) {
		if (!(index >= 0) || index >= items.length) return;
		items[index] = item;
		// 还没填充：只写数据，分片稍后自然会读到最新值
		// （原来的 `if (!el) return` 在分片场景下会静默丢掉这次更新）
		if (!isFilled(index)) return;
		var el = document.getElementById("item-" + index);
		if (!el) return;
		var keepBottom = followBottom;
		var wrapper = document.createElement("div");
		wrapper.innerHTML = htmlFor(item, index);
		var next = wrapper.firstElementChild;
		if (!next) return;
		el.replaceWith(next);
		markExternalLinks(next);
		renderMath(next);
		if (tocObserver && item && item.kind === "user") tocObserver.observe(next);
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
					/** 分阶段打点：headless 虚拟时间下不可用，需用真实时钟读 */
					perf: PERF.marks,
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

	// 只暴露实时页面（viewer-live.js）真正用到的接口。
	// 早先为翻译功能额外暴露的 getItems/renderMarkdown/renderMath/itemHtml/esc/timeShort/
	// timeFull/buildSidebar/trackActive/setupXxx/writeDiag 已随翻译移除而删除。
	window.PiPreview = {
		setItems: setItems,
		setMeta: setMeta,
		renderAll: renderAll,
		appendItem: appendItem,
		updateItem: updateItem,
		updateHeader: updateHeader,
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
