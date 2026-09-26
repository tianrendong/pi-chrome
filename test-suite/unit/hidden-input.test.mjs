// Hidden-tab input guard, full-screen automation targets, input.debug without a target, upload
// targets (label/wrapper/iframe/file-chooser), and screenshot pruning. Chrome and pages are mocked;
// the hidden-page behavior itself (Chrome drops trusted input) was measured live on Chrome/macOS.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const workerSource = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/browser-extension/service_worker.js", import.meta.url), "utf8");
const indexSource = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/index.ts", import.meta.url), "utf8");
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function worker({ visibility = ["visible"], tab = { id: 2, windowId: 1, active: false, url: "https://fixture.test/" }, win = { id: 1, state: "normal" } } = {}) {
  const calls = [];
  const listener = { addListener() {}, removeListener() {} };
  const chrome = {
    runtime: { id: "test", getManifest: () => ({ version: "0.0.0" }), onInstalled: listener, onStartup: listener },
    alarms: { create() {}, onAlarm: listener }, action: { onClicked: listener }, webNavigation: { onCommitted: listener },
    debugger: { onDetach: listener, onEvent: listener, getTargets: (cb) => cb([]) },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    scripting: { executeScript: async (options) => { calls.push({ method: "scripting.executeScript", options }); return [{ result: { tag: "BUTTON", url: tab.url } }]; } },
    tabs: {
      get: async (id) => (id === tab.id ? clone(tab) : Promise.reject(new Error(`No tab with id: ${id}`))),
      query: async () => [clone(tab)],
      create: async (props) => { calls.push({ method: "tabs.create", props }); return { id: 77, windowId: 1, url: props.url }; },
    },
    windows: {
      get: async () => clone(win),
      getLastFocused: async () => clone(win),
      create: async (props) => { calls.push({ method: "windows.create", props }); return { id: 9, tabs: [{ id: 90, windowId: 9 }] }; },
    },
  };
  const w = { chrome, console, setTimeout, clearTimeout, setInterval: () => 0, navigator: { userAgent: "unit-test" }, fetch: async () => { throw new Error("offline"); } };
  w.self = w;
  vm.runInNewContext(workerSource, w);
  w.sleep = async () => {};
  w.getTabByParams = async () => clone(tab);
  w.attachDebugger = async () => {};
  w.cdpMoveTo = async () => {};
  w.resolveTargetInTab = async () => ({ found: true, x: 40, y: 50, rect: { left: 10, top: 10, width: 100, height: 20 }, tag: "INPUT" });
  let probes = 0;
  w.cdp = async (_tabId, method, params = {}) => {
    calls.push({ method, params: clone(params) });
    if (method === "Runtime.evaluate" && params.expression === "document.visibilityState") {
      const state = visibility[Math.min(probes++, visibility.length - 1)];
      if (state instanceof Error) throw state;
      return { result: { type: "string", value: state } };
    }
    return {};
  };
  return { w, chrome, calls, inputs: () => calls.filter((c) => c.method.startsWith("Input.")) };
}

// ---- hidden-tab guard ----
test("typing into a hidden tab fails fast with the reason instead of silently dropping keys", async () => {
  const h = worker({ visibility: ["hidden"] });
  await assert.rejects(h.w.dispatch("page.type", { selector: "#q", text: "hi", background: true }), (error) => {
    assert.match(error.message, /chrome\.type: tab 2 is hidden because it is an inactive tab in its window/);
    assert.match(error.message, /background:false/);
    return true;
  });
  assert.equal(h.inputs().length, 0, "no trusted input sent to a hidden page");
});

for (const [action, params] of [["key", { key: "Enter" }], ["hover", { x: 1, y: 1 }], ["scroll", { deltaY: 10 }], ["tap", { x: 1, y: 1 }], ["drag", { fromX: 1, fromY: 1, toX: 2, toY: 2 }]]) {
  test(`${action} refuses hidden tabs before sending input`, async () => {
    const h = worker({ visibility: ["hidden"] });
    await assert.rejects(h.w.dispatch(`page.${action}`, { ...params, background: true }), new RegExp(`chrome\\.${action}: tab 2 is hidden`));
    assert.equal(h.inputs().length, 0);
  });
}

test("click and fill use their DOM fallback immediately for hidden tabs, or reject with domFallback:false", async () => {
  const click = worker({ visibility: ["hidden"] });
  const clicked = await click.w.dispatch("page.click", { selector: "button", background: true });
  assert.equal(clicked.input, "dom-fallback");
  assert.match(clicked.reason, /hidden/);
  assert.equal(click.inputs().length, 0);
  await assert.rejects(worker({ visibility: ["hidden"] }).w.dispatch("page.click", { selector: "button", background: true, domFallback: false }), /is hidden/);

  const fill = worker({ visibility: ["hidden"] });
  fill.w.domFillFallback = async (_tabId, _params, cause) => ({ input: "dom-fallback", reason: String(cause.message) });
  const filled = await fill.w.dispatch("page.fill", { selector: "#q", text: "x", background: true });
  assert.equal(filled.input, "dom-fallback");
  assert.match(filled.reason, /hidden/);
  assert.equal(fill.inputs().length, 0);
});

test("hidden reasons distinguish minimized and macOS full-screen windows", async () => {
  const minimized = worker({ visibility: ["hidden"], win: { id: 1, state: "minimized" } });
  await assert.rejects(minimized.w.dispatch("page.key", { key: "a", background: true }), /its window is minimized/);
  const fullscreen = worker({ visibility: ["hidden"], tab: { id: 2, windowId: 1, active: true, url: "https://fixture.test/" }, win: { id: 1, state: "fullscreen" } });
  await assert.rejects(fullscreen.w.dispatch("page.key", { key: "a", background: true }), (error) => {
    assert.match(error.message, /behind a full-screen window/);
    assert.equal(error.windowState, "fullscreen");
    return true;
  });
});

test("visible pages, failed probes, and foreground tabs that become visible proceed with trusted input", async () => {
  const visible = worker();
  assert.equal((await visible.w.dispatch("page.key", { key: "a", background: true })).input, "chrome");
  const unknown = worker({ visibility: [new Error("probe failed")] });
  assert.equal((await unknown.w.dispatch("page.key", { key: "a", background: true })).input, "chrome");
  const foreground = worker({ visibility: ["hidden", "hidden", "visible"] });
  foreground.w.bringToFront = async (tab) => tab;
  assert.equal((await foreground.w.dispatch("page.key", { key: "a", foreground: true })).input, "chrome");
});

// ---- automation target placement ----
test("automation targets use a background tab, not a new window, while the user's window is full screen", async () => {
  const full = worker({ win: { id: 1, state: "fullscreen" } });
  await full.w.createAutomationTarget("s1", undefined);
  assert.equal(full.calls.some((c) => c.method === "windows.create"), false);
  assert.deepEqual(clone(full.calls.find((c) => c.method === "tabs.create").props), { url: "about:blank", active: false });

  const normal = worker({ win: { id: 1, state: "maximized" } });
  await normal.w.createAutomationTarget("s2", undefined);
  assert.deepEqual(clone(normal.calls.find((c) => c.method === "windows.create").props), { url: "about:blank", focused: false });
});

// ---- input.debug ----
test("input.debug without a target does not call tabs.get(-1) and reports the session's own tab", async () => {
  const h = worker();
  h.chrome.tabs.get = async (id) => {
    if (!Number.isInteger(id) || id < 0) throw new Error("Value must be at least 0.");
    return id === 2 ? { id: 2, windowId: 1, url: "https://fixture.test/" } : Promise.reject(new Error("missing"));
  };
  const none = await h.w.dispatch("input.debug", {});
  assert.equal(none.resolvedTab, null);
  h.w.resolveOwnedAutomationTarget = async () => ({ id: 2 });
  const owned = await h.w.dispatch("input.debug", { sessionKey: "s" });
  assert.equal(owned.resolvedTab.id, 2);
});

// ---- upload targets ----
function uploadWorker({ visibility = "visible", chooserMode = "selectMultiple", opensChooser = true } = {}) {
  const h = worker({ visibility: [visibility] });
  const fileInput = { tagName: "INPUT", type: "file", multiple: true, isConnected: true };
  const frameInput = { tagName: "INPUT", type: "file", multiple: false, isConnected: true };
  const button = { tagName: "BUTTON", isConnected: true, querySelectorAll: () => [] };
  const label = { tagName: "LABEL", control: fileInput, isConnected: true, querySelectorAll: () => [] };
  const dropzone = { tagName: "DIV", isConnected: true, querySelectorAll: () => [fileInput] };
  const frameDoc = { querySelector: (s) => (s === "#frame-file" ? frameInput : null), querySelectorAll: () => [] };
  const doc = {
    querySelector: (s) => ({ "#file": fileInput, "#button": button, "#label": label, "#drop": dropzone }[s] ?? null),
    querySelectorAll: (s) => (s === "iframe,frame" ? [{ contentDocument: frameDoc }] : []),
  };
  const page = vm.createContext({ document: doc, __PI_CHROME_STATE__: { elements: {} } });
  page.window = page;
  const objects = new Map();
  let nextObject = 1;
  const base = h.w.cdp;
  h.w.cdp = async (tabId, method, params = {}) => {
    if (method === "Runtime.evaluate" && params.objectGroup === "pi-chrome-upload") {
      h.calls.push({ method, params: {} });
      try {
        const el = vm.runInContext(params.expression, page);
        const objectId = `obj-${nextObject++}`;
        objects.set(objectId, el);
        return { result: { objectId } };
      } catch (error) {
        return { exceptionDetails: { text: error.message } };
      }
    }
    const result = await base(tabId, method, params);
    if (method === "Runtime.callFunctionOn" && /getBoundingClientRect/.test(params.functionDeclaration)) {
      const el = objects.get(params.objectId);
      const isFile = el.tagName === "INPUT" && el.type === "file";
      return { result: { value: { tag: el.tagName, isFile, multiple: isFile ? el.multiple : undefined, inFrame: el === frameInput, x: 50, y: 60, width: 80, height: 20 } } };
    }
    const clicked = (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") || (method === "Runtime.callFunctionOn" && params.userGesture === true);
    if (clicked && opensChooser) setTimeout(() => h.w.handleDebuggerEvent({ tabId: 2 }, "Page.fileChooserOpened", { backendNodeId: 42, mode: chooserMode }), 0);
    return result;
  };
  h.w.waitForFileChooser = ((original) => (tabId) => original(tabId, 200))(h.w.waitForFileChooser);
  return h;
}
const setFiles = (h) => h.calls.filter((c) => c.method === "DOM.setFileInputFiles").map((c) => c.params);

test("upload resolves labels and single-input wrappers to the file input without clicking", async () => {
  for (const selector of ["#file", "#label", "#drop"]) {
    const h = uploadWorker();
    const result = await h.w.dispatch("page.upload", { selector, paths: ["/a.txt", "/b.txt"], background: true });
    assert.equal(result.mode, "file-input", selector);
    assert.equal(setFiles(h).length, 1);
    assert.equal(h.inputs().length, 0, "no click for a real file input");
  }
});

test("upload finds file inputs inside same-origin iframes and enforces single-file inputs", async () => {
  const h = uploadWorker();
  const result = await h.w.dispatch("page.upload", { selector: "#frame-file", paths: ["/a.txt"], background: true });
  assert.equal(result.mode, "file-input");
  assert.equal(result.inFrame, true);
  await assert.rejects(uploadWorker().w.dispatch("page.upload", { selector: "#frame-file", paths: ["/a.txt", "/b.txt"], background: true }), /accepts one file but 2 paths/);
});

test("upload buttons open an intercepted file chooser with a trusted click on visible pages", async () => {
  const h = uploadWorker();
  const result = await h.w.dispatch("page.upload", { selector: "#button", paths: ["/a.txt"], background: true });
  assert.equal(result.mode, "file-chooser");
  assert.equal(result.trigger, "chrome");
  assert.deepEqual(clone(setFiles(h)), [{ backendNodeId: 42, files: ["/a.txt"] }]);
  assert.deepEqual(h.calls.filter((c) => c.method === "Page.setInterceptFileChooserDialog").map((c) => c.params.enabled), [true, false]);
  assert.ok(h.inputs().some((c) => c.params.type === "mousePressed"));
});

test("hidden pages use a user-gesture element.click() for upload buttons unless domFallback:false", async () => {
  const h = uploadWorker({ visibility: "hidden" });
  const result = await h.w.dispatch("page.upload", { selector: "#button", paths: ["/a.txt"], background: true });
  assert.equal(result.trigger, "activation-click");
  assert.match(result.reason, /hidden/);
  assert.equal(h.inputs().length, 0);
  const strict = uploadWorker({ visibility: "hidden" });
  await assert.rejects(strict.w.dispatch("page.upload", { selector: "#button", paths: ["/a.txt"], background: true, domFallback: false }), /is hidden/);
  assert.equal(setFiles(strict).length, 0);
});

test("chooser failures attach nothing and always disable interception", async () => {
  const single = uploadWorker({ chooserMode: "selectSingle" });
  await assert.rejects(single.w.dispatch("page.upload", { selector: "#button", paths: ["/a.txt", "/b.txt"], background: true }), /accepts one file/);
  assert.equal(setFiles(single).length, 0);
  const none = uploadWorker({ opensChooser: false });
  await assert.rejects(none.w.dispatch("page.upload", { selector: "#button", paths: ["/a.txt"], background: true }), /no file chooser opened/);
  assert.deepEqual(none.calls.filter((c) => c.method === "Page.setInterceptFileChooserDialog").map((c) => c.params.enabled), [true, false]);
  assert.equal(none.calls.at(-1).method, "Runtime.releaseObject");
});

test("file chooser events attached by targetId route to the right tab", async () => {
  const h = worker();
  vm.runInContext('attachedTabs.set(5, { debuggee: { targetId: "T5" } })', h.w);
  const pending = h.w.waitForFileChooser(5, 1000);
  h.w.handleDebuggerEvent({ targetId: "T5" }, "Page.fileChooserOpened", { backendNodeId: 7, mode: "selectSingle" });
  assert.deepEqual(clone(await pending.promise), { backendNodeId: 7, mode: "selectSingle" });
});

// ---- screenshot pruning ----
const pruneSource = indexSource.slice(indexSource.indexOf("const SCREENSHOT_NAME_RE"), indexSource.indexOf("// End screenshot pruning."));
const prune = vm.runInNewContext(`${stripTypeScriptTypes(pruneSource)}; ({ screenshotFilesToPrune, pruneScreenshotDir })`, {
  readdir: fs.promises.readdir, unlink: fs.promises.unlink, join: path.join, Date,
});
const DAY = 24 * 60 * 60 * 1000;
const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, "-");

test("screenshot pruning keeps the newest 20 captures and anything inside the retention window", () => {
  const now = Date.parse("2026-09-26T12:00:00.000Z");
  const names = [];
  for (let i = 0; i < 25; i++) names.push(`${stamp(now - (30 + i) * DAY)}.png`);
  const fullPage = stamp(now - 60 * DAY);
  names.push(`${fullPage}-tile0.png`, `${fullPage}-tile1.png`, `${fullPage}.png.json`);
  names.push(`${stamp(now - DAY)}.jpeg`, "my-notes.png", "2026-01-01.png", "keep.json");
  const pruned = prune.screenshotFilesToPrune(names, now);
  // 25 old singles + 1 full-page capture + 1 recent = 27 captures; the newest 20 survive. The recent
  // capture is newest, so 19 old singles survive and 6 old singles + the full-page capture go.
  assert.equal(pruned.length, 6 + 3);
  for (const suffix of ["-tile0.png", "-tile1.png", ".png.json"]) assert.ok(pruned.includes(`${fullPage}${suffix}`));
  for (const name of ["my-notes.png", "2026-01-01.png", "keep.json", `${stamp(now - DAY)}.jpeg`]) assert.ok(!pruned.includes(name), name);

  const recent = Array.from({ length: 30 }, (_, i) => `${stamp(now - i * 60_000)}.png`);
  assert.equal(prune.screenshotFilesToPrune(recent, now).length, 0, "nothing inside the retention window is removed");
  assert.equal(prune.screenshotFilesToPrune(names, now, 0).length, 0, "retentionDays:0 disables pruning");
  assert.equal(prune.screenshotFilesToPrune(names, now, 55).length, 3, "a longer window keeps more");
});

test("pruneScreenshotDir deletes only eligible files and never throws", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chrome-shots-"));
  const now = Date.now();
  for (let i = 0; i < 22; i++) fs.writeFileSync(path.join(dir, `${stamp(now - (10 + i) * DAY)}.png`), "x");
  fs.writeFileSync(path.join(dir, "mine.png"), "x");
  assert.equal(await prune.pruneScreenshotDir(dir), 2);
  assert.equal(fs.readdirSync(dir).length, 21);
  assert.ok(fs.existsSync(path.join(dir, "mine.png")));
  assert.equal(await prune.pruneScreenshotDir(path.join(dir, "missing")), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
