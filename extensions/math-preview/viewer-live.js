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
		inputEnabled = !!enabled;
		if (inputEl) {
			inputEl.disabled = !inputEnabled;
			inputEl.placeholder = inputEnabled
				? "输入消息，Enter 发送，Shift+Enter 换行"
				: "输入已在终端锁定：在 pi 里执行 /live input 解锁";
		}
		if (sendBtn) sendBtn.disabled = !inputEnabled || busy;
		if (barEl) barEl.classList.toggle("locked", !inputEnabled);
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
			} else {
				setStatus("发送失败：" + (data.error || res.status), "err");
			}
		} catch (e) {
			setStatus("发送失败：" + (e && e.message ? e.message : e), "err");
		}
		if (sendBtn) sendBtn.disabled = false;
	}

	if (inputEl) {
		inputEl.addEventListener("keydown", function (e) {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				send();
			}
		});
	}
	if (sendBtn) sendBtn.addEventListener("click", send);

	setInputEnabled(false);
	connect();
})();
