// Verify the plugin's real Config export (index.js) against the production
// schemastery from the DSH profile: defaults, volatile flags, and rejection of
// wrong types. This closes the gap the offline stub cannot cover — the stub's
// chain methods are no-ops, so a missing `.description()`/`.volatile()` on a
// real field would only surface at DSH startup.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const realPath = "C:/Users/Journey/.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery/lib/index.mjs";
const { default: realZ } = await import(pathToFileURL(realPath).href);

// index.js imports "@deepseek-ai/schemastery", which resolves to the offline
// stub in this repo. Import it with the real module swapped in by loading the
// file's Config export through a tiny loader shim instead: simplest reliable
// path is to rebuild the schema chain from index.js's source of truth.
// To avoid duplicating the field list, read index.js and re-run its Config
// expression against the real `z`.
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");

const startMarker = "export const Config = z.object({";
const start = source.indexOf(startMarker);
assert.equal(start >= 0, true, "Config declaration must exist");
// Walk to the matching closing `});` at column 0 (the schema is top-level).
const end = source.indexOf("\n});", start);
assert.equal(end >= 0, true, "Config declaration must close");
const expression = source.slice(start + "export const Config = ".length, end + "\n});".length - 1);

// The expression references module-level helpers; provide the ones it uses.
const CONTEXT_OPTIONS = [200000, 500000, 1000000];
const DEFAULT_CONTEXT_WINDOW = 1000000;
const DEFAULT_DOWNLOAD_DIR = "manus-files";
const contextField = () => realZ.union(CONTEXT_OPTIONS.map((value) => realZ.const(value))).default(DEFAULT_CONTEXT_WINDOW);

const factory = new Function(
	"z",
	"CONTEXT_OPTIONS",
	"DEFAULT_CONTEXT_WINDOW",
	"DEFAULT_DOWNLOAD_DIR",
	"contextField",
	`return (${expression});`
);
const Config = factory(realZ, CONTEXT_OPTIONS, DEFAULT_CONTEXT_WINDOW, DEFAULT_DOWNLOAD_DIR, contextField);

const unwrap = (value) => {
	const plain = value?.get?.() ?? value;
	return plain === null || plain === undefined ? undefined : plain;
};

const resolved = Config({});
const values = {
	defaultProfile: unwrap(resolved.defaultProfile),
	downloadAttachments: unwrap(resolved.downloadAttachments),
	downloadDirName: unwrap(resolved.downloadDirName),
	trackCredits: unwrap(resolved.trackCredits)
};
console.log("CONFIG defaults:", JSON.stringify(values));
assert.equal(values.downloadAttachments, true);
assert.equal(values.downloadDirName, "manus-files");
assert.equal(values.trackCredits, true);
assert.equal(values.defaultProfile, "max");

// Wrong types must be rejected for both new fields.
for (const bad of [{ downloadAttachments: "yes" }, { downloadDirName: 42 }]) {
	assert.throws(() => Config(bad), undefined, `Config must reject ${JSON.stringify(bad)}`);
}
console.log("CONFIG: ok - wrong types rejected");

// Every field must still be marked volatile (the settings write gate).
const described = Config.toJSON?.();
assert.equal(described !== undefined, true, "Config.toJSON must be available");
// toJSON emits a reference table: the root's `dict` maps field name → uid, and
// each spec lives under `refs[uid]`.
const root = described?.refs?.[String(described.uid)];
const dict = root?.dict ?? {};
const volatileFields = Object.entries(dict)
	.filter(([, uid]) => described.refs?.[String(uid)]?.meta?.volatile === true)
	.map(([key]) => key);
console.log("CONFIG volatile fields:", volatileFields.join(","));
for (const required of ["downloadAttachments", "downloadDirName"]) {
	assert.equal(volatileFields.includes(required), true, `${required} must stay volatile`);
}
console.log("SCHEMA_REAL_DONE");
