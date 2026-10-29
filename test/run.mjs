// Offline functional test: drives the Manus adapter against a local HTTP mock
// of the Manus v2 API (task.create / task.sendMessage / task.listMessages).
import http from "node:http";
import { ManusAdapter } from "../adapter.js";

const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		const url = new URL(req.url, "http://localhost");
		res.setHeader("content-type", "application/json");
		if (req.method === "POST" && url.pathname === "/v2/task.create") {
			res.end(JSON.stringify({ ok: true, request_id: "r1", task_id: "task_abc123", task_title: "t", task_url: "u" }));
		} else if (req.method === "POST" && url.pathname === "/v2/task.sendMessage") {
			res.end(JSON.stringify({ ok: true, request_id: "r2", task_id: "task_abc123" }));
		} else if (req.method === "GET" && url.pathname === "/v2/task.listMessages") {
			const cursor = url.searchParams.get("start_event_id");
			if (!cursor) {
				res.end(JSON.stringify({
					ok: true,
					task_id: "task_abc123",
					messages: [
						{ id: "e1", type: "status_update", timestamp: 1, status_update: { agent_status: "running", brief: "thinking" } },
						{ id: "e2", type: "assistant_message", timestamp: 2, assistant_message: { content: "Hello from", delivery_kind: "progress" } },
						{ id: "e3", type: "assistant_message", timestamp: 3, assistant_message: { content: "Manus cloud agent!" } }
					],
					has_more: false,
					next_cursor: "e3"
				}));
			} else {
				res.end(JSON.stringify({
					ok: true,
					task_id: "task_abc123",
					messages: [
						{ id: "e4", type: "status_update", timestamp: 4, status_update: { agent_status: "stopped" } }
					],
					has_more: false
				}));
			}
		} else {
			res.statusCode = 404;
			res.end(JSON.stringify({ ok: false, error: { code: "not_found", message: "no such endpoint" } }));
		}
	});
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

// Point the adapter at the mock by overriding globalThis.fetch.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
	const url = String(input);
	if (url.startsWith("https://api.manus.ai/")) {
		const rewritten = url.replace("https://api.manus.ai", `http://127.0.0.1:${port}`);
		return realFetch(rewritten, init);
	}
	return realFetch(input, init);
};

// Fake AuthError check: config with a key.
const config = {
	apiKey: "test-key-123",
	apiKeyEnv: "MANUS_API_KEY",
	locale: "zh-CN",
	pollIntervalMs: 10,
	pollMaxSeconds: 10,
	requestTimeoutMs: 5000,
	contextWindow: 1000000,
	maxTokens: 32000,
	showProgress: true,
	verboseEvents: false,
	models: [
		{ id: "standard", name: "Manus Standard", description: "default" },
		{ id: "max-ultra", name: "Manus Max Ultra", description: "deepest" }
	],
	profileOf: (model) => ["standard", "lite", "max", "max-medium", "max-high", "max-extra", "max-ultra"].includes(model) ? model : "standard"
};
const logs = [];
const adapter = new ManusAdapter(() => config, (message) => logs.push(message));

// 1. listModels / resolveModel
const models = await adapter.listModels("manus");
console.log("listModels:", models.map((m) => m.id).join(","));

// 2. Full stream: first turn
const chunks = [];
for await (const chunk of adapter.generate({
	provider: "manus",
	model: "max-ultra",
	messages: [
		{ role: "system", content: [{ type: "text", text: "You are a helpful assistant running inside DSH." }] },
		{ role: "user", content: [{ type: "text", text: "Introduce yourself in one line." }] }
	],
	signal: undefined
})) {
	chunks.push(chunk);
	if (chunk.type === "finish") break;
}
const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
const terminal = chunks.at(-1);
console.log("STREAM TEXT:", JSON.stringify(text));
console.log("TERMINAL:", JSON.stringify(terminal));
console.log("REPLAY taskId:", terminal?.replayState?.taskId);
const blockTypes = chunks.filter((c) => c.type === "block-start" || c.type === "block-end").map((c) => c.type);
console.log("BLOCK events:", blockTypes.join(","));

// 3. Second turn continues the same task via replay state.
let createCalls = 0;
const origListener = server.listeners("request")[0];
server.removeAllListeners("request");
server.on("request", (req, res) => {
	if (req.method === "POST" && req.url === "/v2/task.create") createCalls += 1;
	origListener(req, res);
});
const chunks2 = [];
for await (const chunk of adapter.generate({
	provider: "manus",
	model: "max-ultra",
	messages: [
		{ role: "user", content: [{ type: "text", text: "Introduce yourself in one line." }] },
		{
			role: "assistant",
			content: [{ type: "text", text: "Hello from Manus cloud agent!" }],
			source: { kind: "model", provider: "manus", model: "max-ultra", replayState: { response: { kind: "manus-task", version: 1, model: "max-ultra" }, blocks: [{ type: "text", taskId: "task_abc123" }], taskId: "task_abc123" } }
		},
		{ role: "user", content: [{ type: "text", text: "What did I just ask?" }] }
	],
	signal: undefined
})) {
	chunks2.push(chunk);
	if (chunk.type === "finish") break;
}
console.log("TURN2 createCalls (expect 0):", createCalls);
console.log("TURN2 TEXT:", JSON.stringify(chunks2.filter((c) => c.type === "text-delta").map((c) => c.text).join("")));
console.log("LOGS:", logs.join(" | "));

// 4. Error path: no API key.
const noKey = new ManusAdapter(() => ({ ...config, apiKey: undefined }), () => {});
try {
	for await (const chunk of noKey.generate({
		provider: "manus", model: "standard",
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }]
	})) { void chunk; }
	console.log("NOKEY: FAIL — expected error");
} catch (error) {
	console.log("NOKEY:", error.code, "-", error.message);
}

server.close();
console.log("TEST_DONE");
process.exit(0);
