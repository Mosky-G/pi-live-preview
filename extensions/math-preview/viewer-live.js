/* 实时页面脚本：SSE 增量渲染 + 输入通道（由 pi 扩展 math-preview 的 /live 命令提供） */
(function () {
	"use strict";
	var P = window.PiPreview;
	if (!P) return;

	var params = new URLSearchParams(location.search);
	var token = params.get("token") || "";
	var inputEl = document.getElementById("live-input");
	var sendBtn = document.getElementById("live-send");
	var statusEl = document.getElementById("live-status");
	var barEl = document.getElementById("live-bar");
	var busy = false;
	var inputEnabled = false;

	function setStatus(text, kind) {
		if (!statusEl) return;
		statusEl.textContent = text || "";
		statusEl.className = "live-status" + (kind ? " " + kind : "");
	}

	function setInputEnabled(enabled) {
		var was = inputEnabled;
		inputEnabled = !!enabled;
		if (inputEl) {
			inputEl.disabled = !inputEnabled;
			inputEl.placeholder = inputEnabled
				? "Enter 发送；Shift / Ctrl / Alt + Enter 换行；Esc 清空"
				: "输入已在终端锁定：在 pi 里执行 /live input 解锁";
		}
		if (sendBtn) sendBtn.disabled = !inputEnabled || busy;
		if (barEl) barEl.classList.toggle("locked", !inputEnabled);
		// 刚解锁时自动聚焦，方便直接打字
		if (inputEnabled && !was && inputEl) inputEl.focus();
	}

	function refreshSendButton() {
		if (sendBtn) sendBtn.disabled = !inputEnabled || busy;
	}

	function handle(msg) {
		switch (msg.type) {
			case "hello":
				P.setMeta(msg.meta || {});
				P.updateHeader();
				setInputEnabled(msg.inputEnabled);
				setStatus(busy ? "生成中…" : "已连接");
				break;
			case "init":
				P.setItems(msg.items || []);
				P.renderAll();
				break;
			case "append":
				P.appendItem(msg.item);
				break;
			case "update":
				P.updateItem(msg.index, msg.item);
				break;
			case "input":
				setInputEnabled(msg.enabled);
				setStatus(msg.enabled ? "输入已解锁" : "输入已锁定");
				refreshSendButton();
				break;
			case "status":
				busy = !!msg.busy;
				setStatus(busy ? "生成中…" : "就绪");
				refreshSendButton();
				break;
			case "info":
				setStatus(msg.text || "");
				break;
		}
	}

	function connect() {
		if (!token) {
			setStatus("缺少访问令牌（请用终端里输出的完整地址打开页面）", "err");
			return;
		}
		var es = new EventSource("/events?token=" + encodeURIComponent(token));
		es.addEventListener("open", function () {
			setStatus("已连接");
		});
		es.addEventListener("error", function () {
			setStatus("连接断开，正在重试…", "err");
		});
		es.addEventListener("message", function (ev) {
			var msg;
			try {
				msg = JSON.parse(ev.data);
			} catch (e) {
				return;
			}
			handle(msg);
		});
		window.addEventListener("beforeunload", function () {
			es.close();
		});
	}

	async function send() {
		if (!inputEl || !inputEnabled || busy) return;
		var text = String(inputEl.value || "").trim();
		if (!text) return;
		if (sendBtn) sendBtn.disabled = true;
		try {
			var res = await fetch("/prompt?token=" + encodeURIComponent(token), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: text }),
			});
			var data = await res.json().catch(function () {
				return {};
			});
			if (res.ok && data.ok) {
				inputEl.value = "";
				setStatus("已发送");
				inputEl.focus();
			} else {
				setStatus("发送失败：" + (data.error || res.status), "err");
			}
		} catch (e) {
			setStatus("发送失败：" + (e && e.message ? e.message : e), "err");
		}
		if (sendBtn) sendBtn.disabled = false;
	}

	/** 在光标处插入换行（Chromium 里 Ctrl / Alt + Enter 没有默认行为，需要手动插） */
	function insertNewline(el) {
		var start = el.selectionStart;
		var end = el.selectionEnd;
		var ok = false;
		try {
			ok = document.execCommand("insertText", false, "\n");
		} catch (e) {
			ok = false;
		}
		if (!ok) {
			el.value = el.value.slice(0, start) + "\n" + el.value.slice(end);
			el.selectionStart = el.selectionEnd = start + 1;
		}
	}

	/**
	 * 换行后光标会移到下一行，但浏览器不会自动把可视区跟过去（要再敲一个字才跳）。
	 * 光标在末尾时直接把输入框滚到底。
	 */
	function keepCaretVisible(el) {
		if (!el) return;
		var atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
		if (atEnd) el.scrollTop = el.scrollHeight;
	}

	if (inputEl) {
		inputEl.addEventListener("keydown", function (e) {
			if (e.key === "Escape") {
				if (inputEl.value) {
					inputEl.value = "";
					e.preventDefault();
				}
				return;
			}
			if (e.key !== "Enter") return;
			if (e.shiftKey) {
				// 交给浏览器默认行为（换行），下一帧再把可视区滚到光标旁
				setTimeout(function () {
					keepCaretVisible(inputEl);
				}, 0);
				return;
			}
			if (e.ctrlKey || e.metaKey || e.altKey) {
				e.preventDefault();
				insertNewline(inputEl);
				keepCaretVisible(inputEl);
				return;
			}
			e.preventDefault();
			send();
		});
		// 普通输入 / 粘贴后也顺手补一下（浏览器多数情况会自动滚，这里只是兜底）
		inputEl.addEventListener("input", function () {
			keepCaretVisible(inputEl);
		});
	}
	if (sendBtn) sendBtn.addEventListener("click", send);

	/** 输入框上缘拖拽：调整高度，结果记在 localStorage（和侧栏宽度同一套习惯） */
	function setupLiveResizer() {
		var resizer = document.getElementById("live-resizer");
		if (!resizer || !inputEl) return;
		var KEY = "pi-preview-live-height";
		var MIN_H = 38;
		var dragging = false;
		var startY = 0;
		var startH = 0;
		var curH = 0;
		var maxH = function () {
			return Math.max(MIN_H, Math.round((window.innerHeight || 800) * 0.6));
		};
		var clampH = function (h) {
			return Math.min(Math.max(h, MIN_H), maxH());
		};
		var applyH = function (h) {
			document.documentElement.style.setProperty("--live-h", h + "px");
			return h;
		};
		var saved = 0;
		try {
			saved = parseInt(localStorage.getItem(KEY) || "0", 10) || 0;
		} catch (e) {
			/* 忽略 */
		}
		if (saved >= MIN_H) curH = applyH(clampH(saved));

		resizer.addEventListener("mousedown", function (e) {
			dragging = true;
			startY = e.clientY;
			startH = inputEl.getBoundingClientRect().height;
			document.body.classList.add("live-resizing");
			e.preventDefault();
		});
		window.addEventListener("mousemove", function (e) {
			if (!dragging) return;
			curH = applyH(clampH(Math.round(startH - (e.clientY - startY))));
		});
		window.addEventListener("mouseup", function () {
			if (!dragging) return;
			dragging = false;
			document.body.classList.remove("live-resizing");
			if (curH) {
				try {
					localStorage.setItem(KEY, String(curH));
				} catch (e) {
					/* 忽略 */
				}
			}
		});
		window.addEventListener("resize", function () {
			if (curH) curH = applyH(clampH(curH));
		});
	}

	setInputEnabled(false);
	setupLiveResizer();
	connect();
})();
