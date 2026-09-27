// The Chrome primer must be a structured prompt section, never a forced `systemPrompt` override.
// A forced override makes pi collapse all system messages into a new leading prompt every run,
// which busts the provider prompt cache.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const source = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/index.ts", import.meta.url), "utf8");
const from = source.indexOf('pi.on("before_agent_start",');
const to = source.indexOf("// Shared handlers,", from);
assert.ok(from >= 0 && to > from, "Missing before_agent_start section");
const handlerSource = stripTypeScriptTypes(source.slice(from, to));

function load({ registered = true, authorized = true } = {}) {
	let handler;
	const pi = { on: (name, fn) => { if (name === "before_agent_start") handler = fn; } };
	vm.runInNewContext(`${handlerSource}`, {
		pi,
		chromeToolsRegistered: registered,
		chromeControlAuthorized: () => authorized,
	});
	return handler;
}

test("authorized: adds primer section and does not force systemPrompt", () => {
	const event = { systemPrompt: "base", systemPromptOptions: { sections: {} } };
	const result = load()(event);
	assert.equal(result, undefined);
	const primer = event.systemPromptOptions.sections["chrome-profile-bridge"];
	assert.match(primer, /^Chrome control is available/);
	assert.doesNotMatch(primer, /<\/?chrome-profile-bridge>/, "pi wraps sections in their tag");
});

test("locked: removes primer section and does not force systemPrompt", () => {
	const event = { systemPrompt: "base", systemPromptOptions: { sections: { "chrome-profile-bridge": "stale", other: "keep" } } };
	assert.equal(load({ authorized: false })(event), undefined);
	assert.deepEqual(event.systemPromptOptions.sections, { other: "keep" });
});

test("tools not registered: no primer", () => {
	const event = { systemPrompt: "base", systemPromptOptions: { sections: {} } };
	assert.equal(load({ registered: false })(event), undefined);
	assert.deepEqual(event.systemPromptOptions.sections, {});
});

test("legacy pi without sections: appends only when authorized", () => {
	assert.equal(load({ authorized: false })({ systemPrompt: "base" }), undefined);
	const result = load()({ systemPrompt: "base" });
	assert.match(result.systemPrompt, /^base\n<chrome-profile-bridge>\nChrome control is available[\s\S]*<\/chrome-profile-bridge>$/);
});
