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
 * - Polling drives the stream: after creating/sending a message, we poll
 *   task.listMessages (order=asc, start_event_id=cursor) and translate each
 *   new assistant_message into text-delta chunks with small synthetic delays so
 *   the UI shows progressive output. status_update(stopped|error) ends the turn.
 * - Tool calls are NOT supported (Manus has its own tools); we declare no tools
 *   and degrade gracefully: tool results are serialized as readable text.
 * - Errors map to the provider-neutral LlmError codes the retry plugin routes on.
 */
import { LlmAdapter, LlmError, attributionHeaders, ToolCallId } from "@deepseek-ai/dsh-llm";

/** Manus OpenAPI v2 origin (also the configurable-provider defaultBaseURL). */
export const MANUS_API_BASE = "https://api.manus.ai";

/**
 * TTL for cached `usage.availableCredits` reads used by per-turn accounting
 * (fetchCreditsCached). 30s matches the host-side credits-route cache.
 */
const CREDITS_TTL_MS = 30_000;

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

/** Serialize a full request history into the first-turn prompt. */
function firstTurnPrompt(options) {
	const parts = [];
	const system = options.system;
	if (system && system.length > 0) {
		parts.push(`<environment>\n${system}\n</environment>`);
	}
	for (const message of options.messages) {
		if (message.role === "assistant") {
			// Manually replayed assistant history: fold as context.
			const text = blocksToText(message.content);
			if (text.length > 0) parts.push(`Previous assistant reply:\n${text}`);
			continue;
		}
		if (message.role === "tool") {
			const label = `Result of tool call "${message.toolCallId}"`;
			parts.push(`${label}:\n${blocksToText(message.content)}`);
			continue;
		}
		const text = blocksToText(message.content);
		if (text.length > 0) parts.push(text);
	}
	return parts.join("\n\n");
}

/** Follow-up prompt: user text plus any tool results (tool loop degradation). */
function followUpPrompt(options) {
	return firstTurnPrompt(options);
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
 * start a fresh task on the next turn.
 */
function replayState(model, taskId, blockCount) {
	return {
		response: {
			kind: "manus-task",
			version: 1,
			model
		},
		blocks: Array.from({ length: Math.max(blockCount, 1) }, () => ({ type: "text" })),
		// Task handle the reader pulls back out (the blocks entries stay opaque).
		taskId
	};
}

/** Read back a task handle from durable assistant history, or undefined. */
function readReplay(message) {
	if (message.source?.kind !== "model" || message.source.replayState === undefined) return undefined;
	const envelope = message.source.replayState;
	if (!isObject(envelope)) return undefined;
	const response = isObject(envelope.response) ? envelope.response : undefined;
	if (response?.kind !== "manus-task" || response.version !== 1) return undefined;
	if (typeof envelope.taskId !== "string" || envelope.taskId.length === 0) return undefined;
	return envelope.taskId;
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
	 */
	constructor(resolveConfig, resolveApiKey, log, credits) {
		super();
		this.resolveConfig = resolveConfig;
		this.resolveApiKey = resolveApiKey;
		this.log = log;
		this.credits = credits;
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
		let taskId;
		const lastAssistant = [...options.messages].reverse().find((message) => message.role === "assistant" && message.source?.kind === "model");
		if (lastAssistant !== undefined) {
			const replayed = readReplay(lastAssistant);
			if (replayed !== undefined) taskId = replayed;
		}

		const prompt = taskId === undefined ? firstTurnPrompt(options) : followUpPrompt(options);
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
		let cursor; // start_event_id for the next poll (id of the last event consumed).
		let turnOpen = false;
		let blockIndex = -1;
		let blockText = "";
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
					const text = typeof payload?.content === "string" ? payload.content : "";
					if (text.length === 0) continue;
					fallbackText += fallbackText.length === 0 ? text : `\n\n${text}`;
					if (payload?.delivery_kind === "progress" && !config.showProgress) continue;
					if (!turnOpen) {
						blockIndex += 1;
						blockText = "";
						yield { type: "block-start", index: blockIndex, blockType: "text" };
						turnOpen = true;
					} else {
						// New event in the same block: newline seam between events.
						blockText += "\n\n";
						yield { type: "text-delta", index: blockIndex, text: "\n\n" };
					}
					blockText += text;
					yield { type: "text-delta", index: blockIndex, text };
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
								throw new LlmError(hintFor("EMPTY_RESPONSE"), "EMPTY_RESPONSE");
							}
							blockIndex += 1;
							blockText = fallbackText;
							yield { type: "block-start", index: blockIndex, blockType: "text" };
							yield { type: "text-delta", index: blockIndex, text: fallbackText };
							turnOpen = true;
						}
						yield {
							type: "block-end",
							index: blockIndex,
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
							replayState: replayState(options.model, taskId, blockIndex + 1)
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
							yield { type: "text-delta", index: blockIndex, text: `\n\n${note}` };
						} else {
							blockIndex += 1;
							blockText = note;
							yield { type: "block-start", index: blockIndex, blockType: "text" };
							turnOpen = true;
							yield { type: "text-delta", index: blockIndex, text: note };
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
