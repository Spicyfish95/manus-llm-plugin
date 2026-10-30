// Offline host-half test: drives index.js `apply(ctx, config)` with a stubbed
// cordis context and a fake webServer, then exercises the /file route plus the
// workspace bridge's workspace resolution and image registration.
//
// This is the half the adapter test cannot reach: the route's path traversal
// guards, the 404/403/405 contracts, and `resolveWorkspace` going through the
// `agents` / `sessions` registries.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { apply } = await import("../index.js");

// ---- stubbed cordis context ------------------------------------------------
const routes = new Map();
const effects = [];
const loggerMessages = [];
let adapterInstance;
let configurableProviders;
let discoveryEntry;

const webServer = {
	register(route) {
		routes.set(route.path, route);
		return () => routes.delete(route.path);
	}
};

const workspace = await mkdtemp(path.join(tmpdir(), "manus-host-"));
const sessions = new Map([
	["session-live", { header: { cwd: workspace } }],
	["session-store", { header: {} , cwd: workspace }]
]);
const agents = {
	get(sessionId) {
		if (sessionId !== "session-live") return undefined;
		return { session: { header: { cwd: workspace } } };
	}
};
const savedImages = [];
const attachments = {
	async saveImages(inputs) {
		return inputs.map((input) => {
			const ref = {
				attachmentId: `sha256:${String(savedImages.length).padStart(4, "0")}`,
				mediaType: input.mediaType,
				width: 4,
				height: 4,
				bytes: input.data.length,
				...(input.name === undefined ? {} : { name: input.name })
			};
			savedImages.push({ input, ref });
			return ref;
		});
	}
};

const credentials = {
	async resolve(ref) {
		return ref === "MANUS_API_KEY" ? { value: "key-abc" } : undefined;
	},
	async describe() {
		return { configured: true, source: "store", writable: true };
	},
	async set() {},
	async unset() {}
};

const settings = {
	describe() {
		return [{ ns: "manus-llm", revision: 4 }];
	},
	async mutate() {},
	configure() {
		return () => {};
	}
};

const llm = {
	registerAdapter(providers, adapter) {
		adapterInstance = adapter;
		configurableProviders = providers;
	},
	registerConfigurableProviders(list) {
		configurableProviders = list;
	},
	registerModelDiscovery(entryId, fn) {
		discoveryEntry = { entryId, fn };
	}
};

const services = { webServer, attachments, credentials, settings, llm, agents, sessions };
const ctx = {
	fiber: { entry: { options: { id: "manus-llm" } } },
	// Cordis exposes injected services as direct properties of the child
	// context, and `ctx.get(name)` reads them by name.
	...services,
	get(name) {
		return services[name];
	},
	inject(names, callback) {
		if (!names.every((name) => services[name] !== undefined)) return () => {};
		return callback(ctx);
	},
	effect(fn, label) {
		effects.push({ fn, label });
		const dispose = typeof fn === "function" ? fn() : undefined;
		return () => {
			if (typeof dispose === "function") dispose();
		};
	},
	on() {
		return () => {};
	},
	logger: {
		info(message) {
			loggerMessages.push(message);
		}
	}
};

// Volatile refs behave like schemastery's: a callable with .get().
const ref = (value) => Object.assign(() => value, { get: () => value });
const config = {
	defaultProfile: ref("standard"),
	locale: ref("zh-CN"),
	pollIntervalMs: ref(2000),
	pollMaxSeconds: ref(1200),
	requestTimeoutMs: ref(60000),
	maxTokens: ref(32000),
	trackCredits: ref(true),
	creditPosition: ref("composer"),
	showProgress: ref(false),
	downloadAttachments: ref(true),
	downloadDirName: ref("manus-files"),
	verboseEvents: ref(false),
	apiKeyLabel: ref("ManusApikey01"),
	modelContexts: ref({ standard: 500000, lite: 500000, max: 500000 })
};

apply(ctx, config);

assert.equal(adapterInstance !== undefined, true, "adapter must be registered");
assert.equal(Array.isArray(configurableProviders), true, "configurable provider must be registered");
assert.equal(discoveryEntry?.entryId, "manus-llm", "model discovery must be registered");

const expectedRoutes = [
	"/plugins/manus-llm/credits",
	"/plugins/manus-llm/config",
	"/plugins/manus-llm/credential",
	"/plugins/manus-llm/test",
	"/plugins/manus-llm/file"
];
for (const routePath of expectedRoutes) {
	assert.equal(routes.has(routePath), true, `route must be registered: ${routePath}`);
}
console.log("ROUTES: ok -", expectedRoutes.length, "routes registered");

// ---- fake req/res ----------------------------------------------------------
function fakeRequest({ method = "GET", url = "/", headers = {} } = {}) {
	return {
		method,
		url,
		headers,
		async *[Symbol.asyncIterator]() {}
	};
}
function fakeResponse() {
	const res = {
		statusCode: 0,
		headers: {},
		body: undefined,
		writeHead(status, headers) {
			res.statusCode = status;
			res.headers = headers ?? {};
		},
		end(body) {
			res.body = body;
		}
	};
	return res;
}
async function call(routePath, options) {
	const route = routes.get(routePath);
	assert.equal(route !== undefined, true, `route missing: ${routePath}`);
	const res = fakeResponse();
	await route.handler(fakeRequest(options), res);
	return res;
}

// ---- /file route contract --------------------------------------------------
const dir = path.join(workspace, "manus-files");
await mkdir(dir, { recursive: true });
await writeFile(path.join(dir, "report.pdf"), "fake pdf body");
await writeFile(path.join(dir, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
await writeFile(path.join(dir, "notes.md"), "# notes\n");

// (1) A saved file is served from the workspace copy. PDFs are inline-safe
// (browser preview), so the default disposition is `inline`; `download=1`
// forces an attachment.
{
	const res = await call("/plugins/manus-llm/file", { url: "/plugins/manus-llm/file?sessionId=session-live&name=report.pdf" });
	assert.equal(res.statusCode, 200);
	assert.equal(res.headers["content-type"], "application/pdf");
	assert.equal(res.headers["content-disposition"].startsWith("inline;"), true);
	assert.equal(res.body.toString("utf8"), "fake pdf body");
	const forced = await call("/plugins/manus-llm/file", { url: "/plugins/manus-llm/file?sessionId=session-live&name=report.pdf&download=1" });
	assert.equal(forced.headers["content-disposition"].startsWith("attachment;"), true);
	console.log("FILE: ok - doc served (inline by default, download=1 forces attachment)");
}
// (2) Images render inline.
{
	const res = await call("/plugins/manus-llm/file", { url: "/plugins/manus-llm/file?sessionId=session-live&name=pic.png" });
	assert.equal(res.statusCode, 200);
	assert.equal(res.headers["content-type"], "image/png");
	assert.equal(res.headers["content-disposition"].startsWith("inline;"), true);
	console.log("FILE: ok - image served inline");
}
// (3) Markdown is inline-safe too; download=1 forces attachment.
{
	const inline = await call("/plugins/manus-llm/file", { url: "/plugins/manus-llm/file?sessionId=session-live&name=notes.md" });
	assert.equal(inline.statusCode, 200);
	assert.equal(inline.headers["content-type"], "text/markdown; charset=utf-8");
	const forced = await call("/plugins/manus-llm/file", { url: "/plugins/manus-llm/file?sessionId=session-live&name=notes.md&download=1" });
	assert.equal(forced.headers["content-disposition"].startsWith("attachment;"), true);
	console.log("FILE: ok - inline/download switch honoured");
}
// (4) The session store fallback resolves a workspace too.
{
	const res = await call("/plugins/manus-llm/file", { url: "/plugins/manus-llm/file?sessionId=session-store&name=report.pdf" });
	assert.equal(res.statusCode, 200);
	console.log("FILE: ok - session-store fallback resolves the workspace");
}
// (5) Traversal and unsanitized names are rejected before touching the disk.
for (const bad of ["../secret.txt", "..\\secret.txt", "a/b.txt", "", "report.pdf "]) {
	const res = await call("/plugins/manus-llm/file", {
		url: `/plugins/manus-llm/file?${new URLSearchParams({ sessionId: "session-live", name: bad }).toString()}`
	});
	assert.equal(res.statusCode, 400, `must reject name ${JSON.stringify(bad)}`);
}
console.log("FILE: ok - traversal / unsanitized names rejected");
// (6) Unknown workspace and unknown file are 404s.
{
	const res = await call("/plugins/manus-llm/file", { url: "/plugins/manus-llm/file?sessionId=nope&name=report.pdf" });
	assert.equal(res.statusCode, 404);
	const res2 = await call("/plugins/manus-llm/file", { url: "/plugins/manus-llm/file?sessionId=session-live&name=missing.bin" });
	assert.equal(res2.statusCode, 404);
	console.log("FILE: ok - unresolved workspace / missing file are 404");
}
// (7) Method and origin gates.
{
	const res = await call("/plugins/manus-llm/file", { method: "POST", url: "/plugins/manus-llm/file?name=report.pdf" });
	assert.equal(res.statusCode, 405);
	const res2 = await call("/plugins/manus-llm/file", {
		url: "/plugins/manus-llm/file?sessionId=session-live&name=report.pdf",
		headers: { origin: "https://evil.example.com" }
	});
	assert.equal(res2.statusCode, 403);
	console.log("FILE: ok - method + origin gates enforced");
}
// (8) HEAD returns headers without a body.
{
	const res = await call("/plugins/manus-llm/file", { method: "HEAD", url: "/plugins/manus-llm/file?sessionId=session-live&name=report.pdf" });
	assert.equal(res.statusCode, 200);
	assert.equal(res.body, undefined);
	console.log("FILE: ok - HEAD omits the body");
}
// (9) The served document can never execute in the GUI origin.
{
	const res = await call("/plugins/manus-llm/file", { url: "/plugins/manus-llm/file?sessionId=session-live&name=notes.md" });
	assert.equal(res.headers["content-security-policy"], "sandbox; default-src 'none'");
	assert.equal(res.headers["x-content-type-options"], "nosniff");
	console.log("FILE: ok - CSP sandbox + nosniff");
}

// ---- workspace bridge (via the adapter the plugin constructed) -------------
assert.equal(typeof adapterInstance.persistAttachments, "function", "adapter must expose persistAttachments");

// A tiny local CDN stands in for Manus's signed URLs, so this exercises the
// REAL bridge (download → save into workspace → attachments.saveImages →
// image block) end to end rather than only its individual pieces.
const cdnBodies = new Map([
	["/cdn/shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
	["/cdn/doc.pdf", Buffer.from("%PDF-1.4 fake\n")]
]);
const cdn = http.createServer((req, res) => {
	const body = cdnBodies.get(req.url);
	if (body === undefined) {
		res.statusCode = 404;
		res.end("nope");
		return;
	}
	res.setHeader("content-type", "application/octet-stream");
	res.setHeader("content-length", String(body.length));
	res.end(body);
});
await new Promise((resolve) => cdn.listen(0, "127.0.0.1", resolve));
const cdnPort = cdn.address().port;

const turn = { dir: undefined, dirResolved: false, savedFiles: [], displayUrls: new Map() };
const imageBlocks = await adapterInstance.persistAttachments({
	sessionId: "session-live",
	attachments: [
		{
			type: "file",
			filename: "shot.png",
			content_type: "image/png",
			path: "/home/ubuntu/shot.png",
			url: `http://127.0.0.1:${cdnPort}/cdn/shot.png`
		},
		{
			type: "file",
			filename: "doc.pdf",
			content_type: "application/pdf",
			path: "/home/ubuntu/doc.pdf",
			url: `http://127.0.0.1:${cdnPort}/cdn/doc.pdf`
		}
	],
	signal: undefined,
	config: {
		downloadAttachments: true,
		downloadDirName: "manus-files",
		requestTimeoutMs: 5000
	},
	turn
});
assert.equal(imageBlocks.length, 1, "the image attachment must become one durable image block");
assert.equal(imageBlocks[0].type, "image");
assert.equal(imageBlocks[0].attachment.attachmentId.startsWith("sha256:"), true);
assert.equal(turn.savedFiles.length, 2, "both attachments must be written to the workspace");
assert.equal(savedImages.length, 1, "the real attachments service must have stored the image");
// The downloaded bytes must be on disk under the resolved workspace.
const { stat } = await import("node:fs/promises");
assert.equal((await stat(path.join(workspace, "manus-files", "shot.png"))).size > 0, true);
assert.equal((await stat(path.join(workspace, "manus-files", "doc.pdf"))).size > 0, true);
// The non-image attachment's display URL must be the plugin's own file route.
const docOverride = turn.displayUrls.get("/home/ubuntu/doc.pdf");
assert.equal(typeof docOverride?.url, "string");
assert.equal(docOverride.url.startsWith("/plugins/manus-llm/file?"), true);
// ...and that override must actually serve the downloaded copy.
const docRes = await call("/plugins/manus-llm/file", { url: docOverride.url });
assert.equal(docRes.statusCode, 200);
assert.equal(docRes.body.toString("utf8"), "%PDF-1.4 fake\n");
// The image node is dropped from text (the block carries it instead).
assert.equal(turn.displayUrls.get("/home/ubuntu/shot.png").dropNode, true);
console.log("BRIDGE: ok - real bridge downloaded, saved, registered and routed end to end");

cdn.close();

// fileUrl() shape must match the route the plugin registered.
const fileUrl = `/plugins/manus-llm/file?${new URLSearchParams({ sessionId: "session-live", name: "report.pdf" }).toString()}`;
const served = await call("/plugins/manus-llm/file", { url: fileUrl });
assert.equal(served.statusCode, 200, "the bridge's own URL shape must resolve");
console.log("BRIDGE: ok - fileUrl shape resolves against the real route");

await rm(workspace, { recursive: true, force: true });
console.log("HOST_DONE");
