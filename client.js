window.__ModuleLoader__.load({
	id: "dsh-manus-llm",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		const react = require("react");
		const jsx = require("react/jsx-runtime");
		const reactDom = require("react-dom");

		/** Host route the readout polls (registered by index.js). */
		const CREDITS_PATH = "/plugins/manus-llm/credits";
		/** Host routes behind the settings page (registered by index.js). */
		const CONFIG_PATH = "/plugins/manus-llm/config";
		const CREDENTIAL_PATH = "/plugins/manus-llm/credential";
		const TEST_PATH = "/plugins/manus-llm/test";
		/** The provider route key this plugin owns. */
		const PROVIDER = "manus";
		/** Balance refresh cadence: a balance moves only when a turn spends. */
		const REFRESH_INTERVAL_MS = 60000;
		/** Settings namespace for the client-side copy. */
		const NAMESPACE = "manus-llm";

		/** Per-tier context window choices offered on the models tab. */
		const CONTEXT_OPTIONS = [200000, 500000, 1000000];
		/** Runtime fields shown on the account tab (compact layout). */
		const RUNTIME_NUMBERS = [
			["pollIntervalMs", 500, 30000],
			["pollMaxSeconds", 30, 86400],
			["requestTimeoutMs", 5000, 300000],
			["maxTokens", 100, undefined]
		];
		const RUNTIME_BOOLEANS = ["trackCredits", "showProgress", "verboseEvents"];

		const zh = {
			"credits.label": "积分",
			"credits.unknown": "—",
			"credits.missingKey": "未配置 Key",
			"credits.title": "Manus 积分",
			"credits.total": "总积分",
			"credits.free": "赠送积分",
			"credits.periodic": "周期积分",
			"credits.addon": "附加积分",
			"credits.lastTurn": "本轮消耗",
			"credits.nextRefresh": "下次刷新",
			"credits.refresh": "刷新",
			"credits.loading": "加载中",
			"credits.failed": "读取失败",
			"credits.empty": "暂无数据",
			"credits.hint": "积分余额来自 Manus，每轮对话后会更新。",

			"settings.nav": "Manus",
			"settings.title": "Manus 模型配置",
			"settings.desc": "配置 Manus 的 API Key、模型上下文窗口与运行参数。",
			"settings.tab.models": "模型",
			"settings.tab.account": "账号",

			"settings.models.title": "模型与上下文窗口",
			"settings.models.desc": "为每个模型档位单独选择上下文窗口，保存后立即生效。",
			"settings.models.context": "上下文窗口",
			"settings.models.save": "保存模型配置",
			"settings.models.saved": "模型配置已保存。",
			"settings.models.hint": "上下文窗口只影响 DSH 侧的预算显示；Manus 云端 agent 的实际上限由服务端决定。",

			"settings.key.section": "API Key",
			"settings.key.label": "API Key",
			"settings.key.placeholder": "粘贴 Manus API Key",
			"settings.key.configured": "已配置（来源：{source}）",
			"settings.key.missing": "未配置",
			"settings.key.save": "保存 Key",
			"settings.key.clear": "清除",
			"settings.key.saved": "API Key 已保存。",
			"settings.key.cleared": "API Key 已清除。",
			"settings.key.empty": "API Key 不能为空。",
			"settings.key.hint": "Key 保存在本机凭证库，不会离开 DSH 宿主进程。",
			"settings.key.env": "凭证引用名",
			"settings.key.test": "检测连接",
			"settings.key.testing": "检测中…",
			"settings.key.connected": "已连接 · 余额 {total}",
			"settings.key.disconnected": "未连接",
			"settings.key.untested": "尚未检测",
			"settings.key.testFailed": "连接失败：{message}",

			"settings.account.title": "账号与运行参数",
			"settings.account.default": "默认模型档位",
			"settings.account.locale": "任务语言",
			"settings.account.creditPosition": "积分显示位置",
			"settings.account.creditPositionComposer": "对话工具栏",
			"settings.account.creditPositionDock": "对话工具栏下方",
			"settings.account.runtime": "运行参数",
			"settings.account.save": "保存设置",
			"settings.account.saved": "设置已保存。",

			"settings.field.locale": "任务语言",
			"settings.field.pollIntervalMs": "轮询间隔（毫秒）",
			"settings.field.pollMaxSeconds": "任务最长等待（秒）",
			"settings.field.requestTimeoutMs": "单次请求超时（毫秒）",
			"settings.field.maxTokens": "最大输出 Token",
			"settings.field.trackCredits": "统计积分消耗",
			"settings.field.showProgress": "显示进度消息",
			"settings.field.verboseEvents": "记录详细事件",

			"settings.save": "保存",
			"settings.saved": "已保存。",
			"settings.reset": "重置",
			"settings.loading": "加载中…",
			"settings.loadFailed": "读取配置失败：{message}",
			"settings.saveFailed": "保存失败：{message}",
			"settings.conflict": "配置已被其它窗口修改，已重新读取，请再次保存。",
			"settings.unsaved": "有未保存的修改。"
		};

		const en = {
			"credits.label": "Credits",
			"credits.unknown": "—",
			"credits.missingKey": "No API key",
			"credits.title": "Manus credits",
			"credits.total": "Total",
			"credits.free": "Free",
			"credits.periodic": "Periodic",
			"credits.addon": "Add-on",
			"credits.lastTurn": "Last turn",
			"credits.nextRefresh": "Next refresh",
			"credits.refresh": "Refresh",
			"credits.loading": "Loading",
			"credits.failed": "Read failed",
			"credits.empty": "No data",
			"credits.hint": "Balance comes from Manus and updates after each turn.",

			"settings.nav": "Manus",
			"settings.title": "Manus model configuration",
			"settings.desc": "Configure the Manus API key, per-model context windows and runtime options.",
			"settings.tab.models": "Models",
			"settings.tab.account": "Account",

			"settings.models.title": "Models and context windows",
			"settings.models.desc": "Pick a context window per model tier; saving applies immediately.",
			"settings.models.context": "Context window",
			"settings.models.save": "Save model settings",
			"settings.models.saved": "Model settings saved.",
			"settings.models.hint": "The context window only affects the DSH-side budget display; Manus cloud limits are set server-side.",

			"settings.key.section": "API key",
			"settings.key.label": "API key",
			"settings.key.placeholder": "Paste the Manus API key",
			"settings.key.configured": "Configured (source: {source})",
			"settings.key.missing": "Not configured",
			"settings.key.save": "Save key",
			"settings.key.clear": "Clear",
			"settings.key.saved": "API key saved.",
			"settings.key.cleared": "API key cleared.",
			"settings.key.empty": "The API key cannot be empty.",
			"settings.key.hint": "The key is stored in the local credential store and never leaves the DSH host process.",
			"settings.key.env": "Credential reference",
			"settings.key.test": "Test connection",
			"settings.key.testing": "Testing…",
			"settings.key.connected": "Connected · {total} credits",
			"settings.key.disconnected": "Not connected",
			"settings.key.untested": "Not tested yet",
			"settings.key.testFailed": "Connection failed: {message}",

			"settings.account.title": "Account and runtime",
			"settings.account.default": "Default model tier",
			"settings.account.locale": "Task locale",
			"settings.account.creditPosition": "Credits position",
			"settings.account.creditPositionComposer": "Composer toolbar",
			"settings.account.creditPositionDock": "Below the composer",
			"settings.account.runtime": "Runtime options",
			"settings.account.save": "Save settings",
			"settings.account.saved": "Settings saved.",

			"settings.field.locale": "Task locale",
			"settings.field.pollIntervalMs": "Poll interval (ms)",
			"settings.field.pollMaxSeconds": "Max task wait (s)",
			"settings.field.requestTimeoutMs": "Request timeout (ms)",
			"settings.field.maxTokens": "Max output tokens",
			"settings.field.trackCredits": "Track credit spend",
			"settings.field.showProgress": "Show progress messages",
			"settings.field.verboseEvents": "Log verbose events",

			"settings.save": "Save",
			"settings.saved": "Saved.",
			"settings.reset": "Reset",
			"settings.loading": "Loading…",
			"settings.loadFailed": "Failed to read config: {message}",
			"settings.saveFailed": "Failed to save: {message}",
			"settings.conflict": "The config changed in another window; it was reloaded, please save again.",
			"settings.unsaved": "Unsaved changes."
		};

		const CSS = `
.dsm-manus-credits{display:inline-flex;align-items:center;min-width:0;max-width:100%}
.dsm-manus-credits-trigger{display:inline-flex;align-items:center;gap:5px;appearance:none;padding:2px 6px;border:0;border-radius:6px;background:transparent;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap;cursor:pointer;font-variant-numeric:tabular-nums;max-width:100%}
.dsm-manus-credits-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsm-manus-credits-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-manus-credits-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e)}
.dsm-manus-credits-dot[data-tone="warn"]{background:var(--dsw-alias-state-warn-secondary,#fbbf24)}
.dsm-manus-credits-dot[data-tone="error"]{background:var(--dsw-alias-state-error-primary,#d92d20)}
.dsm-manus-credits-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dsm-manus-credits-panel{position:fixed;z-index:1100;box-sizing:border-box;width:min(248px,calc(100vw - 24px));padding:12px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:var(--dsw-radius-lg,14px);background:var(--dsw-specific-menu,Canvas);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.16));font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#444)}
.dsm-manus-credits-head{display:flex;align-items:center;justify-content:space-between;padding-bottom:8px;margin-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));font-weight:600;color:var(--dsw-alias-label-primary,#111)}
.dsm-manus-credits-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:3px 0}
.dsm-manus-credits-key{color:var(--dsw-alias-label-tertiary,#999)}
.dsm-manus-credits-value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#111)}
.dsm-manus-credits-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:8px;margin-top:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24))}
.dsm-manus-credits-action{appearance:none;padding:2px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:6px;background:transparent;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#444);cursor:pointer}
.dsm-manus-credits-error{color:var(--dsw-alias-state-error-primary,#d92d20)}
.dsm-manus-credits-hint{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}
.dsm-manus-settings{display:flex;flex-direction:column;gap:12px;padding:2px 2px 16px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#444)}
.dsm-manus-settings-head{display:flex;flex-direction:column;gap:2px}
.dsm-manus-settings-title{font-size:15px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}
.dsm-manus-settings-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-manus-tabs{display:flex;gap:4px;padding:3px;border-radius:10px;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.08));align-self:flex-start}
.dsm-manus-tab{appearance:none;padding:4px 14px;border:0;border-radius:8px;background:transparent;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#444);cursor:pointer}
.dsm-manus-tab[data-active="true"]{background:var(--dsw-specific-menu,Canvas);color:var(--dsw-alias-label-primary,#111);box-shadow:var(--dsw-elevation-subtle,0 1px 2px rgba(0,0,0,.08))}
.dsm-manus-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-manus-settings-group{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:var(--dsw-radius-lg,14px);background:var(--dsw-alias-bg-l1,transparent)}
.dsm-manus-settings-group-title{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}
.dsm-manus-settings-field{display:flex;flex-direction:column;gap:4px}
.dsm-manus-settings-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#444)}
.dsm-manus-settings-control{box-sizing:border-box;width:100%;padding:5px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:8px;background:var(--dsw-alias-bg-l1,Canvas);font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#111)}
.dsm-manus-settings-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dsm-manus-settings-check{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px}
.dsm-manus-settings-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-manus-settings-state{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-manus-settings-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e)}
.dsm-manus-settings-dot[data-tone="warn"]{background:var(--dsw-alias-state-warn-secondary,#fbbf24)}
.dsm-manus-settings-dot[data-tone="error"]{background:var(--dsw-alias-state-error-primary,#d92d20)}
.dsm-manus-model{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16))}
.dsm-manus-model:last-child{border-bottom:0}
.dsm-manus-model-main{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsm-manus-model-name{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}
.dsm-manus-model-desc{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-manus-segmented{display:inline-flex;flex:none;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.08))}
.dsm-manus-segment{appearance:none;padding:3px 9px;border:0;border-radius:6px;background:transparent;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#444);cursor:pointer;font-variant-numeric:tabular-nums}
.dsm-manus-segment[data-active="true"]{background:var(--dsw-specific-menu,Canvas);color:var(--dsw-alias-label-primary,#111);font-weight:600}
.dsm-manus-segment:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-manus-settings-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsm-manus-settings-button{appearance:none;padding:5px 14px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:8px;background:transparent;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#111);cursor:pointer}
.dsm-manus-settings-button[data-variant="primary"]{border-color:transparent;background:var(--dsw-alias-brand-primary,#5686fe);color:#fff}
.dsm-manus-settings-button[data-variant="danger"]{border-color:transparent;background:transparent;color:var(--dsw-alias-state-error-primary,#d92d20)}
.dsm-manus-settings-button:disabled{opacity:.5;cursor:default}
.dsm-manus-settings-feedback{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-manus-settings-feedback[data-tone="ok"]{color:var(--dsw-alias-state-success-primary,#22c55e)}
.dsm-manus-settings-feedback[data-tone="error"]{color:var(--dsw-alias-state-error-primary,#d92d20)}
.dsm-manus-settings-feedback[data-tone="warn"]{color:var(--dsw-alias-state-warn-secondary,#fbbf24)}
`;

		if (typeof document !== "undefined") {
			const cssId = "dsh-manus-llm/credits.css";
			if (!document.querySelector(`style[data-plugin-css=${JSON.stringify(cssId)}]`)) {
				const styleTag = document.createElement("style");
				styleTag.dataset.plugin = "dsh-manus-llm";
				styleTag.dataset.pluginCss = cssId;
				styleTag.textContent = CSS;
				document.head.appendChild(styleTag);
			}
		}

		/** Distance the panel must stay from the viewport top (frame chrome). */
		function overlayTopMargin(min) {
			try {
				const root = document.documentElement;
				const raw = getComputedStyle(root).getPropertyValue("--dsh-frame-top-clearance");
				const clearance = Number.parseFloat(raw);
				if (!Number.isFinite(clearance)) return min;
				const fullscreen = root.hasAttribute("data-fullscreen");
				return Math.max(min, (fullscreen ? 0 : clearance) + 20);
			} catch {
				return min;
			}
		}

		/** Place a portal panel above its anchor, clamped to the viewport. */
		function useAnchoredPosition({ open, anchorRef, panelRef, gap = 8, margin = 12 }) {
			const [position, setPosition] = react.useState(undefined);
			react.useLayoutEffect(() => {
				if (!open) {
					setPosition(undefined);
					return;
				}
				const place = () => {
					const anchor = anchorRef.current;
					const panel = panelRef.current;
					if (!anchor || !panel) return;
					const rect = anchor.getBoundingClientRect();
					const width = panel.offsetWidth;
					const height = panel.offsetHeight;
					const left = Math.min(Math.max(rect.left, margin), window.innerWidth - width - margin);
					const top = Math.min(Math.max(rect.top - gap - height, overlayTopMargin(margin)), window.innerHeight - height - margin);
					setPosition({ left, top });
				};
				place();
				window.addEventListener("scroll", place, true);
				window.addEventListener("resize", place);
				const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : undefined;
				if (panelRef.current) observer?.observe(panelRef.current);
				return () => {
					window.removeEventListener("scroll", place, true);
					window.removeEventListener("resize", place);
					observer?.disconnect();
				};
			}, [open, anchorRef, panelRef, gap, margin]);
			return position;
		}

		/** Close a popover when a pointer lands outside both anchor and portal. */
		function useDismissOnOutsidePointer(rootRef, open, close, portalRef) {
			react.useEffect(() => {
				if (!open) return;
				const onPointerDown = (event) => {
					const target = event.target;
					if (!(target instanceof Node)) return;
					if (rootRef.current?.contains(target) === true) return;
					if (portalRef?.current?.contains(target) === true) return;
					close();
				};
				document.addEventListener("pointerdown", onPointerDown);
				return () => document.removeEventListener("pointerdown", onPointerDown);
			}, [open, rootRef, close, portalRef]);
		}

		/** Compact credit numbers: 1234.5 → 1.2k. */
		function formatCredits(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
			const rounded = Math.round(value * 10) / 10;
			if (Math.abs(rounded) < 1000) return String(rounded);
			return `${Math.round(rounded / 100) / 10}k`;
		}

		/** Unix seconds → local date-time string. */
		function formatTime(unixSeconds) {
			if (typeof unixSeconds !== "number" || unixSeconds <= 0) return undefined;
			try {
				return new Date(unixSeconds * 1000).toLocaleString();
			} catch {
				return undefined;
			}
		}

		/** 200000 → "200k", 1000000 → "1M". */
		function formatWindow(value) {
			if (value >= 1000000) return `${value / 1000000}M`;
			return `${value / 1000}k`;
		}

		/**
		 * Credits readout. The trigger keeps a stable width (ellipsis instead of
		 * growth) and, when no key is configured, says so in words instead of
		 * repeating the label.
		 */
		function ManusCredits({ t, sessionId, useSession }) {
			const [state, setState] = react.useState({ status: "idle", credits: undefined, lastTurn: undefined, code: undefined, error: undefined });
			const [open, setOpen] = react.useState(false);
			const rootRef = react.useRef(null);
			const panelRef = react.useRef(null);
			const inFlight = react.useRef(false);
			const mounted = react.useRef(false);

			const load = react.useCallback(async () => {
				if (inFlight.current) return;
				inFlight.current = true;
				try {
					const response = await fetch(`${CREDITS_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
						headers: { accept: "application/json" },
						credentials: "same-origin"
					});
					const body = await response.json().catch(() => undefined);
					if (!mounted.current) return;
					if (!response.ok || body?.ok !== true) {
						setState({
							status: "failed",
							credits: undefined,
							lastTurn: undefined,
							code: body?.error?.code,
							error: body?.error?.message ?? `HTTP ${response.status}`
						});
						return;
					}
					setState({ status: "ready", credits: body.credits, lastTurn: body.lastTurn, code: undefined, error: undefined });
				} catch (error) {
					if (!mounted.current) return;
					setState({ status: "failed", credits: undefined, lastTurn: undefined, code: undefined, error: error instanceof Error ? error.message : String(error) });
				} finally {
					inFlight.current = false;
				}
			}, [sessionId]);

			react.useEffect(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);

			react.useEffect(() => {
				load();
				const ticker = window.setInterval(load, REFRESH_INTERVAL_MS);
				return () => window.clearInterval(ticker);
			}, [load]);

			const running = useSession?.((snapshot) => snapshot.running === true) === true;
			react.useEffect(() => {
				if (running) return;
				const timer = window.setTimeout(load, 1200);
				return () => window.clearTimeout(timer);
			}, [running, load]);

			react.useEffect(() => {
				if (!open) return;
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("keydown", onKeyDown);
				return () => document.removeEventListener("keydown", onKeyDown);
			}, [open]);

			const position = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, gap: 8, margin: 12 });
			const close = react.useCallback(() => setOpen(false), []);
			useDismissOnOutsidePointer(rootRef, open, close, panelRef);

			if (state.status === "idle") return null;

			const missingKey = state.code === "missing-credential";
			const total = state.credits?.total;
			const label = t("credits.label");
			const valueText = missingKey
				? t("credits.missingKey")
				: typeof total === "number"
					? formatCredits(total)
					: state.status === "failed"
						? t("credits.failed")
						: t("credits.unknown");
			const tone = missingKey ? "warn" : state.status === "failed" ? "error" : typeof total === "number" && total <= 0 ? "warn" : "ok";
			const title = missingKey ? `${label} · ${t("credits.missingKey")}` : state.status === "failed" ? `${label} · ${state.error}` : t("credits.title");

			const rows = [];
			if (typeof total === "number") rows.push({ key: "credits.total", value: String(Math.round(total * 10) / 10) });
			if (typeof state.credits?.free === "number") rows.push({ key: "credits.free", value: String(Math.round(state.credits.free)) });
			if (typeof state.credits?.periodic === "number") rows.push({ key: "credits.periodic", value: String(Math.round(state.credits.periodic)) });
			if (typeof state.credits?.addon === "number" && state.credits.addon > 0) rows.push({ key: "credits.addon", value: String(Math.round(state.credits.addon)) });
			if (typeof state.lastTurn?.spent === "number") rows.push({ key: "credits.lastTurn", value: `−${Math.round(state.lastTurn.spent)}` });
			const nextRefresh = formatTime(state.credits?.nextRefresh);

			return jsx.jsxs("span", {
				ref: rootRef,
				className: "dsm-manus-credits",
				children: [
					jsx.jsxs("button", {
						type: "button",
						className: "dsm-manus-credits-trigger",
						"aria-haspopup": "dialog",
						"aria-expanded": open,
						title,
						onClick: () => setOpen((current) => !current),
						children: [
							jsx.jsx("span", { className: "dsm-manus-credits-dot", "data-tone": tone }),
							jsx.jsx("span", { className: "dsm-manus-credits-text", children: `${label} ${valueText}` })
						]
					}),
					open
						? reactDom.createPortal(
							jsx.jsxs("div", {
								ref: panelRef,
								className: "dsm-manus-credits-panel",
								style: position ?? { visibility: "hidden", left: 0, top: 0 },
								role: "dialog",
								"aria-label": t("credits.title"),
								children: [
									jsx.jsxs("div", {
										className: "dsm-manus-credits-head",
										children: [
											jsx.jsx("span", { children: t("credits.title") }),
											jsx.jsx("span", { className: "dsm-manus-credits-dot", "data-tone": tone })
										]
									}),
									missingKey
										? jsx.jsx("div", { className: "dsm-manus-credits-error", children: t("credits.missingKey") })
										: state.status === "failed"
											? jsx.jsx("div", { className: "dsm-manus-credits-error", children: state.error })
											: rows.length === 0
												? jsx.jsx("div", { className: "dsm-manus-credits-hint", children: t("credits.empty") })
												: rows.map((row) =>
													jsx.jsxs("div", {
														className: "dsm-manus-credits-row",
														children: [
															jsx.jsx("span", { className: "dsm-manus-credits-key", children: t(row.key) }),
															jsx.jsx("span", { className: "dsm-manus-credits-value", children: row.value })
														]
													}, row.key)
												),
									nextRefresh === undefined
										? null
										: jsx.jsxs("div", {
											className: "dsm-manus-credits-row",
											children: [
												jsx.jsx("span", { className: "dsm-manus-credits-key", children: t("credits.nextRefresh") }),
												jsx.jsx("span", { className: "dsm-manus-credits-value", children: nextRefresh })
											]
										}),
									jsx.jsxs("div", {
										className: "dsm-manus-credits-foot",
										children: [
											jsx.jsx("span", { className: "dsm-manus-credits-hint", children: t("credits.hint") }),
											jsx.jsx("button", {
												type: "button",
												className: "dsm-manus-credits-action",
												onClick: () => load(),
												children: t("credits.refresh")
											})
										]
									})
								]
							}),
							document.body
						)
						: null
				]
			});
		}

		/** Label + control + hint stack used by the settings page. */
		function Field({ label, hint, children }) {
			return jsx.jsxs("label", {
				className: "dsm-manus-settings-field",
				children: [
					jsx.jsx("span", { className: "dsm-manus-settings-label", children: label }),
					children,
					hint === undefined ? null : jsx.jsx("span", { className: "dsm-manus-settings-hint", children: hint })
				]
			});
		}

		/**
		 * The Manus settings page: a models tab (per-tier context windows) and an
		 * account tab (API key, locale, credits position, compact runtime options).
		 */
		function ManusSettings({ t }) {
			const [tab, setTab] = react.useState("models");
			const [config, setConfig] = react.useState({ status: "loading", revision: undefined, values: {}, credential: undefined, models: [], error: undefined });
			const [draft, setDraft] = react.useState({});
			const [contexts, setContexts] = react.useState({});
			const [keyValue, setKeyValue] = react.useState("");
			const [feedback, setFeedback] = react.useState(undefined);
			const [probe, setProbe] = react.useState({ status: "idle", ok: undefined, total: undefined, message: undefined });
			const [busy, setBusy] = react.useState(false);
			const mounted = react.useRef(false);

			react.useEffect(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);

			const applyConfig = react.useCallback((body) => {
				const values = body.values ?? {};
				setConfig({
					status: "ready",
					revision: body.revision,
					values,
					credential: body.credential,
					models: Array.isArray(body.models) ? body.models : [],
					error: undefined
				});
				setDraft({
					defaultProfile: values.defaultProfile,
					locale: values.locale,
					pollIntervalMs: values.pollIntervalMs,
					pollMaxSeconds: values.pollMaxSeconds,
					requestTimeoutMs: values.requestTimeoutMs,
					maxTokens: values.maxTokens,
					trackCredits: values.trackCredits,
					showProgress: values.showProgress,
					verboseEvents: values.verboseEvents,
					creditPosition: values.creditPosition
				});
				const windows = values.modelContexts ?? {};
				const nextContexts = {};
				for (const model of Array.isArray(body.models) ? body.models : []) {
					const value = windows[model.id];
					nextContexts[model.id] = CONTEXT_OPTIONS.includes(value) ? value : 1000000;
				}
				setContexts(nextContexts);
				if (body.probe !== undefined && body.probe !== null) {
					setProbe({ status: "done", ok: body.probe.ok === true, total: body.probe.total, message: body.probe.message });
				}
			}, []);

			const reload = react.useCallback(async () => {
				try {
					const response = await fetch(CONFIG_PATH, { headers: { accept: "application/json" }, credentials: "same-origin" });
					const body = await response.json().catch(() => undefined);
					if (!mounted.current) return;
					if (!response.ok || body?.ok !== true) {
						setConfig({ status: "failed", revision: undefined, values: {}, credential: undefined, models: [], error: body?.error?.message ?? `HTTP ${response.status}` });
						return;
					}
					applyConfig(body);
				} catch (error) {
					if (!mounted.current) return;
					setConfig({ status: "failed", revision: undefined, values: {}, credential: undefined, models: [], error: error instanceof Error ? error.message : String(error) });
				}
			}, [applyConfig]);

			react.useEffect(() => {
				reload();
			}, [reload]);

			const setField = (key, value) => setDraft((current) => ({ ...current, [key]: value }));

			const accountKeys = ["defaultProfile", "locale", "pollIntervalMs", "pollMaxSeconds", "requestTimeoutMs", "maxTokens", "trackCredits", "showProgress", "verboseEvents", "creditPosition"];
			const unsavedAccount = accountKeys.some((key) => draft[key] !== config.values?.[key]);
			const unsavedModels = Object.keys(contexts).some((model) => contexts[model] !== (config.values?.modelContexts?.[model] ?? 1000000));

			const write = react.useCallback(async (ops) => {
				setBusy(true);
				setFeedback(undefined);
				try {
					const response = await fetch(CONFIG_PATH, {
						method: "POST",
						headers: { accept: "application/json", "content-type": "application/json" },
						credentials: "same-origin",
						body: JSON.stringify({ ops, revision: config.revision })
					});
					const body = await response.json().catch(() => undefined);
					if (!mounted.current) return false;
					if (response.status === 409) {
						setFeedback({ tone: "warn", text: t("settings.conflict") });
						await reload();
						return false;
					}
					if (!response.ok || body?.ok !== true) {
						setFeedback({ tone: "error", text: t("settings.saveFailed", { message: body?.error?.message ?? `HTTP ${response.status}` }) });
						return false;
					}
					await reload();
					return true;
				} catch (error) {
					if (mounted.current) setFeedback({ tone: "error", text: t("settings.saveFailed", { message: error instanceof Error ? error.message : String(error) }) });
					return false;
				} finally {
					if (mounted.current) setBusy(false);
				}
			}, [config.revision, reload, t]);

			const saveModels = async () => {
				const ops = Object.keys(contexts)
					.filter((model) => contexts[model] !== (config.values?.modelContexts?.[model] ?? 1000000))
					.map((model) => ({ op: "set", path: ["modelContexts", model], value: contexts[model] }));
				if (ops.length === 0) return;
				if (await write(ops)) setFeedback({ tone: "ok", text: t("settings.models.saved") });
			};

			const saveAccount = async () => {
				const ops = accountKeys
					.filter((key) => draft[key] !== config.values?.[key])
					.map((key) => ({ op: "set", path: [key], value: draft[key] }));
				if (ops.length === 0) return;
				if (await write(ops)) setFeedback({ tone: "ok", text: t("settings.account.saved") });
			};

			const saveKey = async () => {
				const value = keyValue.trim();
				if (value.length === 0) {
					setFeedback({ tone: "error", text: t("settings.key.empty") });
					return;
				}
				setBusy(true);
				setFeedback(undefined);
				try {
					const response = await fetch(CREDENTIAL_PATH, {
						method: "POST",
						headers: { accept: "application/json", "content-type": "application/json" },
						credentials: "same-origin",
						body: JSON.stringify({ value })
					});
					const body = await response.json().catch(() => undefined);
					if (!mounted.current) return;
					if (!response.ok || body?.ok !== true) {
						setFeedback({ tone: "error", text: t("settings.saveFailed", { message: body?.error?.message ?? `HTTP ${response.status}` }) });
						return;
					}
					setKeyValue("");
					setProbe({ status: "idle", ok: undefined, total: undefined, message: undefined });
					setFeedback({ tone: "ok", text: t("settings.key.saved") });
					await reload();
				} catch (error) {
					if (mounted.current) setFeedback({ tone: "error", text: t("settings.saveFailed", { message: error instanceof Error ? error.message : String(error) }) });
				} finally {
					if (mounted.current) setBusy(false);
				}
			};

			const clearKey = async () => {
				setBusy(true);
				setFeedback(undefined);
				try {
					const response = await fetch(CREDENTIAL_PATH, { method: "DELETE", headers: { accept: "application/json" }, credentials: "same-origin" });
					const body = await response.json().catch(() => undefined);
					if (!mounted.current) return;
					if (!response.ok || body?.ok !== true) {
						setFeedback({ tone: "error", text: t("settings.saveFailed", { message: body?.error?.message ?? `HTTP ${response.status}` }) });
						return;
					}
					setProbe({ status: "idle", ok: undefined, total: undefined, message: undefined });
					setFeedback({ tone: "ok", text: t("settings.key.cleared") });
					await reload();
				} catch (error) {
					if (mounted.current) setFeedback({ tone: "error", text: t("settings.saveFailed", { message: error instanceof Error ? error.message : String(error) }) });
				} finally {
					if (mounted.current) setBusy(false);
				}
			};

			const testKey = async () => {
				setProbe({ status: "testing", ok: undefined, total: undefined, message: undefined });
				try {
					const response = await fetch(TEST_PATH, { method: "POST", headers: { accept: "application/json" }, credentials: "same-origin" });
					const body = await response.json().catch(() => undefined);
					if (!mounted.current) return;
					if (!response.ok || body?.ok !== true) {
						setProbe({ status: "done", ok: false, total: undefined, message: body?.error?.message ?? `HTTP ${response.status}` });
						return;
					}
					const result = body.probe ?? {};
					setProbe({ status: "done", ok: result.ok === true || body.connected === true, total: result.total, message: result.message });
				} catch (error) {
					if (mounted.current) setProbe({ status: "done", ok: false, total: undefined, message: error instanceof Error ? error.message : String(error) });
				}
			};

			const credentialText = config.credential?.configured === true
				? t("settings.key.configured", { source: config.credential.source ?? "file" })
				: t("settings.key.missing");
			const keyTone = config.credential?.configured === true ? "ok" : "warn";

			const probeText = probe.status === "testing"
				? t("settings.key.testing")
				: probe.status === "done"
					? probe.ok === true
						? t("settings.key.connected", { total: formatCredits(probe.total) ?? "—" })
						: t("settings.key.testFailed", { message: probe.message ?? t("settings.key.disconnected") })
					: t("settings.key.untested");
			const probeTone = probe.status === "done" ? (probe.ok === true ? "ok" : "error") : "warn";

			const head = jsx.jsxs("div", {
				className: "dsm-manus-settings-head",
				children: [
					jsx.jsx("div", { className: "dsm-manus-settings-title", children: t("settings.title") }),
					jsx.jsx("div", { className: "dsm-manus-settings-desc", children: t("settings.desc") })
				]
			});

			const tabs = jsx.jsxs("div", {
				className: "dsm-manus-tabs",
				role: "tablist",
				children: [
					jsx.jsx("button", {
						type: "button",
						className: "dsm-manus-tab",
						"data-active": tab === "models",
						role: "tab",
						onClick: () => setTab("models"),
						children: t("settings.tab.models")
					}),
					jsx.jsx("button", {
						type: "button",
						className: "dsm-manus-tab",
						"data-active": tab === "account",
						role: "tab",
						onClick: () => setTab("account"),
						children: t("settings.tab.account")
					})
				]
			});

			if (config.status === "loading") {
				return jsx.jsxs("div", {
					className: "dsm-manus-settings",
					children: [head, tabs, jsx.jsx("div", { className: "dsm-manus-settings-hint", children: t("settings.loading") })]
				});
			}
			if (config.status === "failed") {
				return jsx.jsxs("div", {
					className: "dsm-manus-settings",
					children: [
						head,
						tabs,
						jsx.jsx("div", { className: "dsm-manus-settings-feedback", "data-tone": "error", children: t("settings.loadFailed", { message: config.error }) }),
						jsx.jsxs("div", {
							className: "dsm-manus-settings-actions",
							children: jsx.jsx("button", { type: "button", className: "dsm-manus-settings-button", onClick: () => reload(), children: t("settings.reset") })
						})
					]
				});
			}

			const modelsTab = jsx.jsxs("div", {
				className: "dsm-manus-settings-group",
				children: [
					jsx.jsx("div", { className: "dsm-manus-settings-group-title", children: t("settings.models.title") }),
					jsx.jsx("div", { className: "dsm-manus-settings-hint", children: t("settings.models.desc") }),
					config.models.map((model) =>
						jsx.jsxs("div", {
							className: "dsm-manus-model",
							children: [
								jsx.jsxs("div", {
									className: "dsm-manus-model-main",
									children: [
										jsx.jsx("span", { className: "dsm-manus-model-name", children: model.name }),
										jsx.jsx("span", { className: "dsm-manus-model-desc", children: model.description ?? model.id })
									]
								}),
								jsx.jsx("div", {
									className: "dsm-manus-segmented",
									role: "group",
									"aria-label": `${model.name} ${t("settings.models.context")}`,
									children: CONTEXT_OPTIONS.map((option) =>
										jsx.jsx("button", {
											type: "button",
											className: "dsm-manus-segment",
											"data-active": contexts[model.id] === option,
											onClick: () => setContexts((current) => ({ ...current, [model.id]: option })),
											children: formatWindow(option)
										}, `${model.id}-${option}`)
									)
								})
							]
						}, model.id)
					),
					jsx.jsx("div", { className: "dsm-manus-settings-hint", children: t("settings.models.hint") }),
					jsx.jsxs("div", {
						className: "dsm-manus-settings-actions",
						children: [
							jsx.jsx("button", {
								type: "button",
								className: "dsm-manus-settings-button",
								"data-variant": "primary",
								disabled: busy || !unsavedModels,
								onClick: () => saveModels(),
								children: t("settings.models.save")
							}),
							unsavedModels ? jsx.jsx("span", { className: "dsm-manus-settings-feedback", children: t("settings.unsaved") }) : null
						]
					})
				]
			});

			const accountTab = jsx.jsxs("div", {
				className: "dsm-manus-settings-group",
				children: [
					jsx.jsx("div", { className: "dsm-manus-settings-group-title", children: t("settings.key.section") }),
					jsx.jsxs("div", {
						className: "dsm-manus-settings-row",
						children: [
							jsx.jsxs("span", {
								className: "dsm-manus-settings-state",
								children: [
									jsx.jsx("span", { className: "dsm-manus-settings-dot", "data-tone": keyTone }),
									credentialText
								]
							}),
							jsx.jsxs("span", {
								className: "dsm-manus-settings-state",
								children: [
									jsx.jsx("span", { className: "dsm-manus-settings-dot", "data-tone": probeTone }),
									probeText
								]
							})
						]
					}),
					jsx.jsxs("div", {
						className: "dsm-manus-settings-row",
						children: [
							jsx.jsx("input", {
								type: "password",
								className: "dsm-manus-settings-control",
								placeholder: t("settings.key.placeholder"),
								value: keyValue,
								autoComplete: "off",
								onChange: (event) => setKeyValue(event.target.value)
							}),
							jsx.jsx("button", {
								type: "button",
								className: "dsm-manus-settings-button",
								"data-variant": "primary",
								disabled: busy || keyValue.trim().length === 0,
								onClick: () => saveKey(),
								children: t("settings.key.save")
							}),
							jsx.jsx("button", {
								type: "button",
								className: "dsm-manus-settings-button",
								"data-variant": "danger",
								disabled: busy || config.credential?.configured !== true,
								onClick: () => clearKey(),
								children: t("settings.key.clear")
							}),
							jsx.jsx("button", {
								type: "button",
								className: "dsm-manus-settings-button",
								disabled: probe.status === "testing" || config.credential?.configured !== true,
								onClick: () => testKey(),
								children: t("settings.key.test")
							})
						]
					}),
					jsx.jsx("div", { className: "dsm-manus-settings-hint", children: t("settings.key.hint") }),
					jsx.jsx(Field, {
						label: t("settings.key.env"),
						hint: "MANUS_API_KEY",
						children: jsx.jsx("input", {
							type: "text",
							className: "dsm-manus-settings-control",
							value: draft.apiKeyEnv ?? config.values?.apiKeyEnv ?? "MANUS_API_KEY",
							readOnly: true
						})
					}),
					jsx.jsx("div", { className: "dsm-manus-settings-group-title", children: t("settings.account.title") }),
					jsx.jsxs("div", {
						className: "dsm-manus-settings-row",
						children: [
							jsx.jsx(Field, {
								label: t("settings.account.default"),
								children: jsx.jsx("select", {
									className: "dsm-manus-settings-control",
									value: draft.defaultProfile ?? "",
									onChange: (event) => setField("defaultProfile", event.target.value),
									children: (config.models.length > 0 ? config.models : [{ id: "standard", name: "Manus Standard" }, { id: "lite", name: "Manus Lite" }, { id: "max", name: "Manus Max" }]).map((model) =>
										jsx.jsx("option", { value: model.id, children: model.name }, model.id)
									)
								})
							}),
							jsx.jsx(Field, {
								label: t("settings.account.locale"),
								children: jsx.jsx("input", {
									type: "text",
									className: "dsm-manus-settings-control",
									value: draft.locale ?? "",
									onChange: (event) => setField("locale", event.target.value)
								})
							})
						]
					}),
					jsx.jsx(Field, {
						label: t("settings.account.creditPosition"),
						children: jsx.jsx("select", {
							className: "dsm-manus-settings-control",
							value: draft.creditPosition ?? "composer",
							onChange: (event) => setField("creditPosition", event.target.value),
							children: [
								jsx.jsx("option", { value: "composer", children: t("settings.account.creditPositionComposer") }, "composer"),
								jsx.jsx("option", { value: "dock", children: t("settings.account.creditPositionDock") }, "dock")
							]
						})
					}),
					jsx.jsx("div", { className: "dsm-manus-settings-group-title", children: t("settings.account.runtime") }),
					jsx.jsx("div", {
						className: "dsm-manus-settings-row",
						children: RUNTIME_NUMBERS.map(([key, min, max]) =>
							jsx.jsx(Field, {
								label: t(`settings.field.${key}`),
								children: jsx.jsx("input", {
									type: "number",
									className: "dsm-manus-settings-control",
									min,
									max,
									value: draft[key] ?? "",
									onChange: (event) => {
										const parsed = Number(event.target.value);
										setField(key, Number.isFinite(parsed) ? parsed : event.target.value);
									}
								})
							}, key)
						)
					}),
					jsx.jsx("div", {
						className: "dsm-manus-settings-row",
						children: RUNTIME_BOOLEANS.map((key) =>
							jsx.jsxs("span", {
								className: "dsm-manus-settings-check",
								children: [
									jsx.jsx("input", {
										type: "checkbox",
										checked: draft[key] === true,
										onChange: (event) => setField(key, event.target.checked)
									}),
									t(`settings.field.${key}`)
								]
							}, key)
						)
					}),
					jsx.jsxs("div", {
						className: "dsm-manus-settings-actions",
						children: [
							jsx.jsx("button", {
								type: "button",
								className: "dsm-manus-settings-button",
								"data-variant": "primary",
								disabled: busy || !unsavedAccount,
								onClick: () => saveAccount(),
								children: t("settings.account.save")
							}),
							jsx.jsx("button", {
								type: "button",
								className: "dsm-manus-settings-button",
								disabled: busy,
								onClick: () => reload(),
								children: t("settings.reset")
							}),
							unsavedAccount ? jsx.jsx("span", { className: "dsm-manus-settings-feedback", children: t("settings.unsaved") }) : null
						]
					})
				]
			});

			return jsx.jsxs("div", {
				className: "dsm-manus-settings",
				children: [
					head,
					tabs,
					tab === "models" ? modelsTab : accountTab,
					feedback === undefined
						? null
						: jsx.jsx("div", { className: "dsm-manus-settings-feedback", "data-tone": feedback.tone, children: feedback.text })
				]
			});
		}

		/**
		 * Decide which composer seat this readout occupies. The position comes
		 * from the plugin settings (`creditPosition`), cached briefly so a seat
		 * render does not hit the Host on every keystroke.
		 */
		const positionCache = { value: undefined, at: 0 };
		function readCreditPosition() {
			const now = Date.now();
			if (positionCache.value !== undefined && now - positionCache.at < REFRESH_INTERVAL_MS) return positionCache.value;
			return positionCache.value;
		}
		function refreshCreditPosition() {
			if (positionCache.value !== undefined && Date.now() - positionCache.at < 5000) return;
			fetch(CONFIG_PATH, { headers: { accept: "application/json" }, credentials: "same-origin" })
				.then((response) => response.json())
				.then((body) => {
					const value = body?.ok === true ? body.values?.creditPosition : undefined;
					positionCache.value = value === "dock" ? "dock" : "composer";
					positionCache.at = Date.now();
				})
				.catch(() => {});
		}

		/** Render the readout only in the seat the settings select. */
		function ManusCreditsGate(props) {
			const { t, position, useProjection, useSession } = props;
			const projection = useProjection?.("modelSelection");
			const selection = projection?.next ?? projection?.lastUsed;
			const provider = typeof selection?.provider === "string" ? selection.provider : "";
			if (provider !== PROVIDER) return null;
			refreshCreditPosition();
			const wanted = readCreditPosition() ?? "composer";
			const seat = position === "stats" ? "dock" : "composer";
			if (wanted !== seat) return null;
			return jsx.jsx(ManusCredits, { t, sessionId: props.sessionId, useSession });
		}

		const name = "manus-llm-client";
		const inject = ["slots", "locale"];

		function apply(ctx) {
			try {
				ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), "manus-llm: settings copy");
				const t = ctx.locale.bind(NAMESPACE);

				const register = (slotName, id, order, position) => {
					try {
						ctx.slots.inject(slotName, () =>
							ctx.slots.register(
								{
									name: slotName,
									id,
									order,
									locale: NAMESPACE,
									inject: () => ({ t, position })
								},
								ManusCreditsGate
							)
						);
					} catch (error) {
						console.error(`[manus-llm] credits slot "${slotName}" failed to register (host provider unaffected)`, error);
					}
				};

				register("conversation.input.left", "manus-llm-composer-credits", 6, "composer");
				register("conversation.composer.dock", "manus-llm-stats-credits", 12, "stats");

				try {
					ctx.slots.inject("settings.section", () =>
						ctx.slots.register(
							{
								name: "settings.section",
								id: "manus",
								order: 30,
								label: () => t("settings.nav"),
								locale: NAMESPACE,
								inject: () => ({ t })
							},
							ManusSettings
						)
					);
				} catch (error) {
					console.error("[manus-llm] settings section failed to register (composer readout unaffected):", error);
				}
			} catch (error) {
				console.error("[manus-llm] client bundle failed to apply:", error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
