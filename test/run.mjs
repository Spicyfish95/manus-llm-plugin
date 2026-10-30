// Offline functional test: drives the Manus adapter against a local HTTP mock
// of the Manus v2 API (task.create / task.sendMessage / task.listMessages /
// usage.availableCredits).
import http from "node:http";
import { ManusAdapter } from "../adapter.js";

// Mock mode switch: 'normal' streams progress + result with a paginated page
// boundary; 'progressOnly' produces only progress frames then stops.
let mode = "normal";
let creditShape = "flat";
let createBody = null;
let creditCalls = 0;
let totalCredits = 1000;

const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		const url = new URL(req.url, "http://localhost");
		res.setHeader("content-type", "application/json");
		if (req.method === "POST" && url.pathname === "/v2/task.create") {
			createBody = JSON.parse(body);
			res.end(JSON.stringify({ ok: true, request_id: "r1", task_id: "task_abc123", task_title: "t", task_url: "u" }));
		} else if (req.method === "POST" && url.pathname === "/v2/task.sendMessage") {
			res.end(JSON.stringify({ ok: true, request_id: "r2", task_id: "task_abc123" }));
		} else if (req.method === "POST" && url.pathname === "/v2/task.stop") {
			res.end(JSON.stringify({ ok: true, request_id: "r3", task_id: "task_abc123" }));
		} else if (req.method === "GET" && url.pathname === "/v2/usage.availableCredits") {
			creditCalls += 1;
			// Every read after the first sees 10 credits gone (a turn's spend).
			if (creditCalls > 1) totalCredits = 990;
			// FLAT body, exactly as the live endpoint answers: the credit fields
			// sit at the top level next to ok/request_id, NOT under `data`.
			const creditsBody = {
				total_credits: totalCredits,
				free_credits: 100,
				periodic_credits: 800,
				addon_credits: 0,
				refresh_credits: 50,
				next_refresh_time: "1767000000",
				refresh_interval: "daily",
				current_period_end: "1768000000"
			};
			res.end(JSON.stringify(creditShape === "nested"
				? { ok: true, request_id: "rc1", data: creditsBody }
				: { ok: true, request_id: "rc1", ...creditsBody }));
		} else if (req.method === "GET" && url.pathname === "/v2/task.listMessages") {
			const cursor = url.searchParams.get("start_event_id");
			if (mode === "progressOnly") {
				if (!cursor) {
					res.end(JSON.stringify({
						ok: true,
						task_id: "task_abc123",
						messages: [
							{ id: "p1", type: "status_update", timestamp: 1, status_update: { agent_status: "running" } },
							{ id: "p2", type: "assistant_message", timestamp: 2, assistant_message: { content: "Only progress frames here.", delivery_kind: "progress" } }
						],
						has_more: false
					}));
				} else {
					res.end(JSON.stringify({
						ok: true,
						task_id: "task_abc123",
						messages: [{ id: "p3", type: "status_update", timestamp: 3, status_update: { agent_status: "stopped" } }],
						has_more: false
					}));
				}
				return;
			}
			if (mode === "attachments") {
				if (!cursor) {
					res.end(JSON.stringify({
						ok: true,
						task_id: "task_abc123",
						messages: [
							{
								id: "a1",
								type: "assistant_message",
								timestamp: 2,
								assistant_message: {
									content: [
										"Image: ![pic](/home/ubuntu/out/image 1.png)",
										"Doc: [Download the report](/home/ubuntu/report.pdf)",
										"Zip: /home/ubuntu/bundle.zip",
										"Keep: [site](https://example.com) and ![remote](https://cdn.example.com/a.png)",
										"Drop: [ghost](/home/ubuntu/missing.bin)",
										"Scheme: [proto](manus-files://x)"
									].join("\n"),
									attachments: [
										{ type: "file", filename: "image 1.png", content_type: "image/png", path: "/home/ubuntu/out/image 1.png", url: "https://cdn.test/img.png", file_uid: "fu1", version_uid: "vu1" },
										{ type: "file", filename: "report.pdf", content_type: "application/pdf", path: "/home/ubuntu/report.pdf", url: "https://cdn.test/report.pdf", file_uid: "fu2", version_uid: "vu2" },
										{ type: "file", filename: "bundle.zip", content_type: "application/zip", path: "/home/ubuntu/bundle.zip", url: "https://cdn.test/bundle.zip", file_uid: "fu3", version_uid: "vu3" }
									]
								}
							},
							{ id: "a2", type: "status_update", timestamp: 3, status_update: { agent_status: "stopped" } }
						],
						has_more: false
					}));
				} else {
					res.end(JSON.stringify({ ok: true, task_id: "task_abc123", messages: [], has_more: false }));
				}
				return;
			}
			if (!cursor) {
				// Page 1 ends mid-turn: `has_more` means page 2 starts at e3.
				res.end(JSON.stringify({
					ok: true,
					task_id: "task_abc123",
					messages: [
						{ id: "e1", type: "status_update", timestamp: 1, status_update: { agent_status: "running", brief: "thinking" } },
						{ id: "e2", type: "assistant_message", timestamp: 2, assistant_message: { content: "Hello from", delivery_kind: "progress" } },
						{ id: "e3", type: "assistant_message", timestamp: 3, assistant_message: { content: "Manus cloud agent!" } }
					],
					has_more: true,
					next_cursor: "e3"
				}));
			} else {
				// `start_event_id` is INCLUSIVE: e3 reappears and must be deduped.
				res.end(JSON.stringify({
					ok: true,
					task_id: "task_abc123",
					messages: [
						{ id: "e3", type: "assistant_message", timestamp: 3, assistant_message: { content: "Manus cloud agent!" } },
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

// v3 config shape: models are tiers, reasoning efforts are Max thinking levels.
const REASONING_EFFORTS = [
	{ id: "max", name: "默认" },
	{ id: "max-medium", name: "中" },
	{ id: "max-high", name: "高" },
	{ id: "max-extra", name: "增强" },
	{ id: "max-ultra", name: "极致" }
];
const EFFORT_IDS = new Set(REASONING_EFFORTS.map((effort) => effort.id));
const config = {
	apiKeyEnv: "MANUS_API_KEY",
	locale: "zh-CN",
	pollIntervalMs: 10,
	pollMaxSeconds: 10,
	requestTimeoutMs: 5000,
	maxTokens: 32000,
	trackCredits: true,
	creditPosition: "composer",
	showProgress: false,
	verboseEvents: false,
	models: [
		{ id: "standard", name: "Manus Standard", description: "balanced" },
		{ id: "lite", name: "Manus Lite", description: "fast" },
		{ id: "max", name: "Manus Max", description: "deep" }
	],
	contextWindows: { standard: 200000, lite: 500000, max: 1000000 },
	contextWindowOf: (model) => ({ standard: 200000, lite: 500000, max: 1000000 })[model] ?? 1000000,
	reasoningEfforts: REASONING_EFFORTS,
	tierOf: (model, effort) => {
		if (model === "max" && typeof effort === "string" && EFFORT_IDS.has(effort)) return effort;
		return ["standard", "lite", "max"].includes(model) ? model : "standard";
	}
};
const logs = [];
const recorded = [];
const credits = { record: (sessionId, spent) => recorded.push({ sessionId, spent }) };
const adapter = new ManusAdapter(
	() => config,
	async (ref) => ref === "MANUS_API_KEY" ? "test-key-123" : undefined,
	(message) => logs.push(message),
	credits
);

async function runTurn(options) {
	const chunks = [];
	for await (const chunk of adapter.generate(options)) {
		chunks.push(chunk);
		if (chunk.type === "finish") break;
	}
	return chunks;
}

const textOf = (chunks) => chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
const userMessage = (text) => ({ role: "user", content: [{ type: "text", text }] });

// 1. Catalog + reasoning metadata: only `max` advertises efforts.
const models = await adapter.listModels("manus");
console.log("listModels:", models.map((m) => m.id).join(","));
const maxModel = await adapter.resolveModel("manus", "max");
const standardModel = await adapter.resolveModel("manus", "standard");
console.log("MAX reasoning efforts:", maxModel.reasoning.efforts.map((e) => e.id).join(","), "default:", maxModel.reasoning.defaultEffort);
console.log("STANDARD has reasoning:", standardModel.reasoning !== undefined);

// 2. First turn: stream, tier selection, block lifecycle, credit delta.
createBody = null;
creditCalls = 0;
totalCredits = 1000;
recorded.length = 0;
const turn1 = await runTurn({
	provider: "manus",
	model: "max",
	reasoningEffort: "max-ultra",
	sessionId: "session-1",
	messages: [
		{ role: "system", content: [{ type: "text", text: "You are a helpful assistant running inside DSH." }] },
		userMessage("Introduce yourself in one line.")
	],
	signal: undefined
});
console.log("TURN1 agent_profile (expect max-ultra):", createBody?.agent_profile);
console.log("TURN1 TEXT:", JSON.stringify(textOf(turn1)));
console.log("TURN1 BLOCK events:", turn1.filter((c) => c.type === "block-start" || c.type === "block-end").map((c) => `${c.type}@${c.index}`).join(","));
const blockEnd = turn1.find((c) => c.type === "block-end");
console.log("TURN1 block-end text matches stream:", JSON.stringify(blockEnd?.block?.text) === JSON.stringify(textOf(turn1)));
const terminal = turn1.at(-1);
console.log("TERMINAL:", JSON.stringify(terminal));
console.log("REPLAY taskId:", terminal?.replayState?.taskId, "blocks:", terminal?.replayState?.blocks?.length);
console.log("CREDITS recorded:", JSON.stringify(recorded));

// 3. Second turn continues the same task via replay state (no task.create).
let createCalls = 0;
const origListener = server.listeners("request")[0];
server.removeAllListeners("request");
server.on("request", (req, res) => {
	if (req.method === "POST" && req.url === "/v2/task.create") createCalls += 1;
	origListener(req, res);
});
const turn2 = await runTurn({
	provider: "manus",
	model: "max",
	messages: [
		userMessage("Introduce yourself in one line."),
		{
			role: "assistant",
			content: [{ type: "text", text: "Hello from\n\nManus cloud agent!" }],
			source: {
				kind: "model",
				provider: "manus",
				model: "max",
				replayState: {
					response: { kind: "manus-task", version: 1, model: "max" },
					blocks: [{ type: "text" }],
					taskId: "task_abc123"
				}
			}
		},
		userMessage("What did I just ask?")
	],
	signal: undefined
});
console.log("TURN2 createCalls (expect 0):", createCalls);
console.log("TURN2 TEXT:", JSON.stringify(textOf(turn2)));

// 4. Progress-only task: the skipped progress text is replayed, not EMPTY_RESPONSE.
mode = "progressOnly";
createBody = null;
creditCalls = 0;
totalCredits = 1000;
recorded.length = 0;
const turn3 = await runTurn({
	provider: "manus",
	model: "standard",
	sessionId: "session-2",
	messages: [userMessage("Summarize.")],
	signal: undefined
});
console.log("TURN3 agent_profile (expect standard):", createBody?.agent_profile);
console.log("TURN3 TEXT (expect progress replay):", JSON.stringify(textOf(turn3)));
console.log("TURN3 CREDITS recorded:", JSON.stringify(recorded));
mode = "normal";

// 5. Attachment rewriting: env paths in content must resolve to signed URLs.
mode = "attachments";
creditCalls = 0;
totalCredits = 1000;
const turn4 = await runTurn({
	provider: "manus",
	model: "standard",
	sessionId: "session-attach",
	messages: [userMessage("Draw a picture and pack the files.")],
	signal: undefined
});
const attachText = textOf(turn4);
console.log("ATTACH TEXT:", JSON.stringify(attachText));
const attachChecks = [
	[attachText.includes("![pic](https://cdn.test/img.png)"), "image env path → signed URL"],
	[attachText.includes("[report.pdf](https://cdn.test/report.pdf)"), "doc link → filename + signed URL"],
	[attachText.includes("[bundle.zip](https://cdn.test/bundle.zip)"), "bare zip path → download link"],
	[attachText.includes("[site](https://example.com)") && attachText.includes("![remote](https://cdn.example.com/a.png)"), "http(s) destinations untouched"],
	[!attachText.includes("/home/ubuntu/missing.bin") && !attachText.includes("[ghost]"), "unresolvable node dropped"],
	[!attachText.includes("manus-files://"), "unknown scheme node dropped"],
	[!attachText.includes("image%201.png"), "URL-decoded path matched (space filename)"]
];
for (const [pass, label] of attachChecks) {
	console.log("ATTACH:", pass ? "ok" : "FAIL", "-", label);
	if (!pass) process.exitCode = 1;
}
mode = "normal";

// 6. Probe path: a FLAT credits body must read as a healthy connection.
// This is the regression for 「检测连接：Manus 返回了无法识别的余额数据」 —
// the old parser only looked under `data` and rejected the live shape.
creditCalls = 0;
totalCredits = 1000;
const probeOk = await adapter.probe("test-key-123");
console.log("PROBE ok:", probeOk.ok, "total:", probeOk.total, "code:", probeOk.code ?? "-");
if (probeOk.ok !== true || probeOk.total !== 1000) {
	console.log("PROBE: FAIL — flat credits body was not recognised");
	process.exitCode = 1;
}
// Nested `data` (older docs) must still parse, so a shape change cannot regress.
creditCalls = 0;
creditShape = "nested";
const probeNested = await adapter.probe("test-key-123");
console.log("PROBE nested ok:", probeNested.ok, "total:", probeNested.total);
if (probeNested.ok !== true) {
	console.log("PROBE nested: FAIL — nested data shape no longer parses");
	process.exitCode = 1;
}
creditShape = "flat";

// 6. Error path: no API key (credentials + env both miss).
const noKey = new ManusAdapter(() => ({ ...config }), async () => undefined, () => {}, credits);
try {
	for await (const chunk of noKey.generate({ provider: "manus", model: "standard", messages: [userMessage("hi")], signal: undefined })) {
		void chunk;
	}
	console.log("NOKEY: FAIL — expected error");
} catch (error) {
	console.log("NOKEY:", error.code, "-", error.message);
}

server.close();
console.log("LOGS:", logs.join(" | "));
console.log("TEST_DONE");
process.exit(0);
