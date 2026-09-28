// Console capture must not trip anti-DevTools checks (issue #9) and must only touch Pi's tabs.
// Sites detect DevTools by logging an object whose getter/toString fires when something inspects
// it. Closed DevTools never does; our capture used to serialize every argument immediately.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const workerSource = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/browser-extension/service_worker.js", import.meta.url), "utf8");
const snapshotSource = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/browser-extension/snapshot_injected.js", import.meta.url), "utf8");

function loadWorker() {
  const navListeners = [];
  const injected = [];
  const noop = { addListener() {}, removeListener() {} };
  const chrome = {
    runtime: { id: "test", getManifest: () => ({ version: "0.0.0" }), onInstalled: noop, onStartup: noop },
    alarms: { create() {}, onAlarm: noop }, action: { onClicked: noop },
    webNavigation: { onCommitted: { addListener: (fn) => navListeners.push(fn) } },
    debugger: { onDetach: noop, onEvent: noop },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    scripting: { executeScript: async (options) => { injected.push(options); return []; } },
    tabs: { get: async () => null, create: async () => { throw new Error("not mocked"); } },
    tabGroups: { query: async () => [] },
  };
  const w = { chrome, console, setTimeout, clearTimeout, setInterval: () => 0, navigator: { userAgent: "unit-test" }, fetch: async () => { throw new Error("offline"); } };
  w.self = w;
  vm.runInNewContext(workerSource, w);
  const commit = async (tabId, frameId = 0) => {
    for (const fn of navListeners) await fn({ tabId, frameId, url: "https://site.test/" });
  };
  return { w, injected, commit };
}

// A page world whose console records native calls and a DevTools trap object.
function pageWorld() {
  const nativeCalls = [];
  const trap = { tripped: 0 };
  const page = vm.createContext({
    console: Object.fromEntries(["debug", "log", "info", "warn", "error"].map((l) => [l, (...a) => nativeCalls.push([l, ...a])])),
    location: { href: "https://site.test/" },
    addEventListener() {},
    fetch: undefined, XMLHttpRequest: undefined,
  });
  page.window = page;
  page.trip = () => { trap.tripped++; };
  vm.runInContext(`
    var bait = { name: "bait" };
    Object.defineProperty(bait, "id", { enumerable: true, get() { trip(); return "x"; } });
    bait.toString = function toString() { trip(); return "bait"; };
    var trapError = new Error("trap");
    Object.defineProperty(trapError, "message", { get() { trip(); return "m"; } });
    var trapRegex = /a+/g;
    trapRegex.toString = function () { trip(); return "re"; };
    Object.defineProperty(trapRegex, "source", { get() { trip(); return "x"; } });
    var trapDate = new Date(0);
    trapDate.toString = function () { trip(); return "d"; };
  `, page);
  return { page, trap, nativeCalls };
}

const fnSource = (name) => {
  const start = workerSource.indexOf(`function ${name}(`);
  let depth = 0;
  for (let i = workerSource.indexOf("{", start); i < workerSource.length; i++) {
    if (workerSource[i] === "{") depth++;
    else if (workerSource[i] === "}" && --depth === 0) return workerSource.slice(start, i + 1);
  }
  throw new Error(`missing ${name}`);
};

for (const [label, install] of [
  ["early capture", (page) => vm.runInContext(`(${fnSource("installEarlyCapture")})()`, page)],
  ["post-hoc instrumentation", (page) => vm.runInContext(`${fnSource("getPiChromeState")}\n(${fnSource("installPiChromeInstrumentation")})()`, page)],
  ["snapshot_injected instrumentation", (page) => { vm.runInContext(snapshotSource, page); }],
]) {
  test(`${label}: logging an object does not read it until Pi lists messages`, () => {
    const { page, trap, nativeCalls } = pageWorld();
    install(page);
    if (label.startsWith("snapshot")) {
      // snapshot_injected installs lazily through its snapshot entry point; force the install.
      assert.equal(typeof page.__piChromeSnapshotPage, "function");
      try { page.__piChromeSnapshotPage({}); } catch {}
    }
    vm.runInContext("console.log('hello', bait); console.error(new Error('boom')); console.log(trapError, trapRegex, trapDate)", page);
    assert.equal(trap.tripped, 0, "no getter/toString fired while the page runs");
    assert.equal(nativeCalls.length, 3, "native console still receives the calls");
    const listed = vm.runInContext(`${fnSource("getPiChromeState")}\n${fnSource("installPiChromeInstrumentation")}\n(${fnSource("listConsoleMessages")})(false)`, page);
    assert.equal(trap.tripped, 0, "listing does not fire page getters or toString either");
    assert.equal(listed.count, 3);
    assert.equal(listed.messages[0].args[0], "hello");
    assert.deepEqual(JSON.parse(JSON.stringify(listed.messages[0].args[1])), { name: "bait", id: "[getter]", toString: "[function toString]" });
    assert.equal(listed.messages[1].args[0].message, "boom");
    assert.match(listed.messages[1].args[0].stack, /boom/);
    const [err, re, date] = listed.messages[2].args;
    assert.equal(err.message, "[getter]");
    assert.equal(re, "/a+/g", "regex described through native getters");
    assert.equal(date, "1970-01-01T00:00:00.000Z");
  });
}

test("listing survives values that cannot be serialized", () => {
  const { page } = pageWorld();
  vm.runInContext(`(${fnSource("installEarlyCapture")})()`, page);
  vm.runInContext("const loop = { a: [1, 2n, undefined, Symbol('s')] }; loop.self = loop; console.log(loop); console.log(new Proxy({}, { ownKeys() { throw new Error('no'); } }), new Map([[1, 2]]), function named() {})", page);
  const listed = vm.runInContext(`${fnSource("getPiChromeState")}\n${fnSource("installPiChromeInstrumentation")}\n(${fnSource("listConsoleMessages")})(true)`, page);
  assert.equal(listed.count, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(listed.messages[0].args[0])), { a: [1, "2n", "undefined", "Symbol(s)"], self: "[circular]" });
  assert.deepEqual(JSON.parse(JSON.stringify(listed.messages[1].args)), ["[unserializable]", "[Map(1)]", "[function named]"]);
  assert.equal(vm.runInContext("window.__PI_CHROME_STATE__.console.length", page), 0, "clear still empties the buffer");
});

test("early capture is injected only into tabs Pi owns or tracks", async () => {
  const h = loadWorker();
  await h.commit(10);
  assert.equal(h.injected.length, 0, "a user tab is never patched");
  vm.runInContext("automationTargets.set('s', { tabId: 11 }); sessionTabs.set('s', new Map([[12, { created: true }]]));", h.w);
  await h.commit(11);
  await h.commit(12);
  await h.commit(11, 3); // subframe
  assert.deepEqual(h.injected.map((o) => o.target.tabId), [11, 12]);
  assert.ok(h.injected.every((o) => o.func.name === "installEarlyCapture" && o.injectImmediately === true));
});

test("a Pi tab whose first page commits before tab.new tracks it still gets early capture", async () => {
  const h = loadWorker();
  let commit;
  h.w.chrome.tabs.create = async (props) => {
    // Chrome can commit the first document while tab.new is still recording ownership.
    commit = h.commit(21);
    return { id: 21, windowId: 1, url: props.url, status: "loading" };
  };
  h.w.groupTab = async (tab) => ({ tab: { id: tab.id }, group: { title: "Pi" } });
  h.w.waitForTabSettled = async () => true;
  h.w.formatTab = async (tab) => tab;
  await h.w.dispatch("tab.new", { url: "https://site.test/", background: true, sessionKey: "s" });
  await commit;
  assert.deepEqual(h.injected.map((o) => o.target.tabId), [21]);
  await h.commit(22);
  assert.deepEqual(h.injected.map((o) => o.target.tabId), [21], "unrelated tabs stay untouched");
});
