/**
 * dsh-manus-llm — Host plugin entry.
 *
 * Registers the Manus adapter on ctx.llm, exposes its configuration as a
 * configurable provider so the web Models page can activate and edit it, and
 * serves one read-only credit route for the composer readout.
 *
 * Settings integration (the dsh-connect-trae pattern for 0.1.7+):
 * - The Config schema's volatile-marked fields ARE the settings page form.
 *   The host's settings write gate rejects any edit outside a volatile node,
 *   and `SettingsForms.describe()` projects only volatile fields — a schema
 *   with no volatile field renders nothing and refuses every write.
 * - `settings.configure({ auto: true }, ctx.fiber)` registers this plugin's
 *   automatic page under the Loader entry id (`ctx.fiber.entry?.options.id`),
 *   which is also the settingsNs advertised through the configurable-provider
 *   directory — the key the Models page looks up.
 * - Volatile values arrive as live `{ get(): T }` references; every read
 *   unwraps with `value?.get?.() ?? value`.
 *
 * Model tiers: three catalog entries (standard / lite / max). The `max`
 * entry carries the reasoning metadata, so the composer's model picker offers
 * the deeper Max thinking levels as reasoning efforts — Manus itself takes
 * them as `agent_profile` values, which is exactly what an effort id is here.
 */
import z from "@deepseek-ai/schemastery";
import { ManusAdapter, MANUS_API_BASE } from "./adapter.js";

export const name = "manus-llm";

/** The adapter stays inert without this service; webServer is optional. */
export const inject = ["llm"];

/** The provider route key shared by the adapter, the directory, and the UI. */
const PROVIDER = "manus";

/** Plugin-owned credit route consumed by the browser half. */
const CREDITS_PATH = "/plugins/manus-llm/credits";

/**
 * Reasoning efforts offered under the `max` model. Every id is a valid
 * `agent_profile` value, and `max` is the plain default thinking level
 * ("max" with no thinking-level suffix) — so the default effort needs no
 * rewriting on the wire.
 */
const REASONING_EFFORTS = [
	{ id: "max", name: "默认", description: "Max 默认思考等级（Manus 的 max 档默认值）。" },
	{ id: "max-medium", name: "中", description: "Max 档，中等思考深度。" },
	{ id: "max-high", name: "高", description: "Max 档，较高思考深度。" },
	{ id: "max-extra", name: "增强", description: "Max 档，更强思考深度（耗时与积分更高）。" },
	{ id: "max-ultra", name: "极致", description: "Max 档，最深推理（最慢、积分消耗最高）。" }
];

const EFFORT_IDS = new Set(REASONING_EFFORTS.map((effort) => effort.id));

/** Model catalog: three Manus agent tiers as selectable "models". */
const MODEL_CATALOG = [
	{
		id: "standard",
		name: "Manus Standard",
		description: "Manus 标准代理档位：速度与能力均衡。"
	},
	{
		id: "lite",
		name: "Manus Lite",
		description: "轻量快速档位，积分消耗更低。"
	},
	{
		id: "max",
		name: "Manus Max",
		description: "深度推理档位；可在模型选择器里挑选 Max 的思考等级。"
	}
];

const TIERS = new Set(MODEL_CATALOG.map((model) => model.id));

/** Unwrap one volatile live reference (or plain value) without dropping siblings. */
function unwrap(value, fallback) {
	const resolved = value?.get?.() ?? value;
	return resolved === undefined || resolved === null ? fallback : resolved;
}

/** Settings schema for the plugin: every volatile field is editable on the
 * web (Models page editor card + the plugin's automatic settings page). */
export const Config = z.object({
	apiKeyEnv: z.string().role("credential-ref").default("MANUS_API_KEY").volatile()
		.description("存储 Manus API Key 的凭证引用名（环境变量名）。在「设置 → 模型」页选择 Manus 并输入 Key 后自动写入。"),
	defaultProfile: z.union([
		z.const("standard"),
		z.const("lite"),
		z.const("max")
	]).default("standard").volatile()
		.description("未知模型 id 时回退的 Manus 档位。"),
	locale: z.string().default("zh-CN").volatile()
		.description("Manus 任务输出语言（BCP 47，如 zh-CN / en）。"),
	pollIntervalMs: z.number().min(500).max(30000).default(2000).volatile()
		.description("轮询任务消息的间隔（毫秒）。"),
	pollMaxSeconds: z.number().min(30).max(86400).default(1200).volatile()
		.description("单回合轮询上限（秒）；超时会停止远端任务并以 TIMEOUT 失败。"),
	requestTimeoutMs: z.number().min(5000).max(300000).default(60000).volatile()
		.description("单次 HTTP 请求超时（毫秒）。"),
	contextWindow: z.number().min(1000).default(1000000).volatile()
		.description("上报给 DSH 的上下文窗口（用于压缩与预算估算）。"),
	maxTokens: z.number().min(100).default(32000).volatile()
		.description("上报给 DSH 的单回合最大输出 token。"),
	trackCredits: z.boolean().default(true).volatile()
		.description("记录每轮对话消耗的积分（回合前后各读一次余额，用于工具栏显示「上轮消耗」）。"),
	showProgress: z.boolean().default(false).volatile()
		.description("是否把 Manus 的 progress 中间消息并入回复文本。"),
	verboseEvents: z.boolean().default(false).volatile()
		.description("在日志中记录每个轮询事件（调试用）。")
});

/**
 * Validate one tier id from the model id slot. Unknown ids fall back to the
 * configured default rather than failing the call, because catalog ids travel
 * through durable history.
 */
function normalizeTier(model, fallback) {
	if (TIERS.has(model)) return model;
	return TIERS.has(fallback) ? fallback : "standard";
}

/** Write one JSON answer on a plugin route (mirrors dsh-connect-trae's helper). */
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}

/** Only the local GUI may call plugin routes; a foreign Origin is refused. */
function loopbackOrigin(req) {
	const origin = req.headers.origin;
	if (origin === undefined) return true;
	try {
		const { hostname } = new URL(origin);
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
	} catch {
		return false;
	}
}

/** Strip anything token-shaped out of an error before it reaches the browser. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error))
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]")
		.slice(0, 300);
}

export function apply(ctx, config) {
	const entryId = ctx.fiber?.entry?.options?.id ?? name;

	// Register the automatic settings page under the Loader entry id — the same
	// namespace the configurable-provider directory advertises, which is what
	// the Models page's editor card binds to. Rejected politely when the
	// settings service is absent (the adapter keeps working off loader config).
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.effect(() => settingsCtx.settings.configure({ auto: true }, ctx.fiber));
	});

	/** Resolve the live connection snapshot each dispatch reads. Volatile
	 * fields arrive as live references and unwrap per read, so a settings
	 * write reaches the next dispatch without a plugin restart. */
	const resolveConfig = () => {
		const apiKeyEnv = unwrap(config.apiKeyEnv, "MANUS_API_KEY");
		const fallbackTier = unwrap(config.defaultProfile, "standard");
		return {
			apiKeyEnv,
			locale: (unwrap(config.locale, "zh-CN") || "").trim() || undefined,
			pollIntervalMs: unwrap(config.pollIntervalMs, 2000),
			pollMaxSeconds: unwrap(config.pollMaxSeconds, 1200),
			requestTimeoutMs: unwrap(config.requestTimeoutMs, 60000),
			contextWindow: unwrap(config.contextWindow, 1000000),
			maxTokens: unwrap(config.maxTokens, 32000),
			trackCredits: unwrap(config.trackCredits, true) === true,
			showProgress: unwrap(config.showProgress, false) === true,
			verboseEvents: unwrap(config.verboseEvents, false) === true,
			models: MODEL_CATALOG,
			reasoningEfforts: REASONING_EFFORTS,
			tierOf: (model, effort) => {
				// `max` plus a deeper effort is exactly that agent_profile; every
				// other route keeps its own tier.
				if (model === "max" && typeof effort === "string" && EFFORT_IDS.has(effort)) return effort;
				return normalizeTier(model, fallbackTier);
			}
		};
	};

	/** Resolve the API key per dispatch: the credentials seam first (the
	 * managed store the web Models page writes, then ambient env / .env
	 * fallbacks), then the plain process environment. */
	const resolveApiKey = async (ref) => {
		const credentials = ctx.get("credentials");
		if (credentials !== undefined) {
			const hit = await credentials.resolve(ref);
			if (hit !== undefined && typeof hit.value === "string" && hit.value.trim().length > 0) {
				return hit.value.trim();
			}
		}
		const ambient = process.env[ref];
		if (typeof ambient === "string" && ambient.trim().length > 0) return ambient.trim();
		return undefined;
	};

	const log = (message) => {
		ctx.logger?.info?.(message);
	};

	/**
	 * Per-session record of the last finished turn's credit delta, written by
	 * the adapter and read by the composer route. In-memory on purpose: it
	 * describes "the round that just ran", not durable history.
	 */
	const creditTurns = new Map();
	const credits = {
		record(sessionId, spent) {
			if (typeof spent !== "number" || !Number.isFinite(spent)) return;
			creditTurns.set(sessionId ?? "", { spent, at: Date.now() });
			// Bounded: one entry per live session, oldest evicted past 64.
			if (creditTurns.size > 64) {
				const oldest = [...creditTurns.entries()].sort((a, b) => a[1].at - b[1].at)[0];
				if (oldest !== undefined) creditTurns.delete(oldest[0]);
			}
		},
		lastTurn(sessionId) {
			return creditTurns.get(sessionId ?? "");
		}
	};

	const adapter = new ManusAdapter(resolveConfig, resolveApiKey, log, credits);
	ctx.llm.registerAdapter([PROVIDER], adapter);

	// Configurable-provider directory: the web Models page reads this to offer
	// activation, a settings namespace, and model discovery for the route.
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: "Manus",
		settingsNs: entryId,
		settingsPath: [],
		defaultBaseURL: MANUS_API_BASE,
		nativeAuth: { env: ["MANUS_API_KEY"] }
	}]);

	// Model discovery for the Models page's "discover" action.
	ctx.llm.registerModelDiscovery(entryId, async (request, signal) => {
		signal?.throwIfAborted?.();
		// Manus has no /models endpoint; the tier list is static.
		return MODEL_CATALOG.map((model) => ({
			id: model.id,
			name: model.name,
			contextWindow: unwrap(config.contextWindow, 1000000),
			maxTokens: unwrap(config.maxTokens, 32000)
		}));
	});

	/**
	 * Credit route for the composer readout: the authoritative balance plus the
	 * last finished turn's spend for the asking session. Read-only, loopback
	 * only, and the key never leaves the Host.
	 */
	ctx.inject(["webServer"], (webCtx) => {
		webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: CREDITS_PATH,
			handler: async (req, res) => {
				if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
				if (!loopbackOrigin(req)) return json(res, 403, { error: "origin-not-trusted" });
				const sessionId = new URL(req.url ?? "/", "http://localhost").searchParams.get("sessionId") ?? "";
				try {
					const apiKey = await resolveApiKey(unwrap(config.apiKeyEnv, "MANUS_API_KEY"));
					if (apiKey === undefined) return json(res, 200, { ok: false, error: { code: "missing-credential", message: "未配置 Manus API Key" } });
					const balance = await adapter.fetchCredits(apiKey);
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
		}), "manus-llm: credits route");
	});

	// Live-reload: a volatile settings write re-derives nothing structural here
	// (the adapter re-reads resolveConfig() per dispatch), so no rebuild is
	// needed. This handler exists to mirror the proven pattern and keep future
	// structural decisions cheap to add.
	ctx.on("loader/volatile-update", () => {});

	ctx.effect(() => () => {
		// Adapter registration is disposed with the fiber by ctx.effect inside
		// registerAdapter; nothing extra to release here.
	}, "manus-llm: lifetime");
}
