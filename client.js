/**
 * dsh-manus-llm — browser half.
 *
 * Adds the Manus credit readout to the composer toolbar. It renders only while
 * the session's selected model belongs to the `manus` provider, so nothing is
 * drawn (and no request is made) for every other provider.
 *
 * Registered in BOTH list seats the host exposes — `conversation.input.left`
 * (the composer tool row) and `conversation.composer.dock` (the dock under the
 * composer) — because both are shared list seats: another bundle parking
 * something there must not decide this plugin's presence. Both registrations
 * are unconditional; the gate decides what actually draws.
 *
 * Data comes from this plugin's own Host route (`/plugins/manus-llm/credits`),
 * which reads the authoritative balance with the stored key. The key itself
 * never reaches the browser.
 */
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
		/** The provider route key this plugin owns. */
		const PROVIDER = "manus";
		/** Balance refresh cadence: a balance moves only when a turn spends. */
		const REFRESH_INTERVAL_MS = 60000;
		/** Settings namespace for the client-side copy. */
		const NAMESPACE = "manus-llm";

		const zh = {
			"credits.label": "积分",
			"credits.unknown": "积分",
			"credits.title": "Manus 积分",
			"credits.total": "可用总额",
			"credits.free": "免费额度",
			"credits.periodic": "周期额度",
			"credits.addon": "附加额度",
			"credits.lastTurn": "上轮消耗",
			"credits.nextRefresh": "下次刷新",
			"credits.refresh": "刷新",
			"credits.loading": "读取中…",
			"credits.failed": "积分读取失败",
			"credits.missingKey": "未配置 API Key",
			"credits.empty": "暂无数据",
			"credits.hint": "余额来自 Manus 官方接口；每轮对话结束后自动刷新。",
			"settings.nav": "Manus",
			"settings.title": "Manus 模型配置",
			"settings.desc": "把 Manus 云端代理当作 DSH 里的一个模型来用：填好 API Key，然后在对话工具栏的模型选择器里选 Manus 档位。",
			"settings.key.section": "API Key",
			"settings.key.label": "Manus API Key",
			"settings.key.placeholder": "粘贴以 m- 开头的 API Key",
			"settings.key.configured": "已配置（来源：{source}）",
			"settings.key.missing": "未配置",
			"settings.key.save": "保存 Key",
			"settings.key.clear": "清除 Key",
			"settings.key.saved": "已保存",
			"settings.key.cleared": "已清除",
			"settings.key.empty": "请先粘贴 API Key",
			"settings.key.hint": "Key 只保存在本机凭证库，不会出现在对话记录里。可在 manus.im/app#settings/developers 生成。",
			"settings.key.env": "凭证引用名（环境变量名）",
			"settings.model.section": "模型档位",
			"settings.model.default": "未知模型时的回退档位",
			"settings.model.hint": "对话工具栏里的三个档位由插件内置；这里只决定 id 无法识别时的回退值。",
			"settings.runtime.section": "运行参数",
			"settings.field.locale": "输出语言",
			"settings.field.pollIntervalMs": "轮询间隔（毫秒）",
			"settings.field.pollMaxSeconds": "单回合上限（秒）",
			"settings.field.requestTimeoutMs": "请求超时（毫秒）",
			"settings.field.contextWindow": "上下文窗口",
			"settings.field.maxTokens": "最大输出 token",
			"settings.field.trackCredits": "记录每轮积分消耗",
			"settings.field.showProgress": "显示中间进度消息",
			"settings.field.verboseEvents": "记录轮询事件日志",
			"settings.save": "保存设置",
			"settings.saved": "设置已保存",
			"settings.reset": "重新读取",
			"settings.loading": "读取中…",
			"settings.loadFailed": "读取配置失败",
			"settings.saveFailed": "保存失败",
			"settings.conflict": "配置已被其它窗口修改，已重新读取，请再次保存。",
			"settings.unsaved": "有未保存的修改"
		};
		const en = {
			"credits.label": "credits",
			"credits.unknown": "credits",
			"credits.title": "Manus credits",
			"credits.total": "Available",
			"credits.free": "Free",
			"credits.periodic": "Periodic",
			"credits.addon": "Add-on",
			"credits.lastTurn": "Last turn",
			"credits.nextRefresh": "Next refresh",
			"credits.refresh": "Refresh",
			"credits.loading": "Loading…",
			"credits.failed": "Could not read credits",
			"credits.missingKey": "No API key configured",
			"credits.empty": "No data",
			"credits.hint": "Balance comes from the Manus API; refreshed after every turn.",
			"settings.nav": "Manus",
			"settings.title": "Manus model configuration",
			"settings.desc": "Use the Manus cloud agent as a model inside DSH: store an API key, then pick a Manus tier in the composer's model selector.",
			"settings.key.section": "API key",
			"settings.key.label": "Manus API key",
			"settings.key.placeholder": "Paste the API key starting with m-",
			"settings.key.configured": "Configured (source: {source})",
			"settings.key.missing": "Not configured",
			"settings.key.save": "Save key",
			"settings.key.clear": "Clear key",
			"settings.key.saved": "Saved",
			"settings.key.cleared": "Cleared",
			"settings.key.empty": "Paste an API key first",
			"settings.key.hint": "The key is stored in the local credential store only and never appears in conversation history. Create one at manus.im/app#settings/developers.",
			"settings.key.env": "Credential reference (environment name)",
			"settings.model.section": "Model tier",
			"settings.model.default": "Fallback tier for an unknown model id",
			"settings.model.hint": "The three tiers in the composer are built in; this only decides the fallback when an id is unrecognized.",
			"settings.runtime.section": "Runtime",
			"settings.field.locale": "Output language",
			"settings.field.pollIntervalMs": "Poll interval (ms)",
			"settings.field.pollMaxSeconds": "Turn limit (seconds)",
			"settings.field.requestTimeoutMs": "Request timeout (ms)",
			"settings.field.contextWindow": "Context window",
			"settings.field.maxTokens": "Max output tokens",
			"settings.field.trackCredits": "Track per-turn credit spend",
			"settings.field.showProgress": "Include progress messages",
			"settings.field.verboseEvents": "Log polling events",
			"settings.save": "Save settings",
			"settings.saved": "Settings saved",
			"settings.reset": "Reload",
			"settings.loading": "Loading…",
			"settings.loadFailed": "Could not read configuration",
			"settings.saveFailed": "Could not save",
			"settings.conflict": "Configuration changed elsewhere; reloaded — save again.",
			"settings.unsaved": "Unsaved changes"
		};

		const CSS = `
.dsm-manus-credits{display:inline-flex;align-items:center;min-width:0}
.dsm-manus-credits-trigger{appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;max-width:100%;margin:0;padding:2px 6px;border:0;border-radius:6px;background:transparent;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap;cursor:pointer;font-variant-numeric:tabular-nums}
.dsm-manus-credits-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsm-manus-credits-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-manus-credits-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e)}
.dsm-manus-credits-dot[data-tone=warn]{background:var(--dsw-alias-state-warn-secondary,#fbbf24)}
.dsm-manus-credits-dot[data-tone=error]{background:var(--dsw-alias-state-error-primary,#d92d20)}
.dsm-manus-credits-panel{position:fixed;z-index:1100;box-sizing:border-box;width:min(248px,calc(100vw - 24px));padding:12px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:var(--dsw-radius-lg,14px);background:var(--dsw-specific-menu,Canvas);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.18));font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#444)}
.dsm-manus-credits-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));color:var(--dsw-alias-label-primary,#111);font-weight:500}
.dsm-manus-credits-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding-top:6px}
.dsm-manus-credits-key{color:var(--dsw-alias-label-tertiary,#999)}
.dsm-manus-credits-value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#111)}
.dsm-manus-credits-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2))}
.dsm-manus-credits-action{appearance:none;border:0;border-radius:6px;background:transparent;padding:2px 6px;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-brand-primary,#5686fe);cursor:pointer}
.dsm-manus-credits-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsm-manus-credits-error{color:var(--dsw-alias-state-error-primary,#d92d20)}
.dsm-manus-credits-hint{margin-top:8px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-manus-settings{box-sizing:border-box;display:flex;flex-direction:column;gap:18px;padding:4px 2px 24px;color:var(--dsw-alias-label-secondary,#444);font-size:13px;line-height:20px}
.dsm-manus-settings-head{display:flex;flex-direction:column;gap:4px}
.dsm-manus-settings-title{margin:0;font-size:16px;line-height:24px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}
.dsm-manus-settings-desc{margin:0;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-manus-settings-group{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:var(--dsw-radius-lg,14px);background:var(--dsw-alias-bg-l1,rgba(127,127,127,.04))}
.dsm-manus-settings-group-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}
.dsm-manus-settings-field{display:flex;flex-direction:column;gap:4px}
.dsm-manus-settings-label{color:var(--dsw-alias-label-secondary,#444)}
.dsm-manus-settings-control{box-sizing:border-box;width:100%;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:8px;background:var(--dsw-alias-bg-base,#fff);font:inherit;font-size:13px;color:var(--dsw-alias-label-primary,#111)}
.dsm-manus-settings-control:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-manus-settings-row{display:flex;align-items:center;gap:8px}
.dsm-manus-settings-check{display:flex;align-items:center;gap:8px}
.dsm-manus-settings-check input{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-manus-settings-hint{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-manus-settings-state{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-manus-settings-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e)}
.dsm-manus-settings-dot[data-tone=warn]{background:var(--dsw-alias-state-warn-secondary,#fbbf24)}
.dsm-manus-settings-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsm-manus-settings-button{appearance:none;box-sizing:border-box;padding:5px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:8px;background:var(--dsw-alias-bg-base,#fff);font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#111);cursor:pointer}
.dsm-manus-settings-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsm-manus-settings-button:disabled{opacity:.55;cursor:default}
.dsm-manus-settings-button[data-variant=primary]{border-color:transparent;background:var(--dsw-alias-brand-primary,#5686fe);color:#fff}
.dsm-manus-settings-button[data-variant=primary]:hover{filter:brightness(1.05)}
.dsm-manus-settings-button[data-variant=danger]{border-color:transparent;background:transparent;color:var(--dsw-alias-state-error-primary,#d92d20)}
.dsm-manus-settings-feedback{margin:0;font-size:12px;line-height:18px}
.dsm-manus-settings-feedback[data-tone=ok]{color:var(--dsw-alias-state-success-primary,#22c55e)}
.dsm-manus-settings-feedback[data-tone=error]{color:var(--dsw-alias-state-error-primary,#d92d20)}
.dsm-manus-settings-feedback[data-tone=warn]{color:var(--dsw-alias-state-warn-secondary,#fbbf24)}
`;

		if (typeof document !== "undefined") {
			const cssId = "dsh-manus-llm/credits.css";
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(cssId)}]`) === null) {
				const styleTag = document.createElement("style");
				styleTag.dataset.plugin = "dsh-manus-llm";
				styleTag.dataset.pluginCss = cssId;
				styleTag.textContent = CSS;
				document.head.appendChild(styleTag);
			}
		}

		/** Read the top clearance the shell reserves above the viewport. */
		function overlayTopMargin(min) {
			try {
				const raw = getComputedStyle(document.documentElement).getPropertyValue("--dsh-frame-top-clearance");
				const value = Number.parseFloat(raw);
				if (!Number.isFinite(value)) return min;
				const fullscreen = document.documentElement.hasAttribute("data-fullscreen");
				return Math.max(min, (fullscreen ? 0 : value) + 20);
			} catch {
				return min;
			}
		}

		/** Place a fixed panel against its anchor, clamped to the viewport. */
		function useAnchoredPosition({ open, anchorRef, panelRef, gap = 8, margin = 12 }) {
			const [position, setPosition] = react.useState(null);
			react.useLayoutEffect(() => {
				if (!open) {
					setPosition(null);
					return;
				}
				const place = () => {
					const anchor = anchorRef.current;
					const panel = panelRef.current;
					if (anchor === null || panel === null) return;
					const rect = anchor.getBoundingClientRect();
					const width = panel.offsetWidth;
					const height = panel.offsetHeight;
					const left = Math.min(Math.max(rect.left, margin), Math.max(margin, window.innerWidth - width - margin));
					const top = Math.min(Math.max(rect.top - gap - height, overlayTopMargin(margin)), Math.max(margin, window.innerHeight - height - margin));
					setPosition({ left, top });
				};
				place();
				window.addEventListener("scroll", place, true);
				window.addEventListener("resize", place);
				const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
				if (observer !== null && panelRef.current !== null) observer.observe(panelRef.current);
				return () => {
					window.removeEventListener("scroll", place, true);
					window.removeEventListener("resize", place);
					observer?.disconnect();
				};
			}, [open, anchorRef, panelRef, gap, margin]);
			return position;
		}

		/** Close the panel when the pointer lands outside both anchor and portal. */
		function useDismissOnOutsidePointer(rootRef, open, close, portalRef) {
			react.useEffect(() => {
				if (!open) return;
				const onPointerDown = (event) => {
					const target = event.target;
					if (!(target instanceof Node)) return;
					if (rootRef.current?.contains(target) === true) return;
					if (portalRef.current?.contains(target) === true) return;
					close();
				};
				document.addEventListener("pointerdown", onPointerDown);
				return () => document.removeEventListener("pointerdown", onPointerDown);
			}, [open, rootRef, close, portalRef]);
		}

		/** Compact credit figure: 12.4k above a thousand, plain below. */
		function formatCredits(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "—";
			const rounded = Math.round(value * 10) / 10;
			if (Math.abs(rounded) < 1000) return String(rounded);
			const scaled = Math.round(rounded / 100) / 10;
			return `${scaled}k`;
		}

		/** Absolute time for a unix-seconds stamp, in the browser's locale. */
		function formatTime(unixSeconds) {
			if (typeof unixSeconds !== "number" || unixSeconds <= 0) return undefined;
			try {
				return new Date(unixSeconds * 1000).toLocaleString();
			} catch {
				return undefined;
			}
		}

		/**
		 * The readout: balance + last turn spend, fetched from this plugin's own
		 * Host route. `sessionId` arrives from the session scope binding.
		 */
		function ManusCredits({ t, sessionId, useSession }) {
			const [state, setState] = react.useState({ status: "idle", credits: undefined, lastTurn: undefined, error: undefined });
			const [open, setOpen] = react.useState(false);
			const rootRef = react.useRef(null);
			const panelRef = react.useRef(null);
			const inFlight = react.useRef(false);
			const mounted = react.useRef(true);

			react.useEffect(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);

			const load = react.useCallback(async () => {
				if (inFlight.current) return;
				inFlight.current = true;
				try {
					const url = `${CREDITS_PATH}?sessionId=${encodeURIComponent(typeof sessionId === "string" ? sessionId : "")}`;
					const response = await fetch(url, { headers: { accept: "application/json" }, credentials: "same-origin" });
					const body = await response.json().catch(() => undefined);
					if (!mounted.current) return;
					if (!response.ok || body?.ok !== true) {
						setState({
							status: "failed",
							credits: undefined,
							lastTurn: undefined,
							error: body?.error?.message ?? `HTTP ${response.status}`
						});
						return;
					}
					setState({ status: "ready", credits: body.credits, lastTurn: body.lastTurn, error: undefined });
				} catch (error) {
					if (!mounted.current) return;
					setState({ status: "failed", credits: undefined, lastTurn: undefined, error: error instanceof Error ? error.message : String(error) });
				} finally {
					inFlight.current = false;
				}
			}, [sessionId]);

			// Refresh on mount, on session change, and on a slow ticker. The ticker
			// only runs while the panel is closed too: the trigger label is the
			// always-visible surface, so it must stay truthful.
			react.useEffect(() => {
				load();
				const timer = window.setInterval(load, REFRESH_INTERVAL_MS);
				return () => window.clearInterval(timer);
			}, [load]);

			// A finished turn spends credits; refresh shortly after the busy edge.
			// The host hands the standard session hook in as a prop (the same way
			// the composer's own ContextMeter receives its projection hook), so a
			// build without that hook degrades to the slow ticker.
			const running = useSession?.((snapshot) => snapshot.running === true) === true;

			react.useEffect(() => {
				if (running === true) return;
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
			useDismissOnOutsidePointer(rootRef, open, () => setOpen(false), panelRef);

			const credits = state.credits;
			const lastTurn = state.lastTurn;
			// A missing key or a network failure still draws the trigger: the user
			// needs to see WHY there is no number, not an empty toolbar. Only a
			// never-loaded readout (idle, before the first fetch settles) stays
			// silent so the seat does not flicker in.
			if (state.status === "idle") return null;

			const total = credits?.total;
			const tone = state.status === "failed" ? "error" : typeof total === "number" && total <= 0 ? "warn" : "ok";
			const label = t("credits.label");
			const valueText = typeof total === "number" ? formatCredits(total) : t("credits.unknown");
			const rows = [];
			if (typeof total === "number") rows.push({ key: "credits.total", value: String(Math.round(total)) });
			if (typeof credits?.free === "number") rows.push({ key: "credits.free", value: String(Math.round(credits.free)) });
			if (typeof credits?.periodic === "number") rows.push({ key: "credits.periodic", value: String(Math.round(credits.periodic)) });
			if (typeof credits?.addon === "number" && credits.addon > 0) rows.push({ key: "credits.addon", value: String(Math.round(credits.addon)) });
			if (typeof lastTurn?.spent === "number") rows.push({ key: "credits.lastTurn", value: `−${Math.round(lastTurn.spent)}` });
			const nextRefresh = formatTime(credits?.nextRefresh);

			return jsx.jsxs("span", {
				ref: rootRef,
				className: "dsm-manus-credits",
				children: [
					jsx.jsxs("button", {
						type: "button",
						className: "dsm-manus-credits-trigger",
						"aria-haspopup": "dialog",
						"aria-expanded": open,
						title: t("credits.title"),
						onClick: () => setOpen((current) => !current),
						children: [
							jsx.jsx("span", { className: "dsm-manus-credits-dot", "data-tone": tone }),
							`${label} ${valueText}`
						]
					}),
					open ? reactDom.createPortal(
						jsx.jsxs("div", {
							ref: panelRef,
							className: "dsm-manus-credits-panel",
							style: position ?? { visibility: "hidden", left: 0, top: 0 },
							role: "dialog",
							"aria-label": t("credits.title"),
							children: [
								jsx.jsxs("div", {
									className: "dsm-manus-credits-head",
									children: [t("credits.title"), jsx.jsx("span", { className: "dsm-manus-credits-value", children: formatCredits(total) })]
								}),
								state.status === "failed"
									? jsx.jsxs("div", { className: "dsm-manus-credits-row", children: [jsx.jsx("span", { className: "dsm-manus-credits-key", children: t("credits.failed") }), jsx.jsx("span", { className: "dsm-manus-credits-error", children: state.error ?? "" })] })
									: rows.length === 0
										? jsx.jsxs("div", { className: "dsm-manus-credits-row", children: [jsx.jsx("span", { className: "dsm-manus-credits-key", children: t("credits.empty") })] })
										: rows.map((row) => jsx.jsxs("div", {
											className: "dsm-manus-credits-row",
											children: [
												jsx.jsx("span", { className: "dsm-manus-credits-key", children: t(row.key) }),
												jsx.jsx("span", { className: "dsm-manus-credits-value", children: row.value })
											]
										}, row.key)),
								nextRefresh === undefined ? null : jsx.jsxs("div", {
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
											onClick: load,
											children: t("credits.refresh")
										})
									]
								})
							]
						}),
						document.body
					) : null
				]
			});
		}

		/** One labelled form field. */
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
		 * The plugin's own settings page (a `settings.section` entry).
		 *
		 * Reads and writes go through this plugin's Host routes, so the bundle
		 * needs no `remote.settings` / `remote.credentials` declaration. Host
		 * writes still funnel through `settings.mutate`, keeping the volatile
		 * gate authoritative.
		 */
		function ManusSettings(props) {
			const { t } = props;
			const [config, setConfig] = react.useState({ status: "loading", revision: undefined, values: {}, credential: undefined, error: undefined });
			const [draft, setDraft] = react.useState({});
			const [keyValue, setKeyValue] = react.useState("");
			const [feedback, setFeedback] = react.useState(undefined);
			const [busy, setBusy] = react.useState(false);
			const mounted = react.useRef(true);

			react.useEffect(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);

			const reload = react.useCallback(async () => {
				setConfig((current) => ({ ...current, status: "loading" }));
				try {
					const response = await fetch(CONFIG_PATH, { headers: { accept: "application/json" }, credentials: "same-origin" });
					const body = await response.json().catch(() => undefined);
					if (!mounted.current) return;
					if (!response.ok || body?.ok !== true) {
						setConfig({ status: "failed", revision: undefined, values: {}, credential: undefined, error: body?.error?.message ?? `HTTP ${response.status}` });
						return;
					}
					setConfig({ status: "ready", revision: body.revision, values: body.values ?? {}, credential: body.credential, models: body.models, error: undefined });
					setDraft(body.values ?? {});
				} catch (error) {
					if (!mounted.current) return;
					setConfig({ status: "failed", revision: undefined, values: {}, credential: undefined, error: error instanceof Error ? error.message : String(error) });
				}
			}, []);

			react.useEffect(() => {
				reload();
			}, [reload]);

			const setField = (name, value) => {
				setDraft((current) => ({ ...current, [name]: value }));
			};

			const dirty = () => {
				const keys = ["defaultProfile", "locale", "pollIntervalMs", "pollMaxSeconds", "requestTimeoutMs", "contextWindow", "maxTokens", "trackCredits", "showProgress", "verboseEvents"];
				return keys.some((key) => draft[key] !== config.values?.[key]);
			};

			const save = async () => {
				setBusy(true);
				setFeedback(undefined);
				try {
					const ops = [];
					for (const key of ["defaultProfile", "locale", "pollIntervalMs", "pollMaxSeconds", "requestTimeoutMs", "contextWindow", "maxTokens", "trackCredits", "showProgress", "verboseEvents"]) {
						if (draft[key] !== config.values?.[key]) ops.push({ op: "set", path: [key], value: draft[key] });
					}
					if (ops.length === 0) {
						setFeedback({ tone: "ok", text: t("settings.saved") });
						return;
					}
					const response = await fetch(CONFIG_PATH, {
						method: "POST",
						headers: { "content-type": "application/json", accept: "application/json" },
						credentials: "same-origin",
						body: JSON.stringify({ ops, revision: config.revision })
					});
					const body = await response.json().catch(() => undefined);
					if (!mounted.current) return;
					if (response.status === 409) {
						setFeedback({ tone: "warn", text: t("settings.conflict") });
						await reload();
						return;
					}
					if (!response.ok || body?.ok !== true) {
						setFeedback({ tone: "error", text: `${t("settings.saveFailed")}: ${body?.error?.message ?? `HTTP ${response.status}`}` });
						return;
					}
					setFeedback({ tone: "ok", text: t("settings.saved") });
					await reload();
				} catch (error) {
					if (!mounted.current) return;
					setFeedback({ tone: "error", text: `${t("settings.saveFailed")}: ${error instanceof Error ? error.message : String(error)}` });
				} finally {
					if (mounted.current) setBusy(false);
				}
			};

			const saveKey = async () => {
				const value = keyValue.trim();
				if (value.length === 0) {
					setFeedback({ tone: "warn", text: t("settings.key.empty") });
					return;
				}
				setBusy(true);
				setFeedback(undefined);
				try {
					const response = await fetch(CREDENTIAL_PATH, {
						method: "POST",
						headers: { "content-type": "application/json", accept: "application/json" },
						credentials: "same-origin",
						body: JSON.stringify({ value })
					});
					const body = await response.json().catch(() => undefined);
					if (!mounted.current) return;
					if (!response.ok || body?.ok !== true) {
						setFeedback({ tone: "error", text: body?.error?.message ?? `HTTP ${response.status}` });
						return;
					}
					setKeyValue("");
					setFeedback({ tone: "ok", text: t("settings.key.saved") });
					await reload();
				} catch (error) {
					if (!mounted.current) return;
					setFeedback({ tone: "error", text: error instanceof Error ? error.message : String(error) });
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
						setFeedback({ tone: "error", text: body?.error?.message ?? `HTTP ${response.status}` });
						return;
					}
					setFeedback({ tone: "ok", text: t("settings.key.cleared") });
					await reload();
				} catch (error) {
					if (!mounted.current) return;
					setFeedback({ tone: "error", text: error instanceof Error ? error.message : String(error) });
				} finally {
					if (mounted.current) setBusy(false);
				}
			};

			const credential = config.credential;
			const credentialText = credential?.configured === true
				? t("settings.key.configured", { source: credential.source ?? "file" })
				: t("settings.key.missing");
			const numberField = (name, label, hint, { min, max } = {}) => jsx.jsxs(Field, {
				label,
				hint,
				children: [jsx.jsx("input", {
					className: "dsm-manus-settings-control",
					type: "number",
					min,
					max,
					value: draft[name] ?? "",
					disabled: busy,
					onChange: (event) => {
						const raw = event.target.value;
						setField(name, raw === "" ? "" : Number(raw));
					}
				})]
			}, name);
			const booleanField = (name, label) => jsx.jsxs("label", {
				className: "dsm-manus-settings-check",
				children: [
					jsx.jsx("input", {
						type: "checkbox",
						checked: draft[name] === true,
						disabled: busy,
						onChange: (event) => setField(name, event.target.checked)
					}),
					jsx.jsx("span", { children: label })
				]
			}, name);

			const body = [];
			body.push(jsx.jsxs("div", {
				key: "head",
				className: "dsm-manus-settings-head",
				children: [
					jsx.jsx("h2", { className: "dsm-manus-settings-title", children: t("settings.title") }),
					jsx.jsx("p", { className: "dsm-manus-settings-desc", children: t("settings.desc") })
				]
			}));

			if (config.status === "loading") {
				body.push(jsx.jsx("p", { key: "loading", className: "dsm-manus-settings-hint", children: t("settings.loading") }));
			}
			if (config.status === "failed") {
				body.push(jsx.jsx("p", {
					key: "failed",
					className: "dsm-manus-settings-feedback",
					"data-tone": "error",
					children: `${t("settings.loadFailed")}: ${config.error ?? ""}`
				}));
			}

			body.push(jsx.jsxs("div", {
				key: "key",
				className: "dsm-manus-settings-group",
				children: [
					jsx.jsx("h3", { className: "dsm-manus-settings-group-title", children: t("settings.key.section") }),
					jsx.jsxs("div", {
						className: "dsm-manus-settings-state",
						children: [
							jsx.jsx("span", { className: "dsm-manus-settings-dot", "data-tone": credential?.configured === true ? "ok" : "warn" }),
							jsx.jsx("span", { children: credentialText })
						]
					}),
					jsx.jsxs(Field, {
						label: t("settings.key.label"),
						hint: t("settings.key.hint"),
						children: [jsx.jsx("input", {
							className: "dsm-manus-settings-control",
							type: "password",
							autoComplete: "off",
							placeholder: t("settings.key.placeholder"),
							value: keyValue,
							disabled: busy,
							onChange: (event) => setKeyValue(event.target.value)
						})]
					}),
					jsx.jsxs("div", {
						className: "dsm-manus-settings-actions",
						children: [
							jsx.jsx("button", {
								type: "button",
								className: "dsm-manus-settings-button",
								"data-variant": "primary",
								disabled: busy || keyValue.trim().length === 0,
								onClick: saveKey,
								children: t("settings.key.save")
							}),
							credential?.configured === true
								? jsx.jsx("button", {
									type: "button",
									className: "dsm-manus-settings-button",
									"data-variant": "danger",
									disabled: busy,
									onClick: clearKey,
									children: t("settings.key.clear")
								})
								: null
						]
					}),
					jsx.jsxs(Field, {
						label: t("settings.key.env"),
						children: [jsx.jsx("input", {
							className: "dsm-manus-settings-control",
							type: "text",
							value: draft.apiKeyEnv ?? "",
							disabled: busy,
							onChange: (event) => setField("apiKeyEnv", event.target.value)
						})]
					})
				]
			}));

			body.push(jsx.jsxs("div", {
				key: "model",
				className: "dsm-manus-settings-group",
				children: [
					jsx.jsx("h3", { className: "dsm-manus-settings-group-title", children: t("settings.model.section") }),
					jsx.jsxs(Field, {
						label: t("settings.model.default"),
						hint: t("settings.model.hint"),
						children: [jsx.jsx("select", {
							className: "dsm-manus-settings-control",
							value: draft.defaultProfile ?? "standard",
							disabled: busy,
							onChange: (event) => setField("defaultProfile", event.target.value),
							children: (config.models ?? [{ id: "standard", name: "Manus Standard" }, { id: "lite", name: "Manus Lite" }, { id: "max", name: "Manus Max" }]).map((model) =>
								jsx.jsx("option", { value: model.id, children: model.name }, model.id))
						})]
					}),
					jsx.jsx("div", {
						className: "dsm-manus-settings-row",
						children: jsx.jsxs(Field, {
							label: t("settings.field.locale"),
							children: [jsx.jsx("input", {
								className: "dsm-manus-settings-control",
								type: "text",
								value: draft.locale ?? "",
								disabled: busy,
								onChange: (event) => setField("locale", event.target.value)
							})]
						})
					})
				]
			}));

			body.push(jsx.jsxs("div", {
				key: "runtime",
				className: "dsm-manus-settings-group",
				children: [
					jsx.jsx("h3", { className: "dsm-manus-settings-group-title", children: t("settings.runtime.section") }),
					numberField("pollIntervalMs", t("settings.field.pollIntervalMs"), undefined, { min: 500, max: 30000 }),
					numberField("pollMaxSeconds", t("settings.field.pollMaxSeconds"), undefined, { min: 30, max: 86400 }),
					numberField("requestTimeoutMs", t("settings.field.requestTimeoutMs"), undefined, { min: 5000, max: 300000 }),
					numberField("contextWindow", t("settings.field.contextWindow"), undefined, { min: 1000 }),
					numberField("maxTokens", t("settings.field.maxTokens"), undefined, { min: 100 }),
					booleanField("trackCredits", t("settings.field.trackCredits")),
					booleanField("showProgress", t("settings.field.showProgress")),
					booleanField("verboseEvents", t("settings.field.verboseEvents"))
				]
			}));

			const unsaved = config.status === "ready" && dirty();
			body.push(jsx.jsxs("div", {
				key: "actions",
				className: "dsm-manus-settings-actions",
				children: [
					jsx.jsx("button", {
						type: "button",
						className: "dsm-manus-settings-button",
						"data-variant": "primary",
						disabled: busy || !unsaved,
						onClick: save,
						children: t("settings.save")
					}),
					jsx.jsx("button", {
						type: "button",
						className: "dsm-manus-settings-button",
						disabled: busy,
						onClick: reload,
						children: t("settings.reset")
					}),
					feedback === undefined
						? null
						: jsx.jsx("span", { className: "dsm-manus-settings-feedback", "data-tone": feedback.tone, children: feedback.text }),
					unsaved && feedback === undefined
						? jsx.jsx("span", { className: "dsm-manus-settings-hint", children: t("settings.unsaved") })
						: null
				]
			}));

			return jsx.jsx("div", { className: "dsm-manus-settings", children: body });
		}

		/**
		 * Provider gate: renders nothing unless this session's selected model is
		 * one of ours, so the shared seats stay free for other bundles.
		 */
		function ManusCreditsGate(props) {
			const { t, position, useProjection, useSession } = props;
			const projection = useProjection?.("modelSelection");
			const selection = projection?.next ?? projection?.lastUsed;
			const provider = typeof selection?.provider === "string" ? selection.provider : "";
			if (provider !== PROVIDER) return null;
			if (position !== "composer" && position !== "stats") return null;
			return jsx.jsx(ManusCredits, { t, sessionId: props.sessionId, useSession });
		}
		/** Stable browser-plugin name. */
		const name = "manus-llm-client";
		/** Client services this bundle needs: slot seats and copy. */
		const inject = ["slots", "locale"];

		function apply(ctx) {
			try {
				ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), "manus-llm: client copy");
				const t = ctx.locale.bind(NAMESPACE);
				const register = (slotName, id, order, position) => {
					try {
						ctx.slots.inject(slotName, () => ctx.slots.register({
							name: slotName,
							id,
							order,
							locale: NAMESPACE,
							inject: () => ({ t, position })
						}, ManusCreditsGate));
					} catch (error) {
						console.error(`[manus-llm] credits slot "${slotName}" failed to register (host provider unaffected):`, error);
					}
				};
				register("conversation.input.left", "manus-llm-composer-credits", 6, "composer");
				register("conversation.composer.dock", "manus-llm-stats-credits", 12, "stats");

				// The plugin's own settings page, in the settings dialog's left
				// menu. Order 30 sits between the Skills page (25) and Market
				// (40) — the provider-ish neighbourhood.
				try {
					ctx.slots.inject("settings.section", () => ctx.slots.register({
						name: "settings.section",
						id: "manus",
						order: 30,
						label: () => t("settings.nav"),
						locale: NAMESPACE,
						inject: () => ({ t })
					}, ManusSettings));
				} catch (error) {
					console.error("[manus-llm] settings section failed to register (composer readout unaffected):", error);
				}
			} catch (error) {
				console.error("[manus-llm] client bundle failed to load (host provider unaffected):", error);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
