// Offline smoke test for the browser half: runs the module factory with stubbed
// react / react-dom and asserts the registrations the Host must see.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");

function noop() {}
// A "loaded" config snapshot, so the settings page can be rendered past its
// loading guard: the real component fills this in from the config route, which
// never resolves inside the sandbox.
const readyConfig = {
	status: "ready",
	revision: 3,
	values: { defaultProfile: "max", locale: "zh-CN", creditPosition: "composer", pollIntervalMs: 2000, apiKeyLabel: "ManusApikey01" },
	credential: { configured: true, source: "store" },
	models: [
		{ id: "standard", name: "Manus Standard", description: "balanced" },
		{ id: "lite", name: "Manus Lite", description: "fast" },
		{ id: "max", name: "Manus Max", description: "deep" }
	],
	error: undefined
};
// Boolean component state (busy / editingLabel / confirmDelete) starts closed
// on the first render and is forced open on the second, so both the default
// table view and the rename-edit + delete-confirm surfaces get rendered.
let openStates = false;
const react = {
	useState: (initial) => {
		const value = typeof initial === "function" ? initial() : initial;
		if (value !== null && typeof value === "object" && value.status === "loading" && "values" in value) {
			return [readyConfig, noop];
		}
		if (value === false) return [openStates, noop];
		return [value, noop];
	},
	useRef: (initial) => ({ current: initial }),
	useCallback: (fn) => fn,
	useEffect: noop,
	useLayoutEffect: noop,
	createElement: (type, props, ...children) => ({ type, props, children })
};
const jsxRuntime = {
	jsx: (type, props) => ({ type, props }),
	jsxs: (type, props) => ({ type, props }),
	Fragment: "Fragment"
};

let registered;
const registrations = [];
const effects = [];
const ctx = {
	effect: (fn) => {
		effects.push(fn);
		return noop;
	},
	locale: {
		register: () => noop,
		bind: () => (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)
	},
	slots: {
		inject: (slotName, callback) => {
			registered = slotName;
			callback();
			return noop;
		},
		register: (options, component) => {
			registrations.push({ slot: registered, options, component });
			return noop;
		}
	}
};

const sandbox = {
	window: {
		__ModuleLoader__: {
			load: (definition) => {
				sandbox.__module = definition;
			}
		}
	},
	console,
	document: undefined,
	URL,
	JSON,
	Number,
	String,
	Math,
	Array,
	Object,
	Promise,
	Map,
	Set,
	Date,
	Error,
	AbortController,
	setTimeout,
	clearTimeout,
	setInterval,
	clearInterval,
	ResizeObserver: undefined,
	Request: globalThis.Request,
	fetch: globalThis.fetch
};
sandbox.globalThis = sandbox;
sandbox.window.setTimeout = setTimeout;
sandbox.window.clearTimeout = clearTimeout;
sandbox.window.setInterval = setInterval;
sandbox.window.clearInterval = clearInterval;

vm.createContext(sandbox);
vm.runInContext(source, sandbox);

const definition = sandbox.__module;
if (definition === undefined) throw new Error("module did not register through __ModuleLoader__.load");
if (definition.id !== "dsh-manus-llm") throw new Error(`unexpected module id: ${definition.id}`);

const exportsObject = definition.factory((specifier) => {
	if (specifier === "react") return react;
	if (specifier === "react/jsx-runtime") return jsxRuntime;
	if (specifier === "react-dom") return { createPortal: (node) => node };
	throw new Error(`unexpected require: ${specifier}`);
});

console.log("name:", exportsObject.name);
console.log("inject:", JSON.stringify(exportsObject.inject));
exportsObject.apply(ctx);
console.log("effects:", effects.length);
for (const entry of registrations) {
	console.log(
		`slot: ${entry.slot} id=${entry.options.id} order=${entry.options.order} ` +
		`label=${typeof entry.options.label === "function" ? entry.options.label() : entry.options.label} ` +
		`component=${entry.component.name}`
	);
}
const settings = registrations.find((entry) => entry.slot === "settings.section");
if (settings === undefined) throw new Error("settings.section was not registered");
const credits = registrations.filter((entry) => entry.slot !== "settings.section");
if (credits.length !== 2) throw new Error(`expected 2 composer seats, got ${credits.length}`);

// Render both components once with the stubbed hooks to catch structural
// mistakes (unknown props, bad jsx nesting) that registration alone hides.
function walk(node, visit) {
	if (node === null || node === undefined) return;
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit);
		return;
	}
	if (typeof node !== "object") return;
	visit(node);
	for (const value of Object.values(node.props ?? {})) walk(value, visit);
	for (const child of node.children ?? []) walk(child, visit);
}

const settingsNode = settings.component({ t: (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`) });
let count = 0;
const labels = new Set();
const ordered = [];
function collectText(value) {
	if (typeof value === "string") {
		labels.add(value);
		ordered.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectText(item);
		return;
	}
	if (value === null || typeof value !== "object") return;
	const children = value.props?.children;
	if (typeof children === "string") {
		labels.add(children);
		ordered.push(children);
	} else collectText(children);
	collectText(value.children);
}
walk(settingsNode, () => {
	count += 1;
});
collectText(settingsNode);
console.log("settings nodes:", count);
// The page renders its head + tab strip immediately and fills the body once
// the config route answers, so the smoke test asserts the shell is present
// rather than a full form (fetch never resolves inside the sandbox).
if (count < 5) throw new Error("settings page rendered suspiciously few nodes");
if (!labels.has("settings.tab.models") || !labels.has("settings.tab.account")) {
	throw new Error(`settings tabs missing: ${JSON.stringify([...labels])}`);
}
// Tab order: 账号 must come before 模型 in the rendered strip.
const tabOrder = ordered.filter((label) => label === "settings.tab.account" || label === "settings.tab.models");
console.log("tab order:", tabOrder.join(" → "));
if (tabOrder[0] !== "settings.tab.account") {
	throw new Error(`expected the account tab first, got ${JSON.stringify(tabOrder)}`);
}
// The read-only credential-reference field is gone from the settings surface.
if (labels.has("settings.key.env")) throw new Error("credential-reference field must not be rendered");
// The API-key list table: three headers must render; the test button is an
// icon now, asserted via aria-label below.
for (const required of [
	"settings.key.table.name",
	"settings.key.table.status",
	"settings.key.table.actions"
]) {
	if (!labels.has(required)) throw new Error(`key-list surface missing label: ${required}`);
}
if (!labels.has("ManusApikey01")) throw new Error("default key label ManusApikey01 must render in the list");
// Icon buttons carry their labels as aria-label, not text children.
const ariaLabels = new Set();
(function collectAria(node) {
	if (node === null || node === undefined || typeof node !== "object") return;
	if (Array.isArray(node)) return node.forEach(collectAria);
	const aria = node.props?.["aria-label"];
	if (typeof aria === "string") ariaLabels.add(aria);
	for (const value of Object.values(node.props ?? {})) collectAria(value);
	for (const child of node.children ?? []) collectAria(child);
})(settingsNode);
if (!ariaLabels.has("settings.key.rename")) throw new Error("rename icon button missing aria-label");
if (!ariaLabels.has("settings.key.delete")) throw new Error("delete icon button missing aria-label");
if (!ariaLabels.has("settings.key.testIcon")) throw new Error("test-connection icon button missing aria-label");
// Second render with every boolean state flipped true: the name cell switches
// to the inline rename editor and the delete-confirm overlay opens, so the
// editor buttons and overlay copy become visible.
openStates = true;
const confirmLabels = new Set();
const confirmNode = settings.component({
	t: (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)
});
(function collectConfirm(node) {
	if (typeof node === "string") {
		confirmLabels.add(node);
		return;
	}
	if (node === null || node === undefined || typeof node !== "object") return;
	if (Array.isArray(node)) return node.forEach(collectConfirm);
	for (const value of Object.values(node.props ?? {})) collectConfirm(value);
	for (const child of node.children ?? []) collectConfirm(child);
})(confirmNode);
for (const required of [
	"settings.key.deleteConfirmTitle",
	"settings.key.deleteConfirmBody",
	"settings.key.renameSave",
	"settings.key.renameCancel",
	"settings.key.delete"
]) {
	if (!confirmLabels.has(required)) throw new Error(`rename/delete surface missing label: ${required}`);
}
const gateNode = credits[0].component({
	t: (key) => key,
	position: "composer",
	useProjection: () => ({ next: { provider: "manus", model: "max" } }),
	useSession: () => false,
	sessionId: "session-1"
});
console.log("gate renders for manus:", gateNode !== null && gateNode !== undefined);
const gateOff = credits[0].component({
	t: (key) => key,
	position: "composer",
	useProjection: () => ({ next: { provider: "openai", model: "gpt" } }),
	useSession: () => false,
	sessionId: "session-1"
});
console.log("gate hides for other providers:", gateOff === null);
if (gateOff !== null) throw new Error("gate must render nothing for a foreign provider");

console.log("CLIENT_SMOKE_DONE");
