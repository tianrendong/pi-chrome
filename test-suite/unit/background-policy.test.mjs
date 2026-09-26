// Runtime regressions for the Pi session policy and the real worker dispatch/input paths.
// Chrome APIs are mocked: these tests prove explicit focus calls, not OS/Spaces behavior.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const indexSource = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/index.ts", import.meta.url), "utf8");
const workerSource = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/browser-extension/service_worker.js", import.meta.url), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));
function section(start, end) {
  const from = indexSource.indexOf(start);
  const to = indexSource.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing source section: ${start}`);
  return indexSource.slice(from, to);
}

// Load the shipped policy, existing command handler, and actual tool registrations. Only the
// bridge/Pi UI/typebox/formatting/filesystem boundaries are replaced; no live server is opened.
function piHarness({ session = "alpha", send } = {}) {
  const calls = [], tools = new Map(), notices = [], writes = [];
  let authorized = true;
  const ctx = { key: `session:${session}`, title: `Pi Session: ${session}`, cwd: "/fixture", ui: { notify: (...args) => notices.push(args) } };
  const bridge = {
    connected: true, status: () => ({}), connectionStatus: async () => ({ connected: true }),
    async send(action, params, timeout, signal) {
      calls.push({ action, params: clone(params), timeout, signal });
      if (signal?.aborted) throw new Error("Chrome command aborted");
      if (send) return send(action, params, timeout, signal);
      if (action === "tab.version") return { capabilities: { hardBackground: true } };
      if (action === "tab.list") return [];
      if (action.startsWith("page.screenshot")) return { dataUrl: "data:image/png;base64,dGVzdA==", method: "cdp" };
      return {};
    },
  };
  const Type = new Proxy({}, { get: () => (value = {}) => value });
  const sandbox = {
    console, Buffer, Type,
    Date,
    DEFAULT_HOST: "127.0.0.1", DEFAULT_PORT: 17318, DEFAULT_TIMEOUT_MS: 30000, MAX_ELEMENTS: 80,
    BACKGROUND_PARAM_DESCRIPTION: "background policy",
    ChromeProfileBridge: function () { return bridge; },
    requireChromeControlAuthorized() { if (!authorized) throw new Error("Chrome control locked"); },
    sessionCtx: ctx, sessionKeyFor: (c) => c?.key, sessionGroupTitle: (c) => c.title,
    chromeToolsRegistered: false, StringEnum: () => ({}),
    tabActionValues: [], snapshotModeValues: [], waitForValues: [], imageFormatValues: [],
    safeJson: JSON.stringify, truncateText: (s) => s, formatChromeSnapshot: JSON.stringify,
    formatChromeInspect: JSON.stringify, summarizeActionResult: () => "", formatIncludedSnapshotText: (_r, text) => text,
    describeTypeEvidence: () => [], formatCdpResult: (_method, value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: { value } }),
    workspaceCwd: () => ctx.cwd, ...path,
    mkdir: async () => {}, writeFile: async (...args) => writes.push(args), pruneScreenshotDir: async () => 0,
  };
  const registrations = indexSource.slice(indexSource.indexOf("function registerChromeTools(pi:"), indexSource.lastIndexOf("\n}"));
  vm.runInNewContext(stripTypeScriptTypes([
    section("const bridge = new ChromeProfileBridge(", "\n\tlet chromeAuthorizedUntil:"),
    section("const authorizedBridgeSend =", '\n\tpi.on("session_start",'),
    section("const BACKGROUND_DESC:", "\n\tconst authorizeFor ="),
    registrations,
    "globalThis.send = authorizedBridgeSend; globalThis.background = backgroundHandler;",
  ].join("\n")), sandbox);
  sandbox.registerChromeTools({ registerTool: (tool) => tools.set(tool.name, tool) });
  return {
    calls, tools, notices, writes, ctx,
    send: async (...args) => sandbox.send(...args),
    background: (arg) => sandbox.background(ctx, arg),
    tool: (name, params = {}, signal) => tools.get(name).execute("test", params, signal, undefined, ctx),
    authorize: (value) => { authorized = value; },
  };
}

const flagCases = [
  [{}, false], [{ background: false }, false], [{ background: true }, true],
  [{ foreground: true }, false], [{ foreground: false }, true],
  [{ background: false, foreground: false }, false], [{ background: true, foreground: true }, true],
];

test("session background on overrides all per-call/legacy foreground flags; off preserves per-call background", async () => {
  const h = piHarness();
  for (const mode of ["on", "off"]) {
    await h.background(mode);
    for (const [flags, requestedBackground] of flagCases) {
      const params = Object.freeze({ ...flags, targetId: "2" });
      await h.send("page.snapshot", params);
      const wire = h.calls.at(-1).params;
      assert.equal(wire.background, mode === "on" || requestedBackground);
      assert.equal(wire.foreground, !wire.background);
      assert.equal(wire.sessionKey, "session:alpha");
      assert.equal(wire.sessionGroupTitle, "Pi Session: alpha");
      assert.equal(wire.joinSessionGroup, true);
      assert.deepEqual(params, { ...flags, targetId: "2" }, "caller params not mutated");
    }
  }
});

test("every registered page tool, tab.new, and chrome_launch(url) use the central policy", async () => {
  const h = piHarness();
  const cases = [
    ["chrome_launch", { url: "https://example.test" }, "tab.new"],
    ["chrome_tab", { action: "new", group: false, groupTitle: "other" }, "tab.new"],
    ["chrome_snapshot", {}, "page.snapshot"], ["chrome_find", { query: "button" }, "page.snapshot"],
    ["chrome_inspect", { uid: "el-1" }, "page.inspect"], ["chrome_navigate", { url: "https://example.test" }, "page.navigate"],
    ["chrome_evaluate", { expression: "1" }, "page.evaluate"], ["chrome_click", { uid: "el-1" }, "page.click"],
    ["chrome_type", { text: "abc" }, "page.type"], ["chrome_fill", { text: "abc" }, "page.fill"],
    ["chrome_key", { key: "Enter" }, "page.key"], ["chrome_wait_for", { kind: "expression", value: "true" }, "page.waitFor"],
    ["chrome_list_console_messages", {}, "page.console.list"], ["chrome_list_network_requests", {}, "page.network.list"],
    ["chrome_get_network_request", { requestId: "1" }, "page.network.get"], ["chrome_screenshot", {}, "page.screenshot"],
    ["chrome_hover", {}, "page.hover"], ["chrome_drag", {}, "page.drag"], ["chrome_tap", {}, "page.tap"],
    ["chrome_scroll", {}, "page.scroll"], ["chrome_upload_file", { paths: ["fixture.txt"] }, "page.upload"],
    ["chrome_cdp", { method: "Runtime.evaluate", params: { expression: "1" } }, "cdp.call"],
  ];
  for (const [name, params, action] of cases) {
    await h.tool(name, { ...params, background: false, foreground: true });
    const call = h.calls.at(-1);
    assert.equal(call.action, action === "tab.new" || action === "page.screenshot" ? `${action}.background` : action, name);
    assert.equal(call.params.foreground, false, name);
    assert.equal(call.params.background, true, name);
    if (action === "tab.new") assert.equal(call.params.groupTitle, "Pi Session: alpha");
  }
  assert.equal(h.writes[0][1].toString(), "test", "screenshot tool still writes decoded bytes");
});

test("typing options and verification pass through real tool registrations without bypassing authorization", async () => {
  const h = piHarness({ send: async () => ({ result: { input: "chrome", typing: "keys" }, snapshot: { url: "https://fixture.test" } }) });
  for (const name of ["chrome_type", "chrome_fill"]) {
    assert.equal(h.tools.get(name).parameters.perCharacter.default, false);
    const result = await h.tool(name, { uid: "el-1", text: "hello", perCharacter: true, includeSnapshot: true, domFallback: false });
    assert.equal(h.calls.at(-1).params.perCharacter, true);
    assert.equal(h.calls.at(-1).params.includeSnapshot, true);
    assert.equal(h.calls.at(-1).params.domFallback, false);
    assert.equal(h.calls.at(-1).params.background, true);
    assert.equal(result.details.result.result.typing, "keys");
    assert.equal(result.details.result.snapshot.url, "https://fixture.test");
  }
  h.authorize(false);
  const count = h.calls.length;
  for (const [name, params] of [["chrome_type", { text: "x" }], ["chrome_fill", { text: "x" }], ["chrome_key", { key: "a" }], ["chrome_upload_file", { paths: ["/fixture.txt"] }]]) {
    await assert.rejects(h.tool(name, params), /Chrome control locked/);
  }
  assert.equal(h.calls.length, count);
});

test("activation is rejected before dispatch; existing on/off/toggle/status commands suffice", async () => {
  const h = piHarness();
  await assert.rejects(h.tool("chrome_tab", { action: "activate", targetId: "2", background: false }), /background mode.*\/chrome background off/);
  assert.equal(h.calls.length, 0);
  await h.background("off");
  await h.tool("chrome_tab", { action: "activate", targetId: "2" });
  assert.equal(h.calls.at(-1).params.foreground, true);
  await h.background("toggle");
  await h.background("status");
  assert.match(h.notices.at(-1)[0], /on.*Hard background/);
  for (const arg of ["lock", "unlock", "invalid"]) {
    await h.background(arg);
    assert.match(h.notices.at(-1)[0], /Unknown background setting/);
    await assert.rejects(h.send("tab.activate", {}), /background mode/);
  }
  await h.background("");
  await h.send("tab.activate", {});
  for (const arg of ["true", "1", "on"]) {
    await h.background(arg);
    await assert.rejects(h.send("tab.activate", {}), /background mode/);
  }
  for (const arg of ["false", "0", "off"]) {
    await h.background(arg);
    await h.send("tab.activate", {});
  }
});

test("older companions reject background-only wire actions; launch and screenshots never retry unsafe actions", async () => {
  const h = piHarness({ send: async (action) => { throw new Error(`Unknown action: ${action}`); } });
  for (const [tool, params] of [
    ["chrome_tab", { action: "new" }], ["chrome_launch", { url: "https://example.test" }],
    ["chrome_screenshot", {}], ["chrome_screenshot", { fullPage: true }],
  ]) {
    await assert.rejects(h.tool(tool, params), /Reload Pi Chrome Connector/);
  }
  assert.deepEqual(h.calls.map((c) => c.action), ["tab.new.background", "tab.new.background", "page.screenshot.background", "page.screenshot.background"]);
});

test("transport failures propagate without fallback; single dispatch preserves authorization/timeout/signal", async () => {
  const offline = piHarness({ send: async () => { throw new Error("offline"); } });
  await assert.rejects(offline.send("tab.new", {}), /offline/);
  assert.equal(offline.calls.length, 1);
  const h = piHarness(), controller = new AbortController();
  await h.send("tab.new", {}, 900, controller.signal);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].timeout, 900);
  assert.equal(h.calls[0].signal, controller.signal);
  controller.abort();
  await assert.rejects(h.send("tab.new", {}, 900, controller.signal), /Chrome command aborted/);
  h.authorize(false);
  await assert.rejects(h.send("tab.new", {}), /Chrome control locked/);
  assert.equal(h.calls.length, 2, "locked call does not reach bridge");
});

test("shared-owner sessions retain independent policies; per-call background still works with mode off", async () => {
  const sharedCalls = [];
  const send = async (action, params) => { sharedCalls.push({ action, params }); return {}; };
  const a = piHarness({ session: "A", send }), b = piHarness({ session: "B", send });
  await b.background("off");
  await a.send("tab.new", { background: false });
  await b.send("tab.new", {});
  assert.equal(sharedCalls[0].params.sessionKey, "session:A");
  assert.equal(sharedCalls[0].params.foreground, false);
  assert.equal(sharedCalls[0].action, "tab.new.background");
  assert.equal(sharedCalls[1].params.sessionKey, "session:B");
  assert.equal(sharedCalls[1].params.foreground, true);
  assert.equal(sharedCalls[1].action, "tab.new");
  await b.send("tab.new", { background: true });
  assert.equal(sharedCalls[2].action, "tab.new.background");
  assert.equal(sharedCalls[2].params.foreground, false);
});

function workerHarness({ withWindows = true } = {}) {
  const calls = [];
  const tabs = new Map([
    [1, { id: 1, windowId: 1, active: true, groupId: -1, url: "https://user.test/", title: "User" }],
    [2, { id: 2, windowId: 1, active: false, groupId: -1, url: "https://target.test/", title: "Target" }],
  ]);
  let focusedWindow = 1, nextTab = 3, nextWindow = 2;
  const storage = {}, groups = new Map();
  const listener = { addListener() {}, removeListener() {} };
  const chrome = {
    runtime: { id: "test", getManifest: () => ({ version: "0.0.0" }), onInstalled: listener, onStartup: listener },
    alarms: { onAlarm: listener, create() {} }, action: { onClicked: listener }, webNavigation: { onCommitted: listener },
    storage: { session: { get: async (key) => ({ [key]: storage[key] }), set: async (value) => Object.assign(storage, value) } },
    tabs: {
      onUpdated: listener,
      query: async (query = {}) => [...tabs.values()].filter((t) => (!query.active || t.active) && (query.windowId === undefined || query.windowId === t.windowId)).map(clone),
      get: async (id) => { if (!tabs.has(id)) throw new Error("No tab"); return clone(tabs.get(id)); },
      create: async (params) => {
        calls.push({ action: "tabs.create", params });
        const tab = { id: nextTab++, windowId: params.windowId ?? 1, active: params.active, url: params.url, groupId: -1 };
        if (tab.active) for (const t of tabs.values()) if (t.windowId === tab.windowId) t.active = false;
        tabs.set(tab.id, tab);
        return clone(tab);
      },
      update: async (id, params) => {
        calls.push({ action: "tabs.update", id, params });
        const tab = tabs.get(id);
        if (params.active) for (const t of tabs.values()) if (t.windowId === tab.windowId) t.active = false;
        Object.assign(tab, params);
        return clone(tab);
      },
      remove: async (id) => tabs.delete(id),
      group: async ({ groupId, tabIds }) => {
        const id = groupId ?? groups.size + 1;
        if (!groups.has(id)) groups.set(id, { id, windowId: tabs.get(tabIds[0]).windowId });
        for (const tid of tabIds) tabs.get(tid).groupId = id;
        return id;
      },
      ungroup: async (id) => { tabs.get(id).groupId = -1; },
      captureVisibleTab: async () => { calls.push({ action: "captureVisibleTab" }); throw new Error("activation-based capture forbidden"); },
    },
    tabGroups: {
      query: async ({ windowId } = {}) => [...groups.values()].filter((g) => windowId === undefined || g.windowId === windowId).map(clone),
      get: async (id) => groups.get(id),
      update: async (id, props) => Object.assign(groups.get(id), props),
    },
    windows: {
      update: async (id, params) => { calls.push({ action: "windows.update", id, params }); if (params.focused) focusedWindow = id; },
    },
    debugger: {
      onDetach: listener, getTargets: (cb) => cb([]), attach: async () => {}, detach: async () => {},
      sendCommand: (target, method, params, callback) => {
        calls.push({ action: "cdp", target, method, params });
        try { callback(h.cdpResult(method, params)); }
        catch (error) { chrome.runtime.lastError = { message: error.message }; callback(); chrome.runtime.lastError = undefined; }
      },
    },
    scripting: { executeScript: async () => [{ result: { ok: true, value: { elements: [], url: "https://target.test/" } } }] },
  };
  if (withWindows) chrome.windows.create = async (params) => {
    calls.push({ action: "windows.create", params });
    const id = nextWindow++;
    if (params.focused) focusedWindow = id;
    const tab = { id: nextTab++, windowId: id, active: true, url: params.url, groupId: -1 };
    tabs.set(tab.id, tab);
    return { id, tabs: [clone(tab)] };
  };
  const w = {
    chrome, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    fetch: async () => { throw new Error("no network in unit tests"); }, navigator: { userAgent: "unit-test" },
  };
  w.self = w;
  vm.runInNewContext(workerSource, w);
  w.sleep = async () => {}; // Skip human timing, not CDP dispatch.
  w.resolveTargetInTab = async () => ({ found: true, x: 40, y: 50, tag: "BUTTON" });
  const h = {
    w, chrome, calls, tabs, focusedWindow: () => focusedWindow,
    cdpResult: (method) => method === "Page.captureScreenshot" ? { data: "c2NyZWVuc2hvdA==" }
      : method === "DOM.requestNode" ? { nodeId: 1 }
      : method === "Runtime.callFunctionOn" ? { result: { type: "object", value: { tag: "INPUT", isFile: true } } }
      : { result: { type: "boolean", value: true, objectId: "file-input" } },
  };
  return h;
}
function assertNoFocus(h) {
  assert.equal(h.focusedWindow(), 1);
  assert.equal(h.tabs.get(1).active, true);
  assert.ok(!h.calls.some((c) => c.action === "windows.update" || c.action === "captureVisibleTab" || (c.action === "tabs.update" && c.params.active) || (c.action === "tabs.create" && c.params.active)));
}

test("Pi-to-worker background aliases preserve grouping, screenshot output, and ownership-aware cleanup", async () => {
  const h = workerHarness();
  const pi = piHarness({ send: (action, params) => h.w.dispatch(action, params) });
  const opened = await pi.tool("chrome_tab", { action: "new", group: false, groupTitle: "wrong", background: false });
  assert.equal(opened.details.result.group.title, "Pi Session: alpha");
  const launched = await pi.tool("chrome_launch", { url: "https://fixture.test" });
  const shot = await pi.tool("chrome_screenshot", { targetId: "2", background: false });
  assert.equal(shot.details.method, "cdp");
  assert.equal(pi.writes[0][1].toString(), "screenshot");
  assertNoFocus(h);
  await h.w.dispatch("automation.cleanup", { sessionKey: "session:alpha" });
  assert.ok(!h.tabs.has(opened.details.result.tab.id));
  assert.ok(!h.tabs.has(launched.details.result.tab.id));
  assert.ok(h.tabs.has(1) && h.tabs.has(2), "user/adopted tabs survive cleanup");
  assert.equal(h.tabs.get(2).groupId, -1, "adopted tab is safely ungrouped");
});

test("worker advertises support, keeps new tabs inactive, and rejects activation before target resolution", async () => {
  const h = workerHarness();
  assert.equal((await h.w.dispatch("tab.version", {})).capabilities.hardBackground, true);
  for (const flags of [{}, { foreground: false }, { background: true, foreground: true }]) {
    const result = await h.w.dispatch("tab.new", { ...flags, sessionKey: "alpha", groupTitle: "Pi Session: alpha" });
    assert.equal(result.tab.active, false);
    await assert.rejects(h.w.dispatch("tab.activate", { ...flags, targetId: "missing" }), /background mode/);
  }
  assertNoFocus(h);
  const active = await h.w.dispatch("tab.activate", { targetId: "2", foreground: true, background: false });
  assert.equal(active.id, 2);
  assert.equal(active.active, true);
  const opened = await h.w.dispatch("tab.new", { foreground: true });
  assert.equal(opened.tab.active, true);
});

test("background-only worker aliases force safe behavior even with foreground flags", async () => {
  const h = workerHarness();
  const opened = await h.w.dispatch("tab.new.background", { foreground: true, background: false });
  assert.equal(opened.tab.active, false);
  const shot = await h.w.dispatch("page.screenshot.background", { targetId: "2", foreground: true, background: false });
  assert.equal(shot.method, "cdp");
  assertNoFocus(h);
});

test("implicit automation windows stay unfocused; tab fallback stays inactive", async () => {
  for (const withWindows of [true, false]) {
    const h = workerHarness({ withWindows });
    const tab = await h.w.dispatch("page.navigate", { url: "https://fixture.test", waitUntilLoad: false, background: true, foreground: true, sessionKey: "alpha" });
    assert.notEqual(tab.id, 1);
    assertNoFocus(h);
    assert.ok(h.calls.filter((c) => c.action === "windows.create").every((c) => c.params.focused === false));
  }
});

test("all worker page/input paths veto conflicting foreground flags without replacing trusted input", async () => {
  const h = workerHarness();
  const actions = [
    ["navigate", { url: "https://target.test/", waitUntilLoad: false }], ["snapshot", {}], ["inspect", { uid: "el-1" }],
    ["evaluate", { expression: "true" }], ["waitFor", { kind: "expression", value: "true" }],
    ["console.list", {}], ["network.list", {}], ["network.get", { requestId: "1" }],
    ["click", { x: 40, y: 50, includeSnapshot: true }], ["fill", { selector: "input", text: "a", submit: true }],
    ["type", { selector: "input", text: "a", pressEnter: true }], ["key", { key: "Enter" }], ["hover", { x: 40, y: 50 }],
    ["drag", { fromX: 40, fromY: 50, toX: 80, toY: 90 }], ["tap", { x: 40, y: 50 }],
    ["scroll", { deltaY: 10 }], ["upload", { selector: "input", paths: ["/fixture.txt"] }],
  ];
  for (const [action, params] of actions) {
    const result = await h.w.dispatch(`page.${action}`, { targetId: "2", ...params, background: true, foreground: true, domFallback: false });
    if (["click", "fill", "type", "key", "hover", "drag", "tap", "scroll"].includes(action)) assert.equal((result.result ?? result).input, "chrome", action);
    assertNoFocus(h);
  }
  const methods = new Set(h.calls.filter((c) => c.action === "cdp").map((c) => c.method));
  for (const method of ["Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.dispatchTouchEvent", "DOM.setFileInputFiles"]) assert.ok(methods.has(method), method);
  h.chrome.debugger = undefined;
  for (const action of ["click", "fill"]) {
    await assert.rejects(h.w.dispatch(`page.${action}`, { targetId: "2", selector: "input", text: "a", background: true, domFallback: false }), /chrome.debugger API unavailable/);
  }
  assertNoFocus(h);
});

test("CDP PNG/JPEG screenshots preserve active tabs and pass viewport/quality options", async () => {
  for (const targetId of ["1", "2"]) {
    for (const options of [{}, { format: "png", quality: 70 }, { format: "jpeg", quality: 0 }, { format: "jpeg", quality: 83 }]) {
      const h = workerHarness();
      const result = await h.w.dispatch("page.screenshot", { targetId, background: true, foreground: true, ...options });
      const capture = h.calls.find((c) => c.method === "Page.captureScreenshot");
      const format = options.format ?? "png";
      assert.equal(result.dataUrl, `data:image/${format};base64,c2NyZWVuc2hvdA==`);
      assert.equal(result.method, "cdp");
      assert.equal(result.tab.id, Number(targetId));
      assert.equal(capture.target.tabId, Number(targetId));
      assert.deepEqual(clone(capture.params), { format, fromSurface: true, captureBeyondViewport: false, ...(format === "jpeg" ? { quality: options.quality } : {}) });
      assertNoFocus(h);
    }
  }
});

test("screenshot failures never fall back to activation/visible-tab capture", async () => {
  for (const failure of ["attach", "capture", "empty", "missing"]) {
    const h = workerHarness();
    if (failure === "attach") h.chrome.debugger.attach = async () => { throw new Error("permission denied"); };
    else h.cdpResult = () => {
      if (failure === "capture") throw new Error("capture failed");
      return failure === "empty" ? { data: "" } : undefined;
    };
    await assert.rejects(h.w.dispatch("page.screenshot", { targetId: "2", background: true }), /no tab-activation fallback/);
    assertNoFocus(h);
  }
});

test("screenshot does not restore/override a user tab switch during capture; watch mode explicitly activates", async () => {
  const h = workerHarness();
  h.cdpResult = () => {
    h.tabs.get(1).active = false;
    h.tabs.get(2).active = true; // Human selection while CDP is pending.
    return { data: "dGVzdA==" };
  };
  const result = await h.w.dispatch("page.screenshot", { targetId: "1", background: true });
  assert.equal(result.tab.id, 1);
  assert.equal(h.tabs.get(2).active, true);
  assert.ok(!h.calls.some((c) => c.action === "tabs.update" || c.action === "windows.update"));

  const watch = workerHarness();
  const shot = await watch.w.dispatch("page.screenshot", { targetId: "2", foreground: true, background: false });
  assert.equal(shot.tab.active, true);
  assert.equal(watch.calls.filter((c) => c.action === "tabs.update" && c.params.active).length, 1);
  assert.equal(watch.calls.filter((c) => c.action === "windows.update").length, 1);
  assert.ok(!watch.calls.some((c) => c.action === "captureVisibleTab"));
});

test("challenge 43 grader rejects activation/synthetic input and retains sticky failures", () => {
  const lib = fs.readFileSync(new URL("../_lib.js", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../challenges/43-hard-background.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  function page() {
    const listeners = new Map();
    const add = (name, fn) => listeners.set(name, fn);
    const document = {
      hidden: true, get visibilityState() { return this.hidden ? "hidden" : "visible"; }, hasFocus: () => false,
      body: { insertBefore() {} }, createElement: () => ({ style: {} }),
      getElementById: (id) => id === "verify" ? { addEventListener: add } : null,
      addEventListener: add,
    };
    const p = { document, addEventListener: add, location: { search: "" }, URLSearchParams,
      performance: { now: () => 1 }, localStorage: { setItem() {} } };
    p.window = p;
    vm.runInNewContext(`${lib}\n${script}`, p);
    return { p, document, fire: (name, event = {}) => listeners.get(name)(event) };
  }
  const visible = page();
  visible.document.hidden = false;
  assert.throws(() => visible.p.armBackgroundProbe(), /Select another tab/);
  const good = page();
  good.p.armBackgroundProbe();
  assert.throws(() => good.p.armBackgroundProbe(), /Already armed/);
  good.fire("click", { isTrusted: true });
  assert.equal(good.p.__verdict, "PASS");
  good.document.hidden = false;
  good.fire("visibilitychange");
  assert.equal(good.p.__verdict, "FAIL", "late activation must invalidate an earlier pass");
  const synthetic = page();
  synthetic.p.armBackgroundProbe();
  synthetic.fire("click", { isTrusted: false });
  synthetic.fire("click", { isTrusted: true });
  assert.equal(synthetic.p.__verdict, "FAIL", "trusted retry cannot hide synthetic input");
});

test("full-page tiles remain CDP-only, pin the resolved target, and restore both scroll axes after success/failure", async () => {
  for (const fail of [false, true]) {
    const h = workerHarness(), scrolls = [];
    h.w.executeInTab = async (params, fn, args) => {
      assert.equal(params.targetId, 2);
      assert.equal(params.foreground, false);
      if (fn.name === "captureFullPageTiles") return { width: 800, height: 1200, viewportHeight: 600, dpr: 2, originalScrollY: 73, originalScrollX: 31, tiles: [{ y: 0, scrollY: 0 }, { y: 600, scrollY: 600 }] };
      scrolls.push(clone(args));
    };
    let captures = 0;
    h.cdpResult = () => { if (++captures === 2 && fail) throw new Error("tile failed"); return { data: "dGlsZQ==" }; };
    const shot = h.w.dispatch("page.screenshot", { urlIncludes: "target.test", fullPage: true, background: true, foreground: true });
    if (fail) await assert.rejects(shot, /tile failed/);
    else {
      const result = await shot;
      assert.equal(result.method, "cdp");
      assert.equal(result.tiles.length, 2);
      assert.equal(result.dimensions.dpr, 2);
    }
    assert.deepEqual(scrolls, [[0], [600], [73, 31]]);
    assertNoFocus(h);
  }
});
