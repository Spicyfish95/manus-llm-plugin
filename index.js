/**
 * @local/manus-llm — Host plugin entry.
 *
 * Registers the Manus adapter on ctx.llm and exposes its configuration as a
 * configurable provider so the web Models page can activate and edit it.
 */
import z from "@deepseek-ai/schemastery";
import { ManusAdapter } from "./adapter.js";

export const name = "manus-llm";

/** The adapter stays inert without this service. */
export const inject = ["llm"];

/** Model catalog: Manus agent profiles as selectable "models". */
const MODEL_CATALOG = [
	{
		id: "standard",
		name: "Manus Standard",
		description: "Default Manus agent profile; balanced speed and capability."
	},
	{
		id: "lite",
		name: "Manus Lite",
		description: "Faster, lighter profile; lower credit usage."
	},
	{
		id: "max",
		name: "Manus Max",
		description: "Deepest reasoning profile; slowest and highest credit usage."
	},
	{
		id: "max-medium",
		name: "Manus Max (Medium)",
		description: "Max profile with medium thinking depth."
	},
	{
		id: "max-high",
		name: "Manus Max (High)",
		description: "Max profile with high thinking depth."
	},
	{
		id: "max-extra",
		name: "Manus Max (Extra)",
		description: "Max profile with extra thinking depth (the plain max default)."
	},
	{
		id: "max-ultra",
		name: "Manus Max (Ultra)",
		description: "Max profile with the deepest reasoning; slowest, highest cost."
	}
];

const PROFILES = new Set(["standard", "lite", "max", "max-medium", "max-high", "max-extra", "max-ultra"]);

/** Loader schema for the plugin's deployment controls. */
export const Config = z.object({
	apiKeyEnv: z.string().role("credential-ref").default("MANUS_API_KEY").volatile(),
	defaultProfile: z.union([
		z.const("standard"),
		z.const("lite"),
		z.const("max"),
		z.const("max-medium"),
		z.const("max-high"),
		z.const("max-extra"),
		z.const("max-ultra")
	]).default("standard"),
	locale: z.string().default("zh-CN"),
	pollIntervalMs: z.number().min(500).max(30000).default(2000),
	pollMaxSeconds: z.number().min(30).max(86400).default(1200),
	requestTimeoutMs: z.number().min(5000).max(300000).default(60000),
	contextWindow: z.number().min(1000).default(1000000),
	maxTokens: z.number().min(100).default(32000),
	showProgress: z.boolean().default(false),
	verboseEvents: z.boolean().default(false)
});

/**
 * Validate one profile id from the model id slot.
 * Unknown ids fall back to the configured default rather than failing the call,
 * because catalog ids travel through durable history.
 */
function normalizeProfile(model, fallback) {
	return PROFILES.has(model) ? model : PROFILES.has(fallback) ? fallback : "standard";
}

export function apply(ctx, config) {
	const entryId = ctx.fiber?.entry?.options?.id ?? name;
	/** Resolve the live connection snapshot each dispatch reads. */
	const resolveConfig = () => {
		const apiKeyEnv = config.apiKeyEnv?.get?.() ?? config.apiKeyEnv ?? "MANUS_API_KEY";
		// The credentials seam resolves refs against $DSH_HOME/.env and the
		// process environment; synchronous here means the key must be present
		// at plugin activation. Missing keys surface as MISSING_CREDENTIAL on
		// first call through the same live lookup instead.
		const credentials = ctx.get("credentials");
		let apiKey;
		if (credentials !== undefined) {
			try {
				// Synchronous best-effort read of the ambient env backing the
				// credentials store; the async resolve path is used in generate().
				const ref = apiKeyEnv;
				const ambient = process.env[ref];
				if (typeof ambient === "string" && ambient.trim().length > 0) apiKey = ambient.trim();
			} catch (_unreadableEnvironment) {}
		} else {
			const ambient = process.env[apiKeyEnv];
			if (typeof ambient === "string" && ambient.trim().length > 0) apiKey = ambient.trim();
		}
		const fallbackProfile = config.defaultProfile?.get?.() ?? config.defaultProfile ?? "standard";
		return {
			apiKey,
			apiKeyEnv,
			locale: (config.locale?.get?.() ?? config.locale ?? "").trim() || undefined,
			pollIntervalMs: config.pollIntervalMs?.get?.() ?? config.pollIntervalMs ?? 2000,
			pollMaxSeconds: config.pollMaxSeconds?.get?.() ?? config.pollMaxSeconds ?? 1200,
			requestTimeoutMs: config.requestTimeoutMs?.get?.() ?? config.requestTimeoutMs ?? 60000,
			contextWindow: config.contextWindow?.get?.() ?? config.contextWindow ?? 1000000,
			maxTokens: config.maxTokens?.get?.() ?? config.maxTokens ?? 32000,
			showProgress: config.showProgress?.get?.() ?? config.showProgress ?? false,
			verboseEvents: config.verboseEvents?.get?.() ?? config.verboseEvents ?? false,
			models: MODEL_CATALOG,
			profileOf: (model) => normalizeProfile(model, fallbackProfile)
		};
	};

	const log = (message) => {
		ctx.logger?.info?.(message);
	};

	const adapter = new ManusAdapter(resolveConfig, log);
	ctx.llm.registerAdapter(["manus"], adapter);

	// Configurable-provider directory: the web Models page reads this to offer
	// activation, a settings namespace, and model discovery for the route.
	ctx.llm.registerConfigurableProviders([{
		provider: "manus",
		displayName: "Manus",
		settingsNs: entryId,
		settingsPath: [],
		defaultBaseURL: "https://api.manus.ai",
		nativeAuth: { env: ["MANUS_API_KEY"] }
	}]);

	// Model discovery for the Models page's "discover" action.
	ctx.llm.registerModelDiscovery(entryId, async (request, signal) => {
		signal?.throwIfAborted?.();
		// Manus has no /models endpoint; the profile list is static.
		return MODEL_CATALOG.map((model) => ({
			id: model.id,
			name: model.name,
			contextWindow: config.contextWindow?.get?.() ?? config.contextWindow ?? 1000000,
			maxTokens: config.maxTokens?.get?.() ?? config.maxTokens ?? 32000
		}));
	});

	ctx.effect(() => () => {
		// Adapter registration is disposed with the fiber by ctx.effect inside
		// registerAdapter; nothing extra to release here.
	}, "manus-llm: lifetime");
}
