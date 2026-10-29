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
			"credits.hint": "余额来自 Manus 官方接口；每轮对话结束后自动刷新。"
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
			"credits.hint": "Balance comes from the Manus API; refreshed after every turn."
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
