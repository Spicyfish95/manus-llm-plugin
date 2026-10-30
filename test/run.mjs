// Offline functional test: drives the Manus adapter against a local HTTP mock
// of the Manus v2 API (task.create / task.sendMessage / task.listMessages /
// usage.availableCredits).
import http from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManusAdapter } from "../adapter.js";

// Mock CDN bodies for the workspace-download mode: the signed URLs in
// `attachments[]` point at https://cdn.test/<name> and are served from here.
const CDN_BODIES = new Map([
	["img.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])],
	["report.pdf", Buffer.from("%PDF-1.4\n%fake report\n")],
	["bundle.zip", Buffer.from("PK\u0003\u0004 fake zip\n")]
]);

// Mock mode switch: 'normal' streams progress + result with a paginated page
// boundary; 'progressOnly' produces only progress frames then stops.
let mode = "normal";
let creditShape = "flat";
let createBody = null;
let sendBody = null;
let creditCalls = 0;
let totalCredits = 1000;

const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		const url = new URL(req.url, "http://localhost");
		if (req.method === "GET" && url.pathname.startsWith("/cdn/")) {
			const name = url.pathname.slice("/cdn/".length);
			const body = CDN_BODIES.get(name);
			if (body === undefined) {
				res.statusCode = 404;
				res.end("not found");
				return;
			}
			res.setHeader("content-type", "application/octet-stream");
			res.setHeader("content-length", String(body.length));
			res.end(body);
			return;
		}
		res.setHeader("content-type", "application/json");
		if (req.method === "POST" && url.pathname === "/v2/task.create") {
			createBody = JSON.parse(body);
			res.end(JSON.stringify({ ok: true, request_id: "r1", task_id: "task_abc123", task_title: "t", task_url: "u" }));
		} else if (req.method === "POST" && url.pathname === "/v2/task.sendMessage") {
			sendBody = JSON.parse(body);
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
			if (mode === "imageOnly") {
				// A message whose ONLY content is an image markdown node: the node is
				// dropped (the durable block carries the picture), so text is empty
				// and the turn must still emit the image block at index 0 and a
				// footnote text block at index 1.
				if (!cursor) {
					res.end(JSON.stringify({
						ok: true,
						task_id: "task_abc123",
						messages: [
							{
								id: "i1",
								type: "assistant_message",
								timestamp: 2,
								assistant_message: {
									content: "![pic](/home/ubuntu/only.png)",
									attachments: [
										{ type: "file", filename: "only.png", content_type: "image/png", path: "/home/ubuntu/only.png", url: "https://cdn.test/img.png", file_uid: "fu1", version_uid: "vu1" }
									]
								}
							},
							{ id: "i2", type: "status_update", timestamp: 3, status_update: { agent_status: "stopped" } }
						],
						has_more: false
					}));
				} else {
					res.end(JSON.stringify({ ok: true, task_id: "task_abc123", messages: [], has_more: false }));
				}
				return;
			}
			if (mode === "followup") {
				// A task that already has history. Polling WITHOUT a cursor returns
				// the whole transcript (the old answer + its attachment); polling
				// from the replayed cursor returns only the events this turn
				// produced. The adapter must resume from the cursor, otherwise every
				// follow-up repeats the previous answer and re-downloads its files.
				if (!cursor) {
					res.end(JSON.stringify({
						ok: true,
						task_id: "task_abc123",
						messages: [
							{ id: "f1", type: "status_update", timestamp: 1, status_update: { agent_status: "running" } },
							{
								id: "f2",
								type: "assistant_message",
								timestamp: 2,
								assistant_message: {
									content: "Old answer: ![old](/home/ubuntu/old.png)",
									attachments: [
										{ type: "file", filename: "old.png", content_type: "image/png", path: "/home/ubuntu/old.png", url: "https://cdn.test/img.png", file_uid: "fo1", version_uid: "fv1" }
									]
								}
							},
							{ id: "f3", type: "status_update", timestamp: 3, status_update: { agent_status: "stopped" } }
						],
						has_more: false
					}));
				} else {
					res.end(JSON.stringify({
						ok: true,
						task_id: "task_abc123",
						messages: [
							{ id: "f4", type: "assistant_message", timestamp: 4, assistant_message: { content: "New answer only." } },
							{ id: "f5", type: "status_update", timestamp: 5, status_update: { agent_status: "stopped" } }
						],
						has_more: false
					}));
				}
				return;
			}
			if (mode === "attachmentsMulti") {
				// Two assistant messages in one turn: the first carries an image
				// attachment, the second continues the answer as text. This is the
				// shape that catches "text deltas written into the image block's
				// index" — the open text block must keep its own index.
				if (!cursor) {
					res.end(JSON.stringify({
						ok: true,
						task_id: "task_abc123",
						messages: [
							{
								id: "m1",
								type: "assistant_message",
								timestamp: 2,
								assistant_message: {
									content: "First part: ![pic](/home/ubuntu/pic.png)",
									attachments: [
										{ type: "file", filename: "pic.png", content_type: "image/png", path: "/home/ubuntu/pic.png", url: "https://cdn.test/img.png", file_uid: "fu1", version_uid: "vu1" }
									]
								}
							},
							{ id: "m2", type: "assistant_message", timestamp: 3, assistant_message: { content: "Second part continues here." } },
							{ id: "m3", type: "status_update", timestamp: 4, status_update: { agent_status: "stopped" } }
						],
						has_more: false
					}));
				} else {
					res.end(JSON.stringify({ ok: true, task_id: "task_abc123", messages: [], has_more: false }));
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
	// Signed CDN downloads: serve the in-memory bodies instead of the network.
	if (url.startsWith("https://cdn.test/")) {
		const rewritten = url.replace("https://cdn.test", `http://127.0.0.1:${port}/cdn`);
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

// Workspace mode: a temp dir stands in for the session workspace, and the
// bridge mimics the host's attachment store + loopback file route.
const WORKSPACE_ROOT = await mkdtemp(path.join(tmpdir(), "manus-ws-"));
const imageRefs = [];
const workspaceBridge = {
	async resolveWorkspace(sessionId) {
		// The "no-workspace" session exercises the degrade path.
		return sessionId === "session-noworkspace" ? undefined : WORKSPACE_ROOT;
	},
	async saveImage({ data, mediaType, name }) {
		const ref = {
			attachmentId: `sha256:${"0".repeat(16)}`,
			mediaType,
			bytes: data.length,
			width: 1,
			height: 1,
			name
		};
		imageRefs.push(ref);
		return ref;
	},
	fileUrl(sessionId, fileName) {
		return `/plugins/manus-llm/file?${new URLSearchParams({ sessionId, name: fileName }).toString()}`;
	}
};
const workspaceAdapter = new ManusAdapter(
	() => ({ ...config, downloadAttachments: true, downloadDirName: "manus-files" }),
	async (ref) => ref === "MANUS_API_KEY" ? "test-key-123" : undefined,
	(message) => logs.push(message),
	credits,
	workspaceBridge
);

async function runTurn(options, target = adapter) {
	const chunks = [];
	for await (const chunk of target.generate(options)) {
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
// Only the latest user text is forwarded: no harness system prompt, no
// history replay, no <environment> wrapper. This is the regression for
// 「Manus 网页端首条消息显示 You are an AI agent powered by DeepSeek Harness…」.
const turn1Prompt = createBody?.message?.content ?? "";
const turn1PromptChecks = [
	[turn1Prompt === "Introduce yourself in one line.", `first-turn prompt is exactly the user text (got ${JSON.stringify(turn1Prompt)})`],
	[!turn1Prompt.includes("DeepSeek Harness"), "no harness system prompt leak"],
	[!turn1Prompt.includes("<environment>"), "no <environment> wrapper"],
	[!turn1Prompt.includes("helpful assistant"), "system message not forwarded"]
];
for (const [pass, label] of turn1PromptChecks) {
	console.log("TURN1 PROMPT:", pass ? "ok" : "FAIL", "-", label);
	if (!pass) process.exitCode = 1;
}
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
// Follow-up: the sendMessage body must also carry ONLY the latest user text —
// not the replayed assistant history and not any tool/system framing.
const turn2Prompt = sendBody?.message?.content ?? "";
const turn2PromptChecks = [
	[turn2Prompt === "What did I just ask?", `follow-up prompt is exactly the latest user text (got ${JSON.stringify(turn2Prompt)})`],
	[!turn2Prompt.includes("Hello from"), "previous assistant reply not forwarded"]
];
for (const [pass, label] of turn2PromptChecks) {
	console.log("TURN2 PROMPT:", pass ? "ok" : "FAIL", "-", label);
	if (!pass) process.exitCode = 1;
}

// 3b. Tool-loop degradation: a tool result after the latest user turn is
// appended as readable text (Manus has its own tools; the harness loop
// degrades them), and nothing BEFORE the latest user turn is forwarded.
const turn2b = await runTurn({
	provider: "manus",
	model: "max",
	messages: [
		{ role: "system", content: [{ type: "text", text: "SYSTEM-NEVER-FORWARDED" }] },
		userMessage("Earlier user turn ABCXYZ."),
		{ role: "assistant", content: [{ type: "text", text: "ack reply stale for forwarding" }] },
		userMessage("Read the file."),
		{
			role: "assistant",
			content: [],
			toolCalls: [{ id: "call_1", name: "read", arguments: {} }],
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
		{ role: "tool", toolCallId: "call_1", content: [{ type: "text", text: "file contents here" }] }
	],
	signal: undefined
});
const turn2bPrompt = sendBody?.message?.content ?? "";
const turn2bChecks = [
	[turn2bPrompt.startsWith("Read the file."), `prompt starts with the user text (got ${JSON.stringify(turn2bPrompt)})`],
	[turn2bPrompt.includes('Result of tool call "call_1":'), "trailing tool result appended"],
	[turn2bPrompt.includes("file contents here"), "tool result text carried"],
	[!turn2bPrompt.includes("ABCXYZ"), "earlier user turns not forwarded"],
	[!turn2bPrompt.includes("stale for forwarding"), "earlier assistant replies not forwarded"],
	[!turn2bPrompt.includes("SYSTEM-NEVER-FORWARDED"), "system message never forwarded"]
];
for (const [pass, label] of turn2bChecks) {
	console.log("TURN2B TOOL DEGRADE:", pass ? "ok" : "FAIL", "-", label);
	if (!pass) process.exitCode = 1;
}

// 3c. Harness-injected user-role messages must never be forwarded: the
// latest "user" message can be a time-context clock reading, a runtime-context
// snapshot, or a compaction checkpoint. The scan must skip them and forward
// the latest REAL user text instead (user bug: 显示当前时间 arrived on Manus
// as the literal clock text).
sendBody = null;
createBody = null;
const turn2c = await runTurn({
	provider: "manus",
	model: "max",
	messages: [
		{
			role: "user",
			content: [{ type: "text", text: "显示当前时间" }]
		},
		{
			role: "user",
			source: {
				kind: "time-context",
				form: "snapshot",
				sections: [{ name: "time-context", text: "x" }]
			},
			content: [{ type: "text", text: "Time sampled while preparing turn 6, step 2: 2026-10-30T15:33:26+08:00[Asia/Hong_Kong]" }]
		},
		{
			role: "user",
			source: { kind: "runtime-context" },
			content: [{ type: "text", text: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots." }]
		},
		{
			role: "user",
			source: { kind: "compact-checkpoint", compactionId: "c1" },
			content: [{ type: "text", text: "[Compressed conversation section] — checkpoint" }]
		}
	],
	signal: undefined
});
const turn2cPrompt = sendBody?.message?.content ?? createBody?.message?.content ?? "";
const turn2cChecks = [
	[turn2cPrompt === "显示当前时间", `synthetic user messages skipped, real user text forwarded (got ${JSON.stringify(turn2cPrompt)})`],
	[!turn2cPrompt.includes("Time sampled"), "time-context clock reading never forwarded"],
	[!turn2cPrompt.includes("runtime-context snapshots"), "runtime-context snapshot never forwarded"],
	[!turn2cPrompt.includes("Compressed conversation section"), "compaction checkpoint never forwarded"]
];
for (const [pass, label] of turn2cChecks) {
	console.log("TURN2C SYNTHETIC:", pass ? "ok" : "FAIL", "-", label);
	if (!pass) process.exitCode = 1;
}

// 3d. Defensive default: a user message with NO source (or an unknown source
// kind) is treated as real user input and forwarded.
sendBody = null;
createBody = null;
const turn2d = await runTurn({
	provider: "manus",
	model: "max",
	messages: [
		{ role: "user", source: { kind: "some-future-kind" }, content: [{ type: "text", text: "future injected kind" }] },
		userMessage("plain user text without source")
	],
	signal: undefined
});
const turn2dPrompt = sendBody?.message?.content ?? createBody?.message?.content ?? "";
const turn2dChecks = [
	[turn2dPrompt === "plain user text without source", `unknown/absent source kinds treated as real user (got ${JSON.stringify(turn2dPrompt)})`]
];
for (const [pass, label] of turn2dChecks) {
	console.log("TURN2D DEFENSIVE:", pass ? "ok" : "FAIL", "-", label);
	if (!pass) process.exitCode = 1;
}

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

// 5b. Workspace download mode: attachments land in <workspace>/manus-files/,
// image markdown becomes a durable image block, file links point at the
// loopback route, and the reply ends with the saved-path footnote.
mode = "attachments";
creditCalls = 0;
totalCredits = 1000;
const turn5 = await runTurn({
	provider: "manus",
	model: "standard",
	sessionId: "session-workspace",
	messages: [userMessage("Draw a picture and pack the files.")],
	signal: undefined
}, workspaceAdapter);
const wsText = textOf(turn5);
const wsBlocks = turn5.filter((c) => c.type === "block-end").map((c) => c.block);
const wsImages = wsBlocks.filter((block) => block.type === "image");
const wsImageBlockEvents = turn5.filter((c) => c.type === "block-end" && c.block.type === "image");
const wsTerminal = turn5.at(-1);
const wsReplay = wsTerminal?.replayState;
const wsFiles = await readdir(path.join(WORKSPACE_ROOT, "manus-files"));
const wsChecks = [
	[wsFiles.length === 3, `3 files saved (got ${JSON.stringify(wsFiles)})`],
	[wsFiles.includes("image 1.png") && wsFiles.includes("report.pdf") && wsFiles.includes("bundle.zip"), "sanitized names on disk"],
	[!wsText.includes("https://cdn.test/img.png"), "image markdown node dropped (replaced by image block)"],
	[wsText.includes("![pic]") === false, "image markdown node gone from text"],
	[wsText.includes("[report.pdf](/plugins/manus-llm/file?") && wsText.includes("name=report.pdf"), "doc link → loopback file route"],
	[wsText.includes("[bundle.zip](/plugins/manus-llm/file?") && wsText.includes("name=bundle.zip"), "bare zip path → loopback file route"],
	[wsText.includes("已保存 3 个文件到工作区"), "footnote lists saved files"],
	[wsText.includes("manus-files") && wsText.includes("report.pdf"), "footnote carries local path"],
	[wsImages.length === 1, `one durable image block (got ${wsImages.length})`],
	[wsImageBlockEvents.length === 1 && wsImageBlockEvents[0].index === 1, "image block emitted block-end-only at index 1"],
	[wsImages[0]?.attachment?.attachmentId?.startsWith("sha256:"), "image block carries an attachment ref"],
	[wsReplay?.blocks?.length === 2 && wsReplay.blocks[0].type === "text" && wsReplay.blocks[1].type === "image", `replay envelope aligned (got ${JSON.stringify(wsReplay?.blocks)})`],
	[wsReplay?.taskId === "task_abc123", "replay keeps the task handle"],
	[(await readFile(path.join(WORKSPACE_ROOT, "manus-files", "report.pdf"), "utf8")).includes("fake report"), "file bytes written"]
];
for (const [pass, label] of wsChecks) {
	console.log("WORKSPACE:", pass ? "ok" : "FAIL", "-", label);
	if (!pass) process.exitCode = 1;
}
console.log("WORKSPACE TEXT:", JSON.stringify(wsText));
console.log("WORKSPACE FILES:", JSON.stringify(wsFiles));

// 5c. Degrade path: no resolvable workspace → signed URLs stay, no footnote,
// no image block, and the replay envelope keeps its single text entry.
const turn6 = await runTurn({
	provider: "manus",
	model: "standard",
	sessionId: "session-noworkspace",
	messages: [userMessage("Same attachments, no workspace.")],
	signal: undefined
}, workspaceAdapter);
const degText = textOf(turn6);
const degReplay = turn6.at(-1)?.replayState;
const degChecks = [
	[degText.includes("![pic](https://cdn.test/img.png)"), "image keeps signed URL"],
	[degText.includes("[report.pdf](https://cdn.test/report.pdf)"), "doc keeps signed URL"],
	[!degText.includes("/plugins/manus-llm/file"), "no loopback link without a workspace"],
	[!degText.includes("已保存"), "no footnote without a workspace"],
	[turn6.filter((c) => c.type === "block-end" && c.block.type === "image").length === 0, "no image block without a workspace"],
	[degReplay?.blocks?.length === 1 && degReplay.blocks[0].type === "text", `replay stays text-only (got ${JSON.stringify(degReplay?.blocks)})`]
];
for (const [pass, label] of degChecks) {
	console.log("DEGRADE:", pass ? "ok" : "FAIL", "-", label);
	if (!pass) process.exitCode = 1;
}
mode = "normal";

// 5d. Multi-message turn: an image block must not capture the text deltas
// that arrive in the NEXT assistant message. The open text block keeps index 0
// while the image takes index 1; "Second part…" must land on index 0.
mode = "attachmentsMulti";
const turn7 = await runTurn({
	provider: "manus",
	model: "standard",
	sessionId: "session-workspace",
	messages: [userMessage("Two-part answer.")],
	signal: undefined
}, workspaceAdapter);
const multiDeltas = turn7.filter((c) => c.type === "text-delta");
const multiImageBlockEnds = turn7.filter((c) => c.type === "block-end" && c.block.type === "image");
const multiTextBlockEnd = turn7.find((c) => c.type === "block-end" && c.block.type === "text");
const multiChecks = [
	[multiDeltas.every((c) => c.index === 0), `all text deltas on index 0 (got ${JSON.stringify(multiDeltas.map((c) => c.index))})`],
	[multiImageBlockEnds.length === 1 && multiImageBlockEnds[0].index === 1, "image block on its own index 1"],
	[textOf(turn7).includes("Second part continues here."), "second message text present"],
	[multiTextBlockEnd?.block?.text?.includes("Second part continues here."), "text block carries both parts"],
	[!multiTextBlockEnd?.block?.text?.includes("![pic]"), "image markdown removed from text"]
];
for (const [pass, label] of multiChecks) {
	console.log("MULTI:", pass ? "ok" : "FAIL", "-", label);
	if (!pass) process.exitCode = 1;
}
mode = "normal";

// 5g. Follow-up turn resumes from the replayed event cursor: the task's old
// answer (and its attachment) must NOT be replayed again. Without the cursor
// the adapter re-reads the whole transcript, duplicating old text and
// re-downloading old files into -2/-3 copies.
mode = "followup";
const followDir = path.join(WORKSPACE_ROOT, "manus-files");
await rm(followDir, { recursive: true, force: true });
const turnFollow = await runTurn({
	provider: "manus",
	model: "standard",
	sessionId: "session-workspace",
	messages: [
		userMessage("Draw it."),
		{
			role: "assistant",
			content: [{ type: "text", text: "Old answer" }],
			source: {
				kind: "model",
				provider: "manus",
				model: "standard",
				replayState: {
					response: { kind: "manus-task", version: 1, model: "standard" },
					blocks: [{ type: "text" }],
					taskId: "task_abc123",
					cursor: "f3"
				}
			}
		},
		userMessage("Now the follow-up.")
	],
	signal: undefined
}, workspaceAdapter);
const followText = textOf(turnFollow);
const followReplay = turnFollow.at(-1)?.replayState;
let followFiles = [];
try {
	followFiles = await readdir(followDir);
} catch {
	followFiles = [];
}
const followChecks = [
	[!followText.includes("Old answer"), "old transcript not replayed"],
	[followText.includes("New answer only."), "only the new answer streams"],
	[followFiles.length === 0, `no stale attachment re-downloaded (got ${JSON.stringify(followFiles)})`],
	[followReplay?.taskId === "task_abc123", "task handle preserved"],
	[followReplay?.cursor === "f5", `cursor advanced to the last event (got ${JSON.stringify(followReplay?.cursor)})`],
	[followReplay?.blocks?.length === 1 && followReplay.blocks[0].type === "text", "replay blocks stay aligned"]
];
for (const [pass, label] of followChecks) {
	console.log("FOLLOWUP:", pass ? "ok" : "FAIL", "-", label);
	if (!pass) process.exitCode = 1;
}
mode = "normal";

// 5e. Image-only turn: no text at all, one image attachment. The image block
// lands at index 0 and the footnote opens a text block at index 1; the replay
// envelope must carry both entries.
mode = "imageOnly";
const turn8 = await runTurn({
	provider: "manus",
	model: "standard",
	sessionId: "session-workspace",
	messages: [userMessage("Just draw it.")],
	signal: undefined
}, workspaceAdapter);
const onlyBlocks = turn8.filter((c) => c.type === "block-end").map((c) => c.block);
const onlyReplay = turn8.at(-1)?.replayState;
const onlyChecks = [
	[onlyBlocks.length === 2, `two blocks (got ${onlyBlocks.length})`],
	[onlyBlocks[0]?.type === "image", "image block first"],
	[onlyBlocks[1]?.type === "text", "footnote text block second"],
	[onlyBlocks[1]?.text?.includes("已保存 1 个文件"), "footnote reports the single file"],
	[onlyReplay?.blocks?.length === 2, `replay carries 2 entries (got ${JSON.stringify(onlyReplay?.blocks)})`],
	[onlyReplay?.taskId === "task_abc123", "task handle preserved"]
];
for (const [pass, label] of onlyChecks) {
	console.log("IMAGEONLY:", pass ? "ok" : "FAIL", "-", label);
	if (!pass) process.exitCode = 1;
}
mode = "normal";

// 5f. No-workspace degrade for a MULTI-message turn: replay must stay aligned
// with the blocks actually emitted (text only, no image).
await rm(WORKSPACE_ROOT, { recursive: true, force: true });
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
