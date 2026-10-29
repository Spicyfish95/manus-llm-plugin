// Offline smoke test for the browser half: runs the module factory with stubbed
// react / react-dom and asserts the registrations the Host must see.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");

function noop() {}
const react = {
	useState: (initial) => [typeof initial === "function" ? initial() : initial, noop],
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
walk(settingsNode, () => {
	count += 1;
});
console.log("settings nodes:", count);
if (count < 20) throw new Error("settings page rendered suspiciously few nodes");

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
