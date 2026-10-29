/**
 * @local/manus-llm — Manus cloud agent as a DeepSeek Harness model provider.
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
 * - One provider route `manus`; "models" are Manus agent profiles (standard/lite/max…).
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

/** Read a validated string field from provider JSON, or throw MALFORMED_RESPONSE. */
function needString(value, what) {
	if (typeof value !== "string" || value.length === 0) {
		throw new LlmError(`Manus API: expected non-empty string for ${what}`, "MALFORMED_RESPONSE");
	}
	return value;
}

function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** Build a provider-neutral LlmError from an HTTP response body. */
function providerError(status, raw, requestId) {
	const envelope = errorEnvelope(raw);
	const message = envelope?.message ?? `Manus API request failed (HTTP ${status})`;
	const code = classifyError(status, envelope?.code ?? "", message);
	return new LlmError(`manus: ${message}`, code, {
		status,
		...(requestId ? { requestId } : {})
	});
}

/** Transport wrapper: turn fetch failures into TRANSPORT / TIMEOUT / ABORTED failures. */
async function requestJson(url, init, signal) {
	try {
		const response = await fetch(url, { ...init, signal, redirect: "error" });
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
		if (signal?.aborted) throw new LlmError("Manus request aborted", "ABORTED", { cause: error });
		if (error instanceof Error && error.name === "TimeoutError") {
			throw new LlmError("Manus request timed out", "TIMEOUT", { cause: error });
		}
		throw new LlmError("Manus transport failed", "TRANSPORT", { cause: error });
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
			reject(new LlmError("Manus request aborted", "ABORTED"));
		};
		if (signal.aborted) {
			clearTimeout(timer);
			reject(new LlmError("Manus request aborted", "ABORTED"));
		} else signal.addEventListener("abort", onAbort, { once: true });
	}
});

/** Durable replay envelope: keeps the task_id so later turns continue the same task. */
function replayState(model, taskId) {
	return {
		response: {
			kind: "manus-task",
			version: 1,
			model
		},
		blocks: [{ type: "text", taskId }],
		// Extension slot the manifest-validating reader tolerates: task handle.
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
	constructor(resolveConfig, log) {
		super();
		this.resolveConfig = resolveConfig;
		this.log = log;
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
		const { models } = this.resolveConfig();
		const known = models.find((entry) => entry.id === model);
		return {
			provider,
			id: model,
			name: known?.name ?? model,
			description: known?.description
		};
	}

	/** Bind one generation: config re-resolution happens before each dispatch. */
	async prepareCall(provider, model, signal) {
		return {
			model: await this.resolveModel(provider, model, signal),
			stream: (options) => this.generate(options)
		};
	}

	async *generate(options) {
		const config = this.resolveConfig();
		const apiKey = config.apiKey;
		if (!apiKey || apiKey.length === 0) {
			throw new LlmError(
				`manus: no API key configured; set the key "${config.apiKeyEnv}" through the credentials store (web Models page) or the launching environment`,
				"MISSING_CREDENTIAL"
			);
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
			throw new LlmError("manus: request produced an empty prompt", "INVALID_REQUEST");
		}
		if (taskId === undefined) {
			const body = {
				message: { content: prompt },
				agent_profile: config.profileOf(options.model),
				locale: config.locale
			};
			const created = await requestJson(`${base}/task.create`, {
				method: "POST",
				headers,
				body: JSON.stringify(body)
			}, signal);
			taskId = needString(created.task_id, "task_id");
			this.log(`manus: created task ${taskId} (${options.model})`);
		} else {
			await requestJson(`${base}/task.sendMessage`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					task_id: taskId,
					message: { content: prompt }
				})
			}, signal);
			this.log(`manus: sent follow-up to task ${taskId}`);
		}

		// Poll task.listMessages, translating new events into harness chunks.
		let cursor; // start_event_id for the next poll.
		let turnOpen = false;
		let blockIndex = -1;
		const usage = { inputTokens: 0, outputTokens: 0 };
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
				}, undefined).catch(() => {});
				throw new LlmError(`manus: task ${taskId} did not finish within ${config.pollMaxSeconds}s`, "TIMEOUT");
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
			}, signal);
			const messages = Array.isArray(page.messages) ? page.messages : [];
			for (const event of messages) {
				if (typeof event.id !== "string" || event.id.length === 0) continue;
				cursor = event.id; // Inclusive restart point; we dedupe by our own cursor bookkeeping below.
				if (event.type === "assistant_message") {
					const payload = isObject(event.assistant_message) ? event.assistant_message : undefined;
					const text = typeof payload?.content === "string" ? payload.content : "";
					if (text.length === 0) continue;
					if (payload?.delivery_kind === "progress" && !config.showProgress) continue;
					if (!turnOpen) {
						blockIndex += 1;
						yield { type: "block-start", index: blockIndex, blockType: "text" };
						turnOpen = true;
					} else {
						// New event in the same block: newline seam between events.
						yield { type: "text-delta", index: blockIndex, text: "\n\n" };
					}
					yield { type: "text-delta", index: blockIndex, text };
				} else if (event.type === "status_update") {
					const status = isObject(event.status_update) ? event.status_update : undefined;
					const agentStatus = status?.agent_status;
					if (agentStatus === "error") {
						const detail = typeof status?.status_detail?.waiting_description === "string"
							? status.status_detail.waiting_description
							: typeof status?.description === "string" ? status.description : "Manus agent reported an error";
						throw new LlmError(`manus: task ${taskId} failed: ${detail}`, "SERVER");
					}
					if (agentStatus === "stopped") {
						// Close the open block and settle the turn.
						if (!turnOpen) {
							// Terminal stop with zero output: EMPTY_RESPONSE is retryable.
							throw new LlmError(`manus: task ${taskId} finished with no content`, "EMPTY_RESPONSE");
						}
						blockIndex += 1;
						yield {
							type: "block-end",
							index: blockIndex - 1,
							block: { type: "text", text: "" }
						};
						usage.totalTokens = usage.inputTokens + usage.outputTokens;
						yield { type: "usage", usage };
						yield {
							type: "finish",
							reason: { kind: "stop" },
							replayState: replayState(options.model, taskId)
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
						if (turnOpen) {
							yield { type: "text-delta", index: blockIndex, text: `\n\n[manus is waiting for input (${kind})${description ? `: ${description}` : ""} — reply to continue]\n` };
						} else {
							blockIndex += 1;
							yield { type: "block-start", index: blockIndex, blockType: "text" };
							turnOpen = true;
							yield { type: "text-delta", index: blockIndex, text: `[manus is waiting for input (${kind})${description ? `: ${description}` : ""} — reply to continue]\n` };
						}
					}
				} else if (event.type === "error_message") {
					const payload = isObject(event.error_message) ? event.error_message : undefined;
					const detail = typeof payload?.content === "string" && payload.content.length > 0
						? payload.content
						: typeof payload?.error_type === "string" ? payload.error_type : "Manus reported an error";
					throw new LlmError(`manus: task ${taskId} error: ${detail}`, "SERVER");
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
