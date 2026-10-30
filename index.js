/**
 * Manus as a DSH model provider.
 *
 * Host half: registers a `manus` LLM adapter, a configurable provider entry
 * (so the Models page and the settings dialog can find it), model discovery,
 * and three loopback-only routes used by the plugin's own browser half:
 *
 *   GET  /plugins/manus-llm/credits?sessionId=…  → live balance + last-turn spend
 *   GET  /plugins/manus-llm/config               → settings values + revision
 *   POST /plugins/manus-llm/config               → settings.mutate (volatile-gated)
 *   GET  /plugins/manus-llm/credential           → API-key status
 *   POST /plugins/manus-llm/credential           → store the API key
 *   DELETE /plugins/manus-llm/credential         → clear the API key
 *   GET  /plugins/manus-llm/test                 → last connection probe result
 *   POST /plugins/manus-llm/test                 → run a connection probe now
 *
 * Every settings field carries `.volatile()`: DSH's settings write gate
 * refuses any write to a non-volatile path, and `volatileForm` hides
 * namespaces that expose none. Writes funnel through `settings.mutate` so the
 * volatile gate stays the single authority, and a stale revision surfaces as
 * a conflict instead of clobbering another window.
 */
import z from "@deepseek-ai/schemastery";
import { ManusAdapter, MANUS_API_BASE } from "./adapter.js";

export const name = "manus-llm";
export const inject = ["llm"];

const PROVIDER = "manus";
/**
 * The one place the key is stored. The reference name is a fixed implementation
 * detail, not a user setting: exposing it as a read-only "credential reference"
 * field only invited confusion (it could never be edited), so it is gone from
 * the settings surface and lives here as a constant.
 */
const CREDENTIAL_REF = "MANUS_API_KEY";
const CREDITS_PATH = "/plugins/manus-llm/credits";
const CONFIG_PATH = "/plugins/manus-llm/config";
const CREDENTIAL_PATH = "/plugins/manus-llm/credential";
const TEST_PATH = "/plugins/manus-llm/test";

/** Thinking levels of the Max tier. The id IS the wire `agent_profile`. */
const REASONING_EFFORTS = [
	{ id: "max", name: "default", description: "Max 档的默认思考等级。" },
	{ id: "max-medium", name: "中", description: "中等思考强度。" },
	{ id: "max-high", name: "高", description: "较高思考强度。" },
	{ id: "max-extra", name: "增强", description: "增强思考强度。" },
	{ id: "max-ultra", name: "极致", description: "最高思考强度。" }
];
const EFFORT_IDS = new Set(REASONING_EFFORTS.map((effort) => effort.id));

/** The three tiers exposed as models, in menu order. */
const MODEL_CATALOG = [
	{ id: "standard", name: "Manus Standard", description: "Manus 标准档，日常任务与快速迭代。" },
	{ id: "lite", name: "Manus Lite", description: "Manus 轻量档，最低消耗，适合简单问答。" },
	{ id: "max", name: "Manus Max", description: "Manus Max 档，可再选思考等级（默认/中/高/增强/极致）。" }
];
const TIERS = new Set(MODEL_CATALOG.map((model) => model.id));

/** Per-model context-window choices offered in the settings page. */
const CONTEXT_OPTIONS = [200000, 500000, 1000000];
const DEFAULT_CONTEXT_WINDOW = 1000000;

/** Credit readout placement: inside the composer toolbar or below it. */
const CREDIT_POSITIONS = ["composer", "dock"];

/** Unwrap a live `{get(): T}` volatile ref, falling back on null/undefined. */
function unwrap(value, fallback) {
	const plain = value?.get?.() ?? value;
	return plain === null || plain === undefined ? fallback : plain;
}

function contextField() {
	return z.union(CONTEXT_OPTIONS.map((value) => z.const(value))).default(DEFAULT_CONTEXT_WINDOW);
}

export const Config = z.object({
	defaultProfile: z
		.union([z.const("standard"), z.const("lite"), z.const("max")])
		.default("max")
		.volatile()
		.description("默认模型档位；对话里仍可从模型菜单切换。"),
	locale: z.string().default("zh-CN").volatile().description("传给 Manus 的界面/语言区域，例如 zh-CN 或 en-US。"),
	pollIntervalMs: z
		.number()
		.min(500)
		.max(30000)
		.default(2000)
		.volatile()
		.description("轮询 Manus 任务事件的间隔（毫秒）。"),
	pollMaxSeconds: z
		.number()
		.min(30)
		.max(86400)
		.default(1200)
		.volatile()
		.description("单轮任务最长等待时间（秒）；超时会尝试停止任务并报错。"),
	requestTimeoutMs: z
		.number()
		.min(5000)
		.max(300000)
		.default(60000)
		.volatile()
		.description("单个 HTTP 请求超时（毫秒）。"),
	modelContexts: z
		.object({
			standard: contextField(),
			lite: contextField(),
			max: contextField()
		})
		.default({ standard: DEFAULT_CONTEXT_WINDOW, lite: DEFAULT_CONTEXT_WINDOW, max: DEFAULT_CONTEXT_WINDOW })
		.volatile()
		.description("每个模型档位单独上报给对话的上下文窗口（20 万 / 50 万 / 100 万）。"),
	maxTokens: z.number().min(100).default(32000).volatile().description("单轮最大输出 token 预算（上报值）。"),
	trackCredits: z
		.boolean()
		.default(true)
		.volatile()
		.description("是否在每轮对话前后读取积分余额，并在工具栏显示本轮消耗。"),
	creditPosition: z
		.union([z.const("composer"), z.const("dock")])
		.default("composer")
		.volatile()
		.description("积分显示位置：输入框工具栏内（composer）或输入框下方（dock）。"),
	showProgress: z
		.boolean()
		.default(false)
		.volatile()
		.description("是否把 Manus 的中间进度消息也流式输出到对话里。"),
	verboseEvents: z.boolean().default(false).volatile().description("调试用：把非对话事件也写入日志。"),
	apiKeyLabel: z
		.string()
		.default("ManusApikey01")
		.volatile()
		.description("API Key 在账号页列表里显示的名称。")
});

function normalizeTier(model, fallback) {
	if (typeof model === "string" && TIERS.has(model)) return model;
	return TIERS.has(fallback) ? fallback : "standard";
}

function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(payload);
}

function loopbackOrigin(req) {
	const origin = req.headers.origin;
	if (typeof origin !== "string" || origin.length === 0) return true;
	try {
		const host = new URL(origin).hostname;
		return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
	} catch {
		return false;
	}
}

function safeMessage(error) {
	const text = typeof error?.message === "string" ? error.message : String(error ?? "");
	return text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]").slice(0, 300);
}

async function readJsonBody(req, limitBytes = 8192) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limitBytes) throw new Error("request body too large");
		chunks.push(chunk);
	}
	if (size === 0) return {};
	const text = Buffer.concat(chunks).toString("utf8");
	return text.length === 0 ? {} : JSON.parse(text);
}

/** Single-segment writable settings fields (nested modelContexts is special). */
const WRITABLE_FIELDS = new Set([
	"defaultProfile",
	"locale",
	"pollIntervalMs",
	"pollMaxSeconds",
	"requestTimeoutMs",
	"maxTokens",
	"trackCredits",
	"creditPosition",
	"showProgress",
	"verboseEvents",
	"apiKeyLabel"
]);

export function apply(ctx, config) {
	const entryId = ctx.fiber?.entry?.options?.id ?? name;

	// Register the settings page policy. `auto: true` lets the settings
	// dialog render this entry's volatile fields without a bespoke client
	// page; the plugin's own page is an extra surface, not a replacement.
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.effect(() => settingsCtx.settings.configure({ auto: true }, ctx.fiber));
	});

	const contextWindows = () => {
		const raw = unwrap(config.modelContexts, {});
		const source = typeof raw === "object" && raw !== null ? raw : {};
		const windows = {};
		for (const tier of TIERS) {
			const value = source[tier];
			windows[tier] = CONTEXT_OPTIONS.includes(value) ? value : DEFAULT_CONTEXT_WINDOW;
		}
		return windows;
	};

	const resolveConfig = () => {
		const fallbackTier = unwrap(config.defaultProfile, "max");
		const windows = contextWindows();
		return {
			// Internal only: the credential slot name the adapter resolves. It is
			// deliberately absent from the Config schema and from the settings
			// payload, so it can never show up as an editable "reference" field.
			apiKeyEnv: CREDENTIAL_REF,
			locale: unwrap(config.locale, "zh-CN"),
			pollIntervalMs: unwrap(config.pollIntervalMs, 2000),
			pollMaxSeconds: unwrap(config.pollMaxSeconds, 1200),
			requestTimeoutMs: unwrap(config.requestTimeoutMs, 60000),
			maxTokens: unwrap(config.maxTokens, 32000),
			trackCredits: unwrap(config.trackCredits, true) === true,
			creditPosition: CREDIT_POSITIONS.includes(unwrap(config.creditPosition, "composer"))
				? unwrap(config.creditPosition, "composer")
				: "composer",
			showProgress: unwrap(config.showProgress, false) === true,
			verboseEvents: unwrap(config.verboseEvents, false) === true,
			apiKeyLabel: unwrap(config.apiKeyLabel, "ManusApikey01"),
			models: MODEL_CATALOG,
			reasoningEfforts: REASONING_EFFORTS,
			contextWindows: windows,
			contextWindowOf: (model) => windows[normalizeTier(model, fallbackTier)] ?? DEFAULT_CONTEXT_WINDOW,
			tierOf: (model, effort) => {
				if (model === "max" && typeof effort === "string" && EFFORT_IDS.has(effort)) return effort;
				return normalizeTier(model, fallbackTier);
			}
		};
	};

	const resolveApiKey = async (ref) => {
		const credentials = ctx.get("credentials");
		if (credentials !== undefined) {
			const hit = await credentials.resolve(ref);
			if (hit !== undefined && typeof hit.value === "string" && hit.value.trim().length > 0) return hit.value.trim();
		}
		const ambient = process.env[ref];
		return typeof ambient === "string" && ambient.trim().length > 0 ? ambient.trim() : undefined;
	};

	const log = (message) => {
		ctx.logger?.info?.(message);
	};

	// Per-session last-turn spend, bounded so a long-lived process cannot
	// grow it without limit. In-memory only: it is a readout, not state.
	const creditTurns = new Map();
	const credits = {
		record(sessionId, spent) {
			if (!Number.isFinite(spent)) return;
			creditTurns.set(sessionId ?? "", { spent, at: Date.now() });
			if (creditTurns.size > 64) {
				let oldestKey;
				let oldestAt = Infinity;
				for (const [key, value] of creditTurns) {
					if (value.at < oldestAt) {
						oldestAt = value.at;
						oldestKey = key;
					}
				}
				if (oldestKey !== undefined) creditTurns.delete(oldestKey);
			}
		},
		lastTurn(sessionId) {
			return creditTurns.get(sessionId ?? "");
		}
	};

	const adapter = new ManusAdapter(resolveConfig, resolveApiKey, log, credits);
	ctx.llm.registerAdapter([PROVIDER], adapter);

	ctx.llm.registerConfigurableProviders([
		{
			provider: PROVIDER,
			displayName: "Manus",
			settingsNs: entryId,
			settingsPath: [],
			defaultBaseURL: MANUS_API_BASE,
			nativeAuth: { env: ["MANUS_API_KEY"] }
		}
	]);

	ctx.llm.registerModelDiscovery(entryId, async (request, signal) => {
		signal?.throwIfAborted?.();
		const conf = resolveConfig();
		return MODEL_CATALOG.map((model) => ({
			id: model.id,
			name: model.name,
			description: model.description,
			contextWindow: conf.contextWindowOf(model.id),
			maxTokens: conf.maxTokens
		}));
	});

	/** Last connection probe, kept in memory so the page can show it. */
	let lastProbe;

	/**
	 * TTL cache for the Manus balance endpoint. Every client poll used to hit
	 * `/v2/usage.availableCredits`; now concurrent callers share one upstream
	 * call and repeats within `CREDITS_CACHE_TTL_MS` are served from memory,
	 * so the 60s UI polling collapses to at most one upstream call per TTL
	 * window no matter how many windows are open. Failures are cached too
	 * (half TTL) so an erroring key does not trigger a retry storm.
	 */
	const CREDITS_CACHE_TTL_MS = 30_000;
	const CREDITS_CACHE_ERROR_TTL_MS = 15_000;
	let creditsCache;
	async function fetchCreditsCached(apiKey) {
		if (creditsCache !== undefined && Date.now() - creditsCache.at < (creditsCache.ok ? CREDITS_CACHE_TTL_MS : CREDITS_CACHE_ERROR_TTL_MS) && creditsCache.error === undefined) {
			return creditsCache.value;
		}
		const pending = adapter.fetchCredits(apiKey);
		creditsCache = { at: Date.now(), ok: true, value: pending };
		try {
			const value = await pending;
			creditsCache = { at: Date.now(), ok: true, value };
			return value;
		} catch (error) {
			creditsCache = { at: Date.now(), ok: false, value: undefined, error };
			return undefined;
		}
	}

	ctx.inject(["webServer"], (webCtx) => {
		webCtx.effect(
			() =>
				webCtx.webServer.register({
					kind: "exact",
					path: CREDITS_PATH,
					handler: async (req, res) => {
						if (req.method !== "GET") {
							json(res, 405, { ok: false, error: { code: "method-not-allowed", message: "仅支持 GET" } });
							return;
						}
						if (!loopbackOrigin(req)) {
							json(res, 403, { ok: false, error: { code: "origin-not-trusted", message: "仅允许本机访问" } });
							return;
						}
						try {
							const sessionId = new URL(req.url ?? "/", "http://localhost").searchParams.get("sessionId") ?? "";
							const apiKey = await resolveApiKey(CREDENTIAL_REF);
							if (apiKey === undefined) {
								json(res, 200, {
									ok: false,
									error: { code: "missing-credential", message: "未配置 Manus API Key" }
								});
								return;
							}
							const balance = await fetchCreditsCached(apiKey);
							const lastTurn = credits.lastTurn(sessionId);
							json(res, 200, {
								ok: true,
								...(balance === undefined ? {} : { credits: balance }),
								...(lastTurn === undefined ? {} : { lastTurn })
							});
						} catch (error) {
							json(res, 500, { ok: false, error: { code: "credits-unavailable", message: safeMessage(error) } });
						}
					}
				}),
			"manus-llm: credits route"
		);

		// Connection probe: one Manus call, no state change. GET reports the
		// last result so a freshly opened page can show it without hitting
		// the API; POST runs a fresh check (the 「测试」button).
		webCtx.effect(
			() =>
				webCtx.webServer.register({
					kind: "exact",
					path: TEST_PATH,
					handler: async (req, res) => {
						if (req.method !== "GET" && req.method !== "POST") {
							json(res, 405, { ok: false, error: { code: "method-not-allowed", message: "仅支持 GET/POST" } });
							return;
						}
						if (!loopbackOrigin(req)) {
							json(res, 403, { ok: false, error: { code: "origin-not-trusted", message: "仅允许本机访问" } });
							return;
						}
						try {
							const apiKey = await resolveApiKey(CREDENTIAL_REF);
							if (apiKey === undefined) {
								lastProbe = undefined;
								json(res, 200, {
									ok: true,
									configured: false,
									connected: false,
									error: { code: "missing-credential", message: "未配置 API Key" }
								});
								return;
							}
							if (req.method === "GET") {
								json(res, 200, { ok: true, configured: true, ...(lastProbe === undefined ? {} : { probe: lastProbe }) });
								return;
							}
							// POST probe: reuse the credits TTL cache when fresh —
							// a probe and a balance poll hit the same upstream
							// endpoint, so a recent successful read doubles as a
							// successful probe without a second Manus call.
							const cached = creditsCache !== undefined && creditsCache.error === undefined && Date.now() - creditsCache.at < CREDITS_CACHE_TTL_MS && creditsCache.value !== undefined
								? await creditsCache.value
								: undefined;
							if (cached !== undefined) {
								const probe = { ok: true, total: cached.total };
								lastProbe = probe;
								json(res, 200, { ok: true, configured: true, connected: true, probe });
								return;
							}
							const probe = await adapter.probe(apiKey);
							lastProbe = probe;
							json(res, 200, {
								ok: true,
								configured: true,
								connected: probe.ok === true,
								probe
							});
						} catch (error) {
							json(res, 500, { ok: false, error: { code: "probe-failed", message: safeMessage(error) } });
						}
					}
				}),
			"manus-llm: test route"
		);

		webCtx.effect(
			() =>
				webCtx.webServer.register({
					kind: "exact",
					path: CONFIG_PATH,
					handler: async (req, res) => {
						if (req.method !== "GET" && req.method !== "POST") {
							json(res, 405, { ok: false, error: { code: "method-not-allowed", message: "仅支持 GET/POST" } });
							return;
						}
						if (!loopbackOrigin(req)) {
							json(res, 403, { ok: false, error: { code: "origin-not-trusted", message: "仅允许本机访问" } });
							return;
						}
						const settings = ctx.get("settings");
						const credentials = ctx.get("credentials");

						if (req.method === "GET") {
							let revision;
							try {
								revision = settings?.describe?.()?.find?.((row) => row.ns === entryId)?.revision;
							} catch {
								revision = undefined;
							}
							let credential;
							try {
								credential = await credentials?.describe?.(CREDENTIAL_REF);
							} catch {
								credential = undefined;
							}
							const conf = resolveConfig();
							json(res, 200, {
								ok: true,
								entryId,
								revision,
								credential: credential ?? { configured: false, writable: true },
								values: {
									defaultProfile: unwrap(config.defaultProfile, "max"),
									locale: conf.locale,
									pollIntervalMs: conf.pollIntervalMs,
									pollMaxSeconds: conf.pollMaxSeconds,
									requestTimeoutMs: conf.requestTimeoutMs,
									modelContexts: conf.contextWindows,
									maxTokens: conf.maxTokens,
									trackCredits: conf.trackCredits,
									creditPosition: conf.creditPosition,
									showProgress: conf.showProgress,
									verboseEvents: conf.verboseEvents,
									apiKeyLabel: conf.apiKeyLabel
								},
								contextOptions: CONTEXT_OPTIONS,
								models: MODEL_CATALOG,
								tiers: [...TIERS],
								creditPositions: CREDIT_POSITIONS,
								reasoningEfforts: REASONING_EFFORTS,
								...(lastProbe === undefined ? {} : { probe: lastProbe })
							});
							return;
						}

						if (settings === undefined) {
							json(res, 503, { ok: false, error: { code: "settings-unavailable", message: "设置服务不可用" } });
							return;
						}
						let body;
						try {
							body = await readJsonBody(req);
						} catch (error) {
							json(res, 400, { ok: false, error: { code: "invalid-body", message: safeMessage(error) } });
							return;
						}
						const ops = Array.isArray(body.ops) ? body.ops : [];
						if (ops.length === 0) {
							json(res, 400, { ok: false, error: { code: "empty-ops", message: "没有需要写入的字段" } });
							return;
						}
						const cleaned = [];
						for (const op of ops) {
							const path = Array.isArray(op?.path) ? op.path : [];
							const single = path.length === 1 && typeof path[0] === "string" && WRITABLE_FIELDS.has(path[0]);
							const nested =
								path.length === 2 &&
								path[0] === "modelContexts" &&
								typeof path[1] === "string" &&
								TIERS.has(path[1]) &&
								CONTEXT_OPTIONS.includes(op?.value);
							if (!single && !nested) {
								json(res, 400, {
									ok: false,
									error: { code: "not-writable", message: `字段不可写：${path.join(".") || "(空)"}` }
								});
								return;
							}
							cleaned.push(
								op.op === "unset" ? { op: "unset", path } : { op: "set", path, value: op.value }
							);
						}
						const revision = typeof body.revision === "number" ? body.revision : undefined;
						try {
							await settings.mutate(entryId, cleaned, revision);
							json(res, 200, {
								ok: true,
								revision: settings.describe().find((row) => row.ns === entryId)?.revision
							});
						} catch (error) {
							const conflict = error?.name === "SettingsConflictError" || /revision/i.test(String(error?.message ?? ""));
							json(res, conflict ? 409 : 400, {
								ok: false,
								error: {
									code: conflict ? "settings-conflict" : "write-failed",
									message: safeMessage(error)
								}
							});
						}
					}
				}),
			"manus-llm: config route"
		);

		webCtx.effect(
			() =>
				webCtx.webServer.register({
					kind: "exact",
					path: CREDENTIAL_PATH,
					handler: async (req, res) => {
						if (!loopbackOrigin(req)) {
							json(res, 403, { ok: false, error: { code: "origin-not-trusted", message: "仅允许本机访问" } });
							return;
						}
						const credentials = ctx.get("credentials");
						if (credentials === undefined) {
							json(res, 503, { ok: false, error: { code: "credentials-unavailable", message: "凭证服务不可用" } });
							return;
						}

						if (req.method === "GET") {
							const credential = await credentials.describe(CREDENTIAL_REF).catch(() => undefined);
							json(res, 200, { ok: true, credential: credential ?? { configured: false, writable: true } });
							return;
						}

						const url = new URL(req.url ?? "/", "http://localhost");
						const clear = req.method === "DELETE" || (req.method === "POST" && url.searchParams.get("action") === "clear");
						if (clear) {
							try {
								await credentials.unset(CREDENTIAL_REF);
								lastProbe = undefined;
								const credential = await credentials.describe(CREDENTIAL_REF).catch(() => undefined);
								json(res, 200, { ok: true, credential: credential ?? { configured: false, writable: true } });
							} catch (error) {
								json(res, 500, { ok: false, error: { code: "credential-unset-failed", message: safeMessage(error) } });
							}
							return;
						}
						if (req.method !== "POST") {
							json(res, 405, { ok: false, error: { code: "method-not-allowed", message: "仅支持 GET/POST/DELETE" } });
							return;
						}
						let body;
						try {
							body = await readJsonBody(req);
						} catch (error) {
							json(res, 400, { ok: false, error: { code: "invalid-body", message: safeMessage(error) } });
							return;
						}
						const value = typeof body.value === "string" ? body.value.trim() : "";
						if (value.length === 0) {
							json(res, 400, { ok: false, error: { code: "empty-credential", message: "API Key 不能为空" } });
							return;
						}
						try {
							await credentials.set(CREDENTIAL_REF, value);
							lastProbe = undefined;
							const credential = await credentials.describe(CREDENTIAL_REF).catch(() => undefined);
							json(res, 200, { ok: true, credential: credential ?? { configured: false, writable: true } });
						} catch (error) {
							json(res, 500, { ok: false, error: { code: "credential-write-failed", message: safeMessage(error) } });
						}
					}
				}),
			"manus-llm: credential route"
		);
	});

	// A volatile settings write re-derives nothing structural here: the
	// adapter re-reads `resolveConfig()` on every dispatch. The handler
	// exists so future structural changes have an obvious hook.
	ctx.on("loader/volatile-update", () => {});

	ctx.effect(() => () => {}, "manus-llm: lifetime");
}
