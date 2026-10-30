/**
 * dsh-manus-llm — Manus cloud agent as a DeepSeek Harness model provider.
 *
 * Manus API v2 (https://api.manus.ai) runs each "task" on Manus's cloud agent.
 * This adapter bridges the Harness LLM seam (`ctx.llm.registerAdapter`) to it:
 *
 *   harness messages  ──►  POST /v2/task.create            (first turn)
 *                          POST /v2/task.sendMessage       (follow-ups, tool results)
 *                          GET  /v2/task.listMessages      (poll until stopped)
 *   harness chunks    ◄──  chunk translation              (text-delta / block / usage / finish)
 *
 * Design decisions:
 * - One provider route `manus`; "models" are Manus agent tiers (standard/lite/max).
 *   The `max` tier advertises the deeper Max thinking levels as reasoning
 *   efforts — their ids ARE valid `agent_profile` values, so an effort needs no
 *   translation on the wire.
 *   A turn is one API task; a session maps to the same task across turns via the
 *   generated task_id written into the assistant replay state (durable, log-derived).
 * - Only the user's latest submitted text is forwarded to Manus. The harness
 *   system prompt and conversation history stay local: a Manus task keeps its
 *   own cross-turn context (one task per session), and forwarding the harness
 *   boilerplate made every new task open with a 10+KB "You are an AI agent…"
 *   blob that the Manus web UI renders as a giant attachment card.
 * - Polling drives the stream: after creating/sending a message, we poll
 *   task.listMessages (order=asc, start_event_id=cursor) and translate each
 *   new assistant_message into text-delta chunks with small synthetic delays so
 *   the UI shows progressive output. status_update(stopped|error) ends the turn.
 * - Tool calls are NOT supported (Manus has its own tools); we declare no tools
 *   and degrade gracefully: tool results are serialized as readable text.
 * - Generated files: Manus returns execution-environment paths plus expiring
 *   signed URLs in `attachments[]`. When a workspace is resolvable and
 *   `downloadAttachments` is on, every attachment is downloaded into
 *   `<workspace>/manus-files/`; images are additionally registered as durable
 *   image blocks (rendered inline by the GUI) and markdown links are rewritten
 *   to the plugin's loopback file route so they keep working after the signed
 *   URL expires. A failed download degrades to the original signed URL — a
 *   turn never fails because a file could not be saved.
 * - Errors map to the provider-neutral LlmError codes the retry plugin routes on.
 */
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LlmAdapter, LlmError, attributionHeaders, ToolCallId } from "@deepseek-ai/dsh-llm";

/** Manus OpenAPI v2 origin (also the configurable-provider defaultBaseURL). */
export const MANUS_API_BASE = "https://api.manus.ai";

/**
 * TTL for cached `usage.availableCredits` reads used by per-turn accounting
 * (fetchCreditsCached). 30s matches the host-side credits-route cache.
 */
const CREDITS_TTL_MS = 30_000;

/** Default sub-directory (inside the session workspace) that receives Manus files. */
export const DEFAULT_DOWNLOAD_DIR = "manus-files";

/** Hard ceiling for one downloaded attachment (defends against runaway archives). */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

/** Image media types the harness attachment store accepts (ImageMediaType). */
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Content types the harness store accepts, mapped from Manus `content_type`. */
function imageMediaType(contentType) {
	if (typeof contentType !== "string" || contentType.length === 0) return undefined;
	const normalized = contentType.trim().toLowerCase();
	if (IMAGE_MEDIA_TYPES.has(normalized)) return normalized;
	// Legacy spelling that browsers/APIs still emit.
	if (normalized === "image/jpg") return "image/jpeg";
	return undefined;
}

/** Drop everything a Windows/Unix filename cannot carry, keep unicode + spaces. */
export function sanitizeManusFileName(raw, fallback = "manus-file") {
	const base = typeof raw === "string" ? raw.replace(/^.*[\\/]/, "") : "";
	const cleaned = base
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/[<>:"|?*]/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+$/, "");
	const name = cleaned.length > 0 ? cleaned : fallback;
	// Windows caps the whole path; keep the leaf well under 255 chars.
	if (name.length <= 180) return name;
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
	return `${name.slice(0, 180 - ext.length)}${ext}`;
}

/** First free `<base>-2<ext>`, `<base>-3<ext>`… next to an existing file. */
async function uniqueWorkspacePath(dir, name) {
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	let candidate = path.join(dir, name);
	for (let index = 2; index < 1000; index += 1) {
		try {
			await access(candidate);
			candidate = path.join(dir, `${stem}-${index}${ext}`);
		} catch {
			return { filePath: candidate, fileName: path.basename(candidate) };
		}
	}
	return { filePath: candidate, fileName: path.basename(candidate) };
}

/** Read a validated string field from provider JSON, or throw MALFORMED_RESPONSE. */
function needString(value, what) {
	if (typeof value !== "string" || value.length === 0) {
		throw new LlmError(`Manus 返回的数据缺少有效字段「${what}」，请稍后重试。`, "MALFORMED_RESPONSE");
	}
	return value;
}

function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerce a Manus numeric field to a finite number. The live API mixes plain
 * numbers (`total_credits: 4063`) with numeric strings
 * (`next_refresh_time: "1793318400"`), so both are accepted.
 */
function numberField(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/**
 * The credits document. `usage.availableCredits` answers FLAT (fields at the
 * top level next to `ok`/`request_id`); older docs nest them under `data`, so
 * both shapes are accepted.
 */
function creditsPayload(raw) {
	if (isObject(raw?.data)) return raw.data;
	return isObject(raw) ? raw : undefined;
}

/** Parse a credits document into the readout shape, or undefined when unusable. */
function parseCredits(raw) {
	const data = creditsPayload(raw);
	if (data === undefined) return undefined;
	const total = numberField(data.total_credits);
	if (total === undefined) return undefined;
	const nextRefresh = numberField(data.next_refresh_time);
	const periodEnd = numberField(data.current_period_end);
	return {
		total,
		free: numberField(data.free_credits),
		periodic: numberField(data.periodic_credits),
		addon: numberField(data.addon_credits),
		refresh: numberField(data.refresh_credits),
		nextRefresh: nextRefresh !== undefined && nextRefresh > 0 ? nextRefresh : undefined,
		refreshInterval: typeof data.refresh_interval === "string" ? data.refresh_interval : "",
		periodEnd: periodEnd !== undefined && periodEnd > 0 ? periodEnd : undefined
	};
}

/** Extract the standard {ok, error:{code,message}} Manus envelope, or null. */
function errorEnvelope(raw) {
	if (!isObject(raw) || raw.ok !== false) return null;
	const error = isObject(raw.error) ? raw.error : {};
	const message = typeof error.message === "string" && error.message.length > 0
		? error.message
		: "Manus API request failed";
	return { code: typeof error.code === "string" ? error.code : "", message };
}

/** Map HTTP status + Manus error code onto the Harness failure taxonomy. */
function classifyError(status, code, message) {
	if (status === 401 || status === 403 || code === "unauthenticated" || code === "permission_denied") return "AUTH";
	if (status === 402 || code === "quota_exceeded" || code === "resource_exhausted") return "QUOTA";
	if (status === 429 || code === "rate_limited") return "RATE_LIMIT";
	if (status === 400 || status === 404 || status === 413 || code === "invalid_argument" || code === "not_found") return "INVALID_REQUEST";
	if (status >= 500) return "SERVER";
	return status === undefined ? "SERVER" : `HTTP_${status}`;
}

/** User-facing Chinese hint for one failure class (shown in the conversation). */
function hintFor(code, detail) {
	const suffix = typeof detail === "string" && detail.length > 0 ? `（${detail}）` : "";
	switch (code) {
		case "MISSING_CREDENTIAL":
			return "Manus 未配置 API Key：请打开「设置 → Manus」页面，在「账号」标签填入 API Key 后重试。";
		case "AUTH":
			return `Manus API Key 无效或已过期，请在「设置 → Manus」页面更新后重试${suffix}。`;
		case "QUOTA":
			return `Manus 积分不足，请充值后重试${suffix}。`;
		case "RATE_LIMIT":
			return `Manus 请求过于频繁，请稍后重试${suffix}。`;
		case "TIMEOUT":
			return `Manus 任务超时未返回结果${suffix}，可稍后重试或调高「任务最长等待」设置。`;
		case "INVALID_REQUEST":
			return `Manus 拒绝了本次请求${suffix}，请检查输入后重试。`;
		case "SERVER":
			return `Manus 服务异常${suffix}，请稍后重试。`;
		case "TRANSPORT":
			return `无法连接 Manus 服务${suffix}，请检查网络后重试。`;
		case "ABORTED":
			return "已取消本次 Manus 请求。";
		case "EMPTY_RESPONSE":
			return `Manus 没有返回任何内容${suffix}，请重试。`;
		case "MALFORMED_RESPONSE":
			return `Manus 返回了无法识别的数据${suffix}，请稍后重试。`;
		default:
			return `Manus 请求失败${suffix}，请稍后重试。`;
	}
}

/** Build a provider-neutral LlmError from an HTTP response body. */
function providerError(status, raw, requestId) {
	const envelope = errorEnvelope(raw);
	const detail = envelope?.message ?? `HTTP ${status}`;
	const code = classifyError(status, envelope?.code ?? "", detail);
	return new LlmError(hintFor(code, detail), code, {
		status,
		...(requestId ? { requestId } : {})
	});
}

/**
 * Compose the caller's cancellation with a per-request deadline. `AbortSignal
 * .timeout` aborts with a `TimeoutError`, which the catch below maps to TIMEOUT.
 */
function withTimeout(signal, timeoutMs) {
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return signal;
	const deadline = AbortSignal.timeout(timeoutMs);
	if (signal === undefined) return deadline;
	return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, deadline]) : signal;
}

/** Transport wrapper: turn fetch failures into TRANSPORT / TIMEOUT / ABORTED failures. */
async function requestJson(url, init, signal, timeoutMs) {
	const effective = withTimeout(signal, timeoutMs);
	try {
		const response = await fetch(url, { ...init, signal: effective, redirect: "error" });
		const text = await response.text();
		let raw;
		try {
			raw = JSON.parse(text);
		} catch {
			raw = undefined;
		}
		if (!response.ok) throw providerError(response.status, raw, response.headers.get("x-request-id") ?? undefined);
		if (!isObject(raw) || raw.ok !== true) {
			throw providerError(response.status, raw, response.headers.get("x-request-id") ?? undefined);
		}
		return raw;
	} catch (error) {
		if (error instanceof LlmError) throw error;
		if (signal?.aborted) throw new LlmError(hintFor("ABORTED"), "ABORTED", { cause: error });
		if (error instanceof Error && error.name === "TimeoutError") {
			throw new LlmError(hintFor("TIMEOUT"), "TIMEOUT", { cause: error });
		}
		if (effective !== signal && effective?.reason instanceof Error && effective.reason.name === "TimeoutError") {
			throw new LlmError(hintFor("TIMEOUT"), "TIMEOUT", { cause: error });
		}
		throw new LlmError(hintFor("TRANSPORT", error instanceof Error ? error.message : undefined), "TRANSPORT", { cause: error });
	}
}

/**
 * Render harness content blocks as plain text for a Manus user message.
 * Images (already projected to placeholders by LlmRuntime for text-only routes)
 * and reasoning blocks are dropped; tool results render their text content.
 */
function blocksToText(blocks) {
	return blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * Rewrite Manus execution-environment references inside an assistant message
 * into downloadable links. Per the official Attachments guide, the API returns
 * `content` with raw env paths (`![img](/home/ubuntu/x.png)`) while the actual
 * signed download URLs live in `attachments[]`. Without this step every
 * generated image / file / archive renders as a dead link in the chat.
 *
 * Rules (mirroring the guide):
 *  - http(s) destinations pass through untouched;
 *  - a Markdown link/image whose destination matches an attachment `path`
 *    (after one URL-decode) is rewritten to the attachment `url`;
 *  - unmatched local-path nodes are dropped (the guide says to remove what
 *    cannot be resolved) while the surrounding text is preserved.
 * Attachments without a usable `path` (e.g. website checkpoints are handled
 * separately by the agent text itself) are ignored here.
 *
 * `displayUrls` optionally overrides the destination per attachment path —
 * the workspace downloader points it at the plugin's loopback file route so
 * links survive the signed URL's expiry. Its entries carry
 * `{url, filename, contentType}` like the derived ones.
 */
function rewriteAttachments(content, attachments, displayUrls) {
	if (typeof content !== "string" || content.length === 0) return content;
	if (!Array.isArray(attachments) || attachments.length === 0) return content;
	const byPath = new Map();
	for (const attachment of attachments) {
		if (!isObject(attachment)) continue;
		const path = typeof attachment.path === "string" ? attachment.path : undefined;
		const url = typeof attachment.url === "string" ? attachment.url : undefined;
		if (path === undefined || url === undefined || path.length === 0 || url.length === 0) continue;
		const override = displayUrls?.get(path);
		byPath.set(path, {
			url: typeof override?.url === "string" && override.url.length > 0 ? override.url : url,
			filename: typeof override?.filename === "string" ? override.filename : typeof attachment.filename === "string" ? attachment.filename : undefined,
			contentType: typeof override?.contentType === "string" ? override.contentType : typeof attachment.content_type === "string" ? attachment.content_type : undefined,
			dropNode: override?.dropNode === true
		});
	}
	if (byPath.size === 0) return content;
	let decodedCache;
	const resolveDest = (rawDest) => {
		if (/^https?:\/\//i.test(rawDest)) return undefined; // public URL: render as-is
		if (rawDest.startsWith("manus-webdev://")) return null; // website checkpoint: not resolvable here → drop node
		if (/^[a-z][a-z0-9+.-]*:/i.test(rawDest)) return null; // other scheme: drop node per guide
		try {
			decodedCache ??= new Map();
			let decoded = decodedCache.get(rawDest);
			if (decoded === undefined) {
				decoded = decodeURI(rawDest);
				decodedCache.set(rawDest, decoded);
			}
			const match = byPath.get(decoded) ?? byPath.get(rawDest);
			return match === undefined ? null : match; // null = unresolvable → drop node
		} catch {
			const match = byPath.get(rawDest);
			return match === undefined ? null : match;
		}
	};
	const trimTitle = (dest) => dest.replace(/\s+"[^"]*"$/, "").replace(/\s+$/, "");
	// Images: ![alt](dest) → keep as image when resolvable (signed CDN URL),
	// or drop the node when a durable image block already carries the picture.
	// Dest may contain spaces (e.g. `/home/ubuntu/out/image 1.png`), so the
	// capture is bounded by the closing paren, then a trailing "title" is cut.
	let rewritten = content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (whole, alt, dest) => {
		const match = resolveDest(trimTitle(dest));
		if (match === undefined) return whole;
		if (match === null || match.dropNode === true) return "";
		return `![${alt}](${match.url})`;
	});
	// Links: [text](dest) → rendered as a download link. For non-image files
	// (docs/archives/spreadsheets) the link text is replaced with the filename
	// so long env paths never leak into the chat bubble.
	rewritten = rewritten.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (whole, text, dest) => {
		const match = resolveDest(trimTitle(dest));
		if (match === undefined) return whole;
		if (match === null || match.dropNode === true) return "";
		const isImageLink = match.contentType !== undefined && match.contentType.startsWith("image/");
		const label = isImageLink || match.filename === undefined ? text : match.filename;
		return `[${label}](${match.url})`;
	});
	// Bare absolute env paths that were not Markdown-wrapped (e.g. the agent
	// writes `/home/ubuntu/result.zip` inline): link them when an attachment
	// matches, otherwise leave the text alone (it is plain prose there).
	rewritten = rewritten.replace(/(?<!\]\()((?:\/[\w.-]+){2,})(?!\))/g, (whole, envPath) => {
		const match = byPath.get(envPath);
		if (match === undefined) return whole;
		if (match.dropNode === true) return "";
		return `[${match.filename ?? envPath.split("/").pop()}](${match.url})`;
	});
	return rewritten;
}

/**
 * Download one attachment body from its signed CDN URL. Unlike the JSON
 * transport this FOLLOWS redirects (signed URLs commonly 302 to the real
 * object) and reads bytes, with a size ceiling so a runaway archive cannot
 * exhaust memory. `content-length` is checked up front when present; the
 * accumulated size is checked while reading either way.
 * @returns the body as a Buffer.
 */
async function downloadAttachment(url, signal, timeoutMs) {
	const effective = withTimeout(signal, timeoutMs);
	try {
		const response = await fetch(url, { method: "GET", signal: effective, redirect: "follow" });
		if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
		const declared = Number(response.headers.get("content-length") ?? "");
		if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
			throw new Error(`file too large (${declared} bytes > ${MAX_DOWNLOAD_BYTES})`);
		}
		if (response.body === null) throw new Error("empty response body");
		const chunks = [];
		let total = 0;
		for await (const chunk of response.body) {
			total += chunk.length;
			if (total > MAX_DOWNLOAD_BYTES) throw new Error(`file too large (> ${MAX_DOWNLOAD_BYTES} bytes)`);
			chunks.push(Buffer.from(chunk));
		}
		return Buffer.concat(chunks);
	} catch (error) {
		if (error instanceof LlmError) throw error;
		if (signal?.aborted) throw new LlmError(hintFor("ABORTED"), "ABORTED", { cause: error });
		throw new Error(error instanceof Error ? error.message : String(error));
	}
}

/** Content type used to pick an extension when Manus omits the filename. */
const CONTENT_TYPE_EXTENSIONS = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/gif": ".gif",
	"image/svg+xml": ".svg",
	"application/pdf": ".pdf",
	"application/zip": ".zip",
	"application/json": ".json",
	"text/plain": ".txt",
	"text/markdown": ".md",
	"text/csv": ".csv"
};

/** Give a nameless attachment a usable extension from its content type. */
function nameForAttachment(attachment, index) {
	const rawName = typeof attachment.filename === "string" && attachment.filename.length > 0
		? attachment.filename
		: typeof attachment.path === "string" && attachment.path.length > 0 ? attachment.path : "";
	const name = sanitizeManusFileName(rawName, `manus-file-${index + 1}`);
	if (name.includes(".")) return name;
	const ext = CONTENT_TYPE_EXTENSIONS[typeof attachment.content_type === "string" ? attachment.content_type.toLowerCase() : ""];
	return ext === undefined ? name : `${name}${ext}`;
}

/**
 * Synthetic user-role messages injected by harness internals carry a `source`
 * attribution that real user input never has. Forwarding them to Manus made
 * "显示当前时间" arrive as a time-sample snapshot instead of the user's words.
 * Kinds verified in the host runtime (app.asar):
 * - "runtime-context"  — per-step dynamic context snapshot (asar L316280)
 * - "time-context"     — @deepseek-ai/dsh-time-context clock readings
 * - "compact-checkpoint" — post-compaction summary checkpoint (asar L450761)
 * Real user input is source.kind "user" (the time-context plugin reads
 * clientTimeZone off exactly that shape). Defensive: unknown/absent source
 * kinds with user role are also treated as real user input.
 */
const SYNTHETIC_USER_SOURCE_KINDS = new Set(["runtime-context", "time-context", "compact-checkpoint"]);

function isSyntheticUserMessage(message) {
	const source = message?.source;
	return typeof source === "object" && source !== null && typeof source.kind === "string" && SYNTHETIC_USER_SOURCE_KINDS.has(source.kind);
}

/**
 * Extract the text of the LATEST real user turn — the only thing forwarded to
 * Manus. The harness system prompt and the rest of the conversation history
 * never leave the machine (see the design note in the file header). Trailing
 * tool results (tool-loop degradation) are appended after the user text.
 */
function latestTurnPrompt(options) {
	const messages = Array.isArray(options.messages) ? options.messages : [];
	let lastUserIndex = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "user" && !isSyntheticUserMessage(message)) {
			lastUserIndex = index;
			break;
		}
	}
	if (lastUserIndex === -1) return "";
	const parts = [];
	const userText = blocksToText(messages[lastUserIndex].content);
	if (userText.length > 0) parts.push(userText);
	for (let index = lastUserIndex + 1; index < messages.length; index += 1) {
		const message = messages[index];
		if (message?.role !== "tool") continue;
		parts.push(`Result of tool call "${message.toolCallId}":\n${blocksToText(message.content)}`);
	}
	return parts.join("\n\n");
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
	const timer = setTimeout(() => resolve(), ms);
	if (signal) {
		const onAbort = () => {
			clearTimeout(timer);
			reject(new LlmError(hintFor("ABORTED"), "ABORTED"));
		};
		if (signal.aborted) {
			clearTimeout(timer);
			reject(new LlmError(hintFor("ABORTED"), "ABORTED"));
		} else signal.addEventListener("abort", onAbort, { once: true });
	}
});

/**
 * Durable replay envelope: keeps the task_id so later turns continue the same
 * task. `blocks` must carry exactly one entry per emitted block — the assembler
 * drops the whole envelope when the lengths disagree, which would silently
 * start a fresh task on the next turn. `blockTypes` records the emitted block
 * kinds so the entries mirror the stream (image blocks included).
 *
 * `cursor` is the id of the last event consumed this turn. The next turn polls
 * from it, so a follow-up streams only what the agent just produced instead of
 * replaying the task's whole transcript (which duplicated old answers and
 * re-downloaded old attachments on every turn). The assembler only inspects
 * `blocks`/`response` and passes every other key through untouched.
 */
function replayState(model, taskId, blockTypes, cursor) {
	const entries = blockTypes.length > 0 ? blockTypes : ["text"];
	return {
		response: {
			kind: "manus-task",
			version: 1,
			model
		},
		blocks: entries.map((type) => ({ type })),
		// Task handle the reader pulls back out (the blocks entries stay opaque).
		taskId,
		...(typeof cursor === "string" && cursor.length > 0 ? { cursor } : {})
	};
}

/** Read back the task handle + event cursor from durable history, or undefined. */
function readReplay(message) {
	if (message.source?.kind !== "model" || message.source.replayState === undefined) return undefined;
	const envelope = message.source.replayState;
	if (!isObject(envelope)) return undefined;
	const response = isObject(envelope.response) ? envelope.response : undefined;
	if (response?.kind !== "manus-task" || response.version !== 1) return undefined;
	if (typeof envelope.taskId !== "string" || envelope.taskId.length === 0) return undefined;
	return {
		taskId: envelope.taskId,
		cursor: typeof envelope.cursor === "string" && envelope.cursor.length > 0 ? envelope.cursor : undefined
	};
}

var ManusAdapter = class extends LlmAdapter {
	/**
	 * @param resolveConfig - () => live config snapshot (volatile refs unwrapped per read).
	 * @param resolveApiKey - async (ref) => key string | undefined. Prefers the
	 *   credentials seam (managed store the web Models page writes, then env /
	 *   .env fallbacks), then the plain process environment.
	 * @param log - diagnostics sink.
	 * @param credits - optional { record(sessionId, spent) } sink; receives the
	 *   credit delta measured across one finished turn.
	 * @param workspaceBridge - optional host-side bridge for generated files:
	 *   { resolveWorkspace(sessionId) => cwd | undefined,
	 *     saveImage({ data, mediaType, name }) => ImageAttachmentRef | undefined,
	 *     fileUrl(sessionId, fileName) => string }. Absent → attachments keep
	 *   the signed CDN URLs only (the pre-download behaviour).
	 */
	constructor(resolveConfig, resolveApiKey, log, credits, workspaceBridge) {
		super();
		this.resolveConfig = resolveConfig;
		this.resolveApiKey = resolveApiKey;
		this.log = log;
		this.credits = credits;
		this.workspaceBridge = workspaceBridge;
	}

	providerInfo(provider) {
		return { id: provider, name: "Manus" };
	}

	providerRetryPolicy() {
		return undefined; // LlmRuntime falls back to the normal defaults.
	}

	async listModels(provider) {
		const { models } = this.resolveConfig();
		return models.map((model) => ({
			provider,
			id: model.id,
			name: model.name,
			description: model.description
		}));
	}

	async resolveModel(provider, model, _signal) {
		const config = this.resolveConfig();
		const known = config.models.find((entry) => entry.id === model);
		return {
			provider,
			id: model,
			name: known?.name ?? model,
			description: known?.description,
			// Manus runs a cloud agent, so the harness's own context budget is a
			// reporting figure, not a hard provider limit. Each tier carries its
			// own configured window (200k / 500k / 1M).
			context: { contextWindow: config.contextWindowOf(model) },
			defaultMaxTokens: config.maxTokens,
			inputModalities: ["text"],
			// Only the `max` tier offers deeper thinking levels; the others have
			// exactly one behavior, so they advertise no effort metadata at all.
			...(model === "max" && config.reasoningEfforts.length > 0 ? {
				reasoning: {
					efforts: config.reasoningEfforts.map((effort) => ({
						id: effort.id,
						name: effort.name,
						...(effort.description === undefined ? {} : { description: effort.description })
					})),
					defaultEffort: "max"
				}
			} : {})
		};
	}

	/**
	 * Read the authoritative spendable balance for one API key.
	 * @param apiKey - resolved credential value.
	 * @returns the balance document, or undefined when the call failed (the
	 *   readout degrades to "unknown" instead of blocking the composer).
	 */
	async fetchCredits(apiKey, timeoutMs = 30000) {
		try {
			const raw = await requestJson(`${MANUS_API_BASE}/v2/usage.availableCredits`, {
				method: "GET",
				headers: {
					...attributionHeaders(),
					"x-manus-api-key": apiKey,
					accept: "application/json"
				}
			}, undefined, timeoutMs);
			const parsed = parseCredits(raw);
			if (parsed === undefined) return undefined;
			return parsed;
		} catch (error) {
			this.log(`manus: credit read failed: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	/**
	 * TTL-cached balance read for per-turn accounting. Every generate() used to
	 * hit `usage.availableCredits` twice (before + after the turn); the "before"
	 * read now reuses a result fresher than {@link CREDITS_TTL_MS} and the
	 * "after" read forces a fresh fetch so the turn's spend delta stays exact.
	 * The cache is keyed per API key (multi-credential safe) and shared across
	 * turns; it never serves stale data for the after-read.
	 * @param apiKey - resolved credential value.
	 * @param {object} [options]
	 * @param {boolean} [options.fresh=false] - bypass the cache and repopulate
	 *   it (used by the post-turn read).
	 */
	async fetchCreditsCached(apiKey, { fresh = false } = {}) {
		const now = Date.now();
		if (!fresh) {
			const cached = this.creditsReadCache?.get(apiKey);
			if (cached !== undefined && now - cached.at < CREDITS_TTL_MS) return cached.value;
		}
		const value = await this.fetchCredits(apiKey);
		if (value !== undefined) {
			(this.creditsReadCache ??= new Map()).set(apiKey, { at: Date.now(), value });
		}
		return value;
	}

	/** Bind one generation: config re-resolution happens before each dispatch. */
	async prepareCall(provider, model, signal) {
		return {
			model: await this.resolveModel(provider, model, signal),
			stream: (options) => this.generate(options)
		};
	}

	/**
	 * One connection probe for the settings page: a single read-only call that
	 * proves the key works and reports the current balance. Unlike
	 * `fetchCredits` it surfaces the failure code instead of swallowing it.
	 * @returns {Promise<{ok: boolean, total?: number, code?: string, message?: string}>}
	 */
	async probe(apiKey, timeoutMs = 15000) {
		try {
			const raw = await requestJson(`${MANUS_API_BASE}/v2/usage.availableCredits`, {
				method: "GET",
				headers: {
					...attributionHeaders(),
					"x-manus-api-key": apiKey,
					accept: "application/json"
				}
			}, undefined, timeoutMs);
			const parsed = parseCredits(raw);
			if (parsed === undefined) {
				return { ok: false, code: "MALFORMED_RESPONSE", message: "Manus 返回了无法识别的余额数据" };
			}
			return { ok: true, total: parsed.total };
		} catch (error) {
			return {
				ok: false,
				code: error instanceof LlmError ? error.code : "TRANSPORT",
				message: error instanceof Error ? error.message : String(error)
			};
		}
	}

	/**
	 * Download the attachments of one assistant message into the session
	 * workspace and register the display handles for it.
	 *
	 * Best-effort by contract: a missing bridge, an unresolvable workspace, a
	 * failed download or a rejected image never fails the turn — the affected
	 * attachment simply keeps the signed CDN URL it already had.
	 *
	 * @param {object} input
	 * @param {string} input.sessionId - harness session id (workspace lookup key).
	 * @param {unknown[]} input.attachments - `assistant_message.attachments`.
	 * @param {AbortSignal | undefined} input.signal - caller cancellation.
	 * @param {object} input.config - resolved config snapshot.
	 * @param {object} input.turn - turn-scoped download state (mutated):
	 *   `{ dir, dirResolved, savedFiles, displayUrls }`.
	 * @returns {Promise<object[]>} durable image blocks to emit for this
	 *   message, in attachment order.
	 */
	async persistAttachments({ sessionId, attachments, signal, config, turn }) {
		const bridge = this.workspaceBridge;
		if (bridge === undefined || config.downloadAttachments !== true) return [];
		if (!Array.isArray(attachments) || attachments.length === 0) return [];
		const dirName = typeof config.downloadDirName === "string" && config.downloadDirName.length > 0
			? config.downloadDirName
			: DEFAULT_DOWNLOAD_DIR;
		// Resolve the workspace once per turn: the lookup goes through host
		// services and must not run per attachment.
		if (turn.dir === undefined && turn.dirResolved !== true) {
			turn.dirResolved = true;
			try {
				const cwd = await bridge.resolveWorkspace?.(sessionId);
				if (typeof cwd === "string" && cwd.length > 0) turn.dir = path.join(cwd, dirName);
			} catch (error) {
				this.log(`manus: workspace lookup failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (turn.dir === undefined) return [];
		const imageBlocks = [];
		for (let index = 0; index < attachments.length; index += 1) {
			const attachment = attachments[index];
			if (!isObject(attachment)) continue;
			const url = typeof attachment.url === "string" && attachment.url.length > 0 ? attachment.url : undefined;
			if (url === undefined) continue;
			const envPath = typeof attachment.path === "string" && attachment.path.length > 0 ? attachment.path : undefined;
			// Same file referenced twice in one turn: already saved + mapped.
			if (envPath !== undefined && turn.displayUrls.has(envPath)) continue;
			let data;
			try {
				data = await downloadAttachment(url, signal, config.requestTimeoutMs);
			} catch (error) {
				if (error instanceof LlmError && error.code === "ABORTED") throw error;
				this.log(`manus: attachment download failed (${url.split("?")[0]}): ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			const contentType = typeof attachment.content_type === "string" ? attachment.content_type : undefined;
			const baseName = nameForAttachment(attachment, index);
			let fileName;
			let filePath;
			try {
				await mkdir(turn.dir, { recursive: true });
				const target = await uniqueWorkspacePath(turn.dir, baseName);
				await writeFile(target.filePath, data);
				fileName = target.fileName;
				filePath = target.filePath;
			} catch (error) {
				this.log(`manus: attachment save failed (${baseName}): ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			turn.savedFiles.push({ fileName, filePath, contentType });
			const mediaType = imageMediaType(contentType);
			if (mediaType !== undefined) {
				// Durable image block: rendered inline by the GUI and replayable
				// from the attachment store after the signed URL expires.
				try {
					const ref = await bridge.saveImage?.({ data, mediaType, name: fileName });
					if (ref !== undefined) {
						imageBlocks.push({ type: "image", attachment: ref });
						if (envPath !== undefined) {
							turn.displayUrls.set(envPath, { url: "", filename: fileName, contentType, dropNode: true });
						}
						continue;
					}
				} catch (error) {
					this.log(`manus: image block rejected (${fileName}): ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (envPath !== undefined) {
				const fileUrl = bridge.fileUrl?.(sessionId, fileName);
				if (typeof fileUrl === "string" && fileUrl.length > 0) {
					turn.displayUrls.set(envPath, { url: fileUrl, filename: fileName, contentType });
				}
			}
		}
		return imageBlocks;
	}

	/**
	 * Footnote listing the files saved into the workspace this turn. Rendered as
	 * plain text so the paths stay readable (and copy-pasteable) even when the
	 * GUI cannot open the file route.
	 */
	savedFilesFootnote(savedFiles, config) {
		if (!Array.isArray(savedFiles) || savedFiles.length === 0) return "";
		const dirName = typeof config.downloadDirName === "string" && config.downloadDirName.length > 0
			? config.downloadDirName
			: DEFAULT_DOWNLOAD_DIR;
		const rows = savedFiles.map((entry) => `- \`${entry.filePath}\``);
		return `\n\n---\n📎 已保存 ${savedFiles.length} 个文件到工作区（${dirName}）：\n${rows.join("\n")}`;
	}

	async *generate(options) {
		const config = this.resolveConfig();
		const apiKey = await this.resolveApiKey(config.apiKeyEnv);
		if (!apiKey || apiKey.length === 0) {
			throw new LlmError(hintFor("MISSING_CREDENTIAL"), "MISSING_CREDENTIAL");
		}
		const signal = options.signal;
		signal?.throwIfAborted?.();
		const headers = {
			...attributionHeaders(),
			"x-manus-api-key": apiKey,
			"content-type": "application/json",
			accept: "application/json"
		};
		const base = "https://api.manus.ai/v2";

		// Locate the conversation task: continuing replay history or a fresh task.
		// The replayed cursor is where the previous turn stopped polling, so this
		// turn only reads events produced after it.
		let taskId;
		let resumeCursor;
		const lastAssistant = [...options.messages].reverse().find((message) => message.role === "assistant" && message.source?.kind === "model");
		if (lastAssistant !== undefined) {
			const replayed = readReplay(lastAssistant);
			if (replayed !== undefined) {
				taskId = replayed.taskId;
				resumeCursor = replayed.cursor;
			}
		}

		const prompt = latestTurnPrompt(options);
		if (prompt.length === 0) {
			throw new LlmError(hintFor("INVALID_REQUEST", "输入内容为空"), "INVALID_REQUEST");
		}
		// One tier decision per turn: a deeper reasoning effort under the `max`
		// route IS the agent_profile value; every other route keeps its tier.
		const tier = config.tierOf(options.model, options.reasoningEffort);
		const sessionId = typeof options.sessionId === "string" ? options.sessionId : "";
		// Credit accounting is best-effort and never blocks a turn. The
		// pre-turn read rides the TTL cache (free when another read just
		// happened); the post-turn read forces fresh so the delta is exact.
		let beforeCredits;
		if (config.trackCredits) beforeCredits = await this.fetchCreditsCached(apiKey);
		if (taskId === undefined) {
			const body = {
				message: { content: prompt },
				agent_profile: tier,
				locale: config.locale
			};
			const created = await requestJson(`${base}/task.create`, {
				method: "POST",
				headers,
				body: JSON.stringify(body)
			}, signal, config.requestTimeoutMs);
			taskId = needString(created.task_id, "task_id");
			this.log(`manus: created task ${taskId} (${options.model}${tier !== options.model ? ` / ${tier}` : ""})`);
		} else {
			await requestJson(`${base}/task.sendMessage`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					task_id: taskId,
					message: { content: prompt }
				})
			}, signal, config.requestTimeoutMs);
			this.log(`manus: sent follow-up to task ${taskId}`);
		}

		// Poll task.listMessages, translating new events into harness chunks.
		// One text block per turn: Manus streams events, not blocks, so every
		// assistant_message folds into the block opened by the first one. The
		// block's text is accumulated here because `block-end` REPLACES the
		// assembled text with the block it carries (an empty payload would erase
		// the whole reply).
		let cursor = resumeCursor; // start_event_id for the next poll; resumes where the last turn stopped.
		let turnOpen = false;
		// Highest allocated block index. Image/file blocks are emitted as
		// block-end-only chunks BETWEEN text deltas, so the open text block's
		// index must be tracked separately: appending a later assistant_message
		// to `blockIndex` would write text deltas into the image block's slot.
		let blockIndex = -1;
		let textIndex = -1;
		let blockText = "";
		// Block kinds actually emitted this turn, in stream order: the replay
		// envelope must carry exactly one entry per block or the assembler
		// drops the task handle and the next turn starts a brand-new task.
		const emittedBlocks = [];
		// Generated-file state for this turn: the resolved download directory,
		// the files written so far, and the per-attachment display overrides.
		const turn = { dir: undefined, dirResolved: false, savedFiles: [], displayUrls: new Map() };
		// Every assistant text seen this turn, including `progress` frames that the
		// visible block skips. If the task stops without ever opening a block (all
		// output was progress), this is replayed as the answer instead of failing
		// the turn with EMPTY_RESPONSE and burning the credits already spent.
		let fallbackText = "";
		// Manus does not report token counts; the harness only needs a usage
		// record to close the turn, so zeros are reported deliberately.
		const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
		const started = Date.now();

		while (true) {
			signal?.throwIfAborted?.();
			const elapsed = Date.now() - started;
			if (elapsed > config.pollMaxSeconds * 1000) {
				// Deadline: stop the remote task and fail the stream.
				await requestJson(`${base}/task.stop`, {
					method: "POST",
					headers,
					body: JSON.stringify({ task_id: taskId })
				}, undefined, 15000).catch(() => {});
				throw new LlmError(hintFor("TIMEOUT", `已等待 ${config.pollMaxSeconds} 秒`), "TIMEOUT");
			}
			const params = new URLSearchParams({
				task_id: taskId,
				order: "asc",
				limit: "100"
			});
			if (cursor !== undefined) params.set("start_event_id", cursor);
			const page = await requestJson(`${base}/task.listMessages?${params.toString()}`, {
				method: "GET",
				headers
			}, signal, config.requestTimeoutMs);
			const messages = Array.isArray(page.messages) ? page.messages : [];
			for (const event of messages) {
				if (typeof event.id !== "string" || event.id.length === 0) continue;
				// `start_event_id` is INCLUSIVE, so the event that ended the previous
				// page comes back at the head of this one; ids are unique, so one
				// identity check dedupes it.
				if (event.id === cursor) continue;
				cursor = event.id;
				if (event.type === "assistant_message") {
					const payload = isObject(event.assistant_message) ? event.assistant_message : undefined;
					// Generated files (images, docs, archives…) arrive as env paths
					// inside `content`; the signed download URLs live in
					// `attachments[]`. Download them into the workspace first so the
					// links can point at the durable copies, then rewrite the text.
					const imageBlocks = await this.persistAttachments({
						sessionId,
						attachments: payload?.attachments,
						signal,
						config,
						turn
					});
					const text = rewriteAttachments(
						typeof payload?.content === "string" ? payload.content : "",
						payload?.attachments,
						turn.displayUrls
					);
					if (text.length === 0 && imageBlocks.length === 0) continue;
					if (text.length > 0) {
						fallbackText += fallbackText.length === 0 ? text : `\n\n${text}`;
					}
					if (payload?.delivery_kind === "progress" && !config.showProgress) {
						// The picture still displays even when the progress text is
						// hidden: images belong to the answer, not to the narration.
						for (const block of imageBlocks) {
							blockIndex += 1;
							emittedBlocks.push("image");
							yield { type: "block-end", index: blockIndex, block };
						}
						continue;
					}
					if (text.length > 0) {
						if (!turnOpen) {
							blockIndex += 1;
							textIndex = blockIndex;
							blockText = "";
							emittedBlocks.push("text");
							yield { type: "block-start", index: textIndex, blockType: "text" };
							turnOpen = true;
						} else {
							// New event in the same block: newline seam between events.
							blockText += "\n\n";
							yield { type: "text-delta", index: textIndex, text: "\n\n" };
						}
						blockText += text;
						yield { type: "text-delta", index: textIndex, text };
					}
					for (const block of imageBlocks) {
						blockIndex += 1;
						emittedBlocks.push("image");
						yield { type: "block-end", index: blockIndex, block };
					}
				} else if (event.type === "status_update") {
					const status = isObject(event.status_update) ? event.status_update : undefined;
					const agentStatus = status?.agent_status;
					if (agentStatus === "error") {
						const detail = typeof status?.status_detail?.waiting_description === "string"
							? status.status_detail.waiting_description
							: typeof status?.description === "string" ? status.description : "Manus agent reported an error";
						throw new LlmError(hintFor("SERVER", detail), "SERVER");
					}
					if (agentStatus === "stopped") {
						// Close the open block and settle the turn.
						if (!turnOpen) {
							// Nothing visible opened: fall back to the progress frames the
							// visible path skipped. Only a task that produced no text at
							// all is a genuinely empty turn.
							if (fallbackText.length === 0) {
								if (turn.savedFiles.length === 0) {
									throw new LlmError(hintFor("EMPTY_RESPONSE"), "EMPTY_RESPONSE");
								}
								// Files arrived without any text: still show the save list.
								blockIndex += 1;
								textIndex = blockIndex;
								blockText = "";
								emittedBlocks.push("text");
								yield { type: "block-start", index: textIndex, blockType: "text" };
								turnOpen = true;
							} else {
								blockIndex += 1;
								textIndex = blockIndex;
								blockText = fallbackText;
								emittedBlocks.push("text");
								yield { type: "block-start", index: textIndex, blockType: "text" };
								yield { type: "text-delta", index: textIndex, text: fallbackText };
								turnOpen = true;
							}
						}
						// Saved-file footnote: local paths the user (or a later tool
						// call) can open directly, independent of the GUI renderer.
						const footnote = this.savedFilesFootnote(turn.savedFiles, config);
						if (footnote.length > 0 && turnOpen) {
							blockText += footnote;
							yield { type: "text-delta", index: textIndex, text: footnote };
						}
						yield {
							type: "block-end",
							index: textIndex,
							block: { type: "text", text: blockText }
						};
						usage.totalTokens = usage.inputTokens + usage.outputTokens;
						yield { type: "usage", usage };
						// Measure the turn's spend now that the task settled. Best-effort:
						// a failed read only means the readout shows no delta.
						if (beforeCredits !== undefined) {
							const after = await this.fetchCreditsCached(apiKey, { fresh: true });
							if (after !== undefined) {
								const spent = beforeCredits.total - after.total;
								if (Number.isFinite(spent)) this.credits?.record(sessionId, spent);
							}
						}
						yield {
							type: "finish",
							reason: { kind: "stop" },
							replayState: replayState(options.model, taskId, emittedBlocks, cursor)
						};
						return;
					}
					// running / waiting: keep polling. Waiting on user input while the
					// harness expects a completed turn is surfaced as a text note below
					// by the waiting description check on the next iteration.
					if (agentStatus === "waiting") {
						const detail = status?.status_detail ?? {};
						const kind = detail.waiting_for_event_type ?? "unknown";
						const description = typeof detail.waiting_description === "string" ? detail.waiting_description : "";
						const note = `[manus is waiting for input (${kind})${description ? `: ${description}` : ""} — reply to continue]\n`;
						if (turnOpen) {
							blockText += `\n\n${note}`;
							yield { type: "text-delta", index: textIndex, text: `\n\n${note}` };
						} else {
							blockIndex += 1;
							textIndex = blockIndex;
							blockText = note;
							// The replay envelope needs one entry per block; a missing
							// entry makes the harness drop the task handle and the next
							// turn starts a brand-new Manus task.
							emittedBlocks.push("text");
							yield { type: "block-start", index: textIndex, blockType: "text" };
							turnOpen = true;
							yield { type: "text-delta", index: textIndex, text: note };
						}
					}
				} else if (event.type === "error_message") {
					const payload = isObject(event.error_message) ? event.error_message : undefined;
					const detail = typeof payload?.content === "string" && payload.content.length > 0
						? payload.content
						: typeof payload?.error_type === "string" ? payload.error_type : "Manus reported an error";
					throw new LlmError(hintFor("SERVER", detail), "SERVER");
				}
				// user_message / tool_used / plan_update / explanation: ignored.
			}
			// Only advance when the page has more; otherwise wait for new events.
			await sleep(config.pollIntervalMs, signal);
		}
	}
};

export { ManusAdapter };
export default ManusAdapter;
