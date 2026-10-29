// Stub of @deepseek-ai/dsh-llm for offline adapter testing.
export class LlmError extends Error {
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
		this.name = "LlmError";
		if (options && typeof options === "object" && options.cause !== undefined) this.cause = options.cause;
	}
}
export function attributionHeaders() {
	return { "user-agent": "test-harness/0 (+test)" };
}
export function ToolCallId(id) {
	return id;
}
export class LlmAdapter {
	constructor() {}
}
