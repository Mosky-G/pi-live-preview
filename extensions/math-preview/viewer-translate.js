/* 翻译前端（独立文件，仅在 settings 打开 translate 时由 render.ts 注入）
   阶段一（当前）：点「译」→ 右下角浮层流式显示译文 + localStorage 缓存
   阶段二（下一步）：可拖动/吸附的悬浮窗、批量、重译、消耗统计
   注意：译文只显示在页面上，不会写回 pi 的会话 */
(function () {
	"use strict";
	var P = window.PiPreview;
	if (!P) return;

	var params = new URLSearchParams(location.search);
	var TOKEN = params.get("token") || "";
	var IS_LIVE = !!window.__PI_LIVE_MODE__;
	var LANG = "简体中文";

	var overlayEl = null;
	var current = null; // { blockId, btn, block, text }
	var cacheHits = 0;

	function esc(s) {
		return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
		});
	}

	/** 译文按纯文本渲染（只保留换行），不做 Markdown/HTML，避免模型输出注入页面 */
	function renderTranslated(text) {
		return esc(text).replace(/\n/g, "<br>");
	}

	function simpleHash(s) {
		var h = 5381;
		for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
		return (h >>> 0).toString(36);
	}
	function cacheKey(text) {
		return "pi-tr:" + LANG + ":" + simpleHash(text);
	}
	function readCache(key) {
		try {
			var v = localStorage.getItem(key);
			if (v) cacheHits++;
			return v;
		} catch (e) {
			return null;
		}
	}
	function writeCache(key, text) {
		try {
			localStorage.setItem(key, text);
			// 简单的容量控制：超过 120 条时清掉最早的若干条
			var keys = [];
			for (var i = 0; i < localStorage.length; i++) {
				var k = localStorage.key(i);
				if (k && k.indexOf("pi-tr:") === 0) keys.push(k);
			}
			if (keys.length > 120) {
				for (var j = 0; j < keys.length - 120; j++) localStorage.removeItem(keys[j]);
			}
		} catch (e) {
			/* 隐私模式下可能不可用 */
		}
	}

	// ---------- 浮层 ----------
	function ensureOverlay() {
		if (overlayEl) return overlayEl;
		overlayEl = document.createElement("div");
		overlayEl.id = "pi-translate-overlay";
		overlayEl.hidden = true;
		overlayEl.innerHTML =
			'<div class="pi-tr-head">' +
			'<span class="pi-tr-title">译文</span>' +
			'<span class="pi-tr-status"></span>' +
			'<button class="pi-tr-copy" type="button" title="复制译文">复制</button>' +
			'<button class="pi-tr-close" type="button" title="关闭">×</button>' +
			"</div>" +
			'<div class="pi-tr-body"></div>';
		document.body.appendChild(overlayEl);
		overlayEl.querySelector(".pi-tr-close").addEventListener("click", function () {
			overlayEl.hidden = true;
		});
		overlayEl.querySelector(".pi-tr-copy").addEventListener("click", function () {
			var body = overlayEl.querySelector(".pi-tr-body");
			var text = body ? body.innerText : "";
			if (!text) return;
			try {
				navigator.clipboard.writeText(text);
				setStatus("已复制");
			} catch (e) {
				setStatus("复制失败");
			}
		});
		return overlayEl;
	}
	function setStatus(text) {
		var el = ensureOverlay().querySelector(".pi-tr-status");
		if (el) el.textContent = text || "";
	}
	function openOverlay(title, html) {
		var el = ensureOverlay();
		el.hidden = false;
		el.querySelector(".pi-tr-title").textContent = title;
		el.querySelector(".pi-tr-body").innerHTML = html;
		setStatus("");
	}
	function appendDelta(delta) {
		var el = ensureOverlay();
		var body = el.querySelector(".pi-tr-body");
		body.innerHTML += renderTranslated(delta);
		body.scrollTop = body.scrollHeight;
	}

	// ---------- 采集可翻译块 ----------
	function collectBlocks() {
		var out = [];
		var items = document.querySelectorAll("#content .item");
		Array.prototype.forEach.call(items, function (item) {
			var thinking = item.querySelector(".thinking-body");
			if (thinking) out.push(thinking);
			var body = item.querySelector(":scope > .md");
			if (body) out.push(body);
		});
		return out
			.map(function (el) {
				return { el: el, text: String(el.innerText || el.textContent || "").trim() };
			})
			.filter(function (b) {
				return b.text.length >= 2;
			});
	}

	function instrument() {
		collectBlocks().forEach(function (block, i) {
			if (block.el.dataset.piBlock) return;
			block.el.dataset.piBlock = "b" + i;
			block.el.classList.add("pi-translatable");
			var btn = document.createElement("button");
			btn.type = "button";
			btn.className = "pi-translate-btn";
			btn.textContent = "译";
			btn.title = IS_LIVE ? "翻译这一段（" + LANG + "）" : "翻译需要先在 pi 里执行 /live";
			btn.addEventListener("click", function (e) {
				e.preventDefault();
				e.stopPropagation();
				requestTranslate(block, btn);
			});
			block.el.insertBefore(btn, block.el.firstChild);
		});
	}

	// ---------- 发起翻译 ----------
	function requestTranslate(block, btn) {
		var text = block.text;
		if (!text) return;
		var key = cacheKey(text);
		var cached = readCache(key);
		if (cached) {
			openOverlay("译文（缓存）", renderTranslated(cached));
			btn.textContent = "已译";
			btn.classList.add("done");
			return;
		}
		if (!IS_LIVE || !TOKEN) {
			openOverlay("无法翻译", '<span class="pi-tr-error">翻译需要本地服务：请在 pi 里执行 /live，然后从终端输出的地址打开实时页面（静态快照页不支持）。</span>');
			return;
		}
		var blockId = block.el.dataset.piBlock;
		current = { blockId: blockId, btn: btn, block: block, text: text, out: "" };
		btn.disabled = true;
		btn.textContent = "译…";
		openOverlay("译文（生成中…）", "");
		fetch("/translate?token=" + encodeURIComponent(TOKEN), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ blockId: blockId, text: text, targetLang: LANG }),
		})
			.then(function (r) {
				return r.text().then(function (body) {
					var j = null;
					try {
						j = JSON.parse(body);
					} catch (e) {
						j = null;
					}
					if (!j) {
						// 不是 JSON：多半是 404 页面（当前服务没有翻译路由）
						openOverlay(
							"翻译失败（HTTP " + r.status + "）",
							'<span class="pi-tr-error">服务未返回 JSON。如果是 404，说明这个 /live 服务还没有翻译路由——请在 pi 里重新执行 /live off 然后 /live（服务需要重建一次）。</span>',
						);
						if (current && current.btn) {
							current.btn.disabled = false;
							current.btn.textContent = "译";
						}
						current = null;
						return;
					}
					if (!j.ok) {
						openOverlay("翻译失败", '<span class="pi-tr-error">' + esc(j.error || "未知错误") + "</span>");
						if (current && current.btn) {
							current.btn.disabled = false;
							current.btn.textContent = "译";
						}
						current = null;
					} else if (j.model) {
						setStatus(j.model);
					}
				});
			})
			.catch(function (e) {
				openOverlay("翻译失败", '<span class="pi-tr-error">' + esc(e && e.message ? e.message : e) + "</span>");
				btn.disabled = false;
				btn.textContent = "译";
				current = null;
			});
	}

	// ---------- SSE 事件（由 viewer-live.js 转发过来） ----------
	window.PiTranslate = {
		handleEvent: function (msg) {
			if (!msg || !current || msg.blockId !== current.blockId) return;
			if (msg.type === "translate") {
				current.out += msg.delta || "";
				appendDelta(msg.delta || "");
			} else if (msg.type === "translate-done") {
				current.out = msg.text || current.out;
				openOverlay("译文" + (msg.ms ? "（" + (msg.ms / 1000).toFixed(1) + "s）" : ""), renderTranslated(current.out));
				writeCache(cacheKey(current.text), current.out);
				if (current.btn) {
					current.btn.disabled = false;
					current.btn.textContent = "已译";
					current.btn.classList.add("done");
				}
				current = null;
			} else if (msg.type === "translate-error") {
				openOverlay("翻译失败", '<span class="pi-tr-error">' + esc(msg.error || "未知错误") + "</span>");
				if (current.btn) {
					current.btn.disabled = false;
					current.btn.textContent = "译";
				}
				current = null;
			}
		},
	};

	// 内容更新后（实时页面持续追加）补挂按钮
	var timer = setInterval(instrument, 2000);
	window.addEventListener("beforeunload", function () {
		clearInterval(timer);
	});
	instrument();
})();
