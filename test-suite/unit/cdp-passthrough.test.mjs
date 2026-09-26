// Raw CDP passthrough (cdp.call / cdp.targets / chrome_cdp formatting) and the scripting→CDP fallback
// that keeps page actions working on about:blank automation tabs.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const workerSource = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/browser-extension/service_worker.js", import.meta.url), "utf8");
const indexSource = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/index.ts", import.meta.url), "utf8");
const ABOUT_BLANK_DENIED = 'Cannot access contents of url "about:blank". Extension manifest must request permission to access this host.';

function harness({ targets = [], respond } = {}) {
  const calls = [], attached = [], hung = [];
  const listener = { addListener() {}, removeListener() {} };
  const page = vm.createContext({ location: { href: "about:blank" } });
  page.window = page;
  page.globalThis = page;
  const chrome = {
    runtime: { id: "test", getManifest: () => ({ version: "0.0.1" }), getURL: (f) => `chrome-extension://test/${f}`, onInstalled: listener, onStartup: listener, lastError: null },
    alarms: { create() {}, onAlarm: listener }, action: { onClicked: listener }, webNavigation: { onCommitted: listener },
    debugger: {
      onDetach: listener,
      getTargets: (cb) => cb(targets),
      attach: async () => {},
      // Real Chrome fails in-flight commands with "Detached while handling command" on detach.
      detach: async () => {
        for (const cb of hung.splice(0)) {
          chrome.runtime.lastError = { message: "Detached while handling command." };
          cb(undefined);
          chrome.runtime.lastError = null;
        }
      },
      sendCommand: (debuggee, method, params, cb) => {
        calls.push({ method, params: JSON.parse(JSON.stringify(params)) });
        const reply = respond ? respond(method, params) : undefined;
        if (reply === "never") { hung.push(cb); return; } // simulate a hung CDP command
        Promise.resolve(reply).then((value) => {
          if (method === "Runtime.evaluate" && value === undefined) {
            Promise.resolve().then(() => vm.runInContext(params.expression, page)).then(
              (v) => { const json = JSON.stringify(v); cb({ result: json === undefined ? { type: typeof v } : { value: JSON.parse(json) } }); },
              (error) => cb({ exceptionDetails: { text: error.message, exception: { description: error.message } } }),
            );
            return;
          }
          cb(value);
        });
      },
    },
    scripting: { executeScript: async () => { throw new Error(ABOUT_BLANK_DENIED); } },
    tabs: { onUpdated: listener, get: async (id) => ({ id, windowId: 1, url: "about:blank", status: "complete" }) },
  };
  const sources = new Map();
  const worker = {
    chrome, console, AbortController, URL,
    navigator: { userAgent: "unit-test" },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    fetch: async (url) => {
      const file = String(url).replace("chrome-extension://test/", "");
      if (!sources.has(file)) return { ok: false, status: 404, text: async () => "" };
      return { ok: true, status: 200, text: async () => sources.get(file) };
    },
  };
  worker.self = worker;
  vm.runInNewContext(workerSource, worker);
  worker.getTabByParams = async (params, opts = {}) => {
    if (params.targetId === "missing") throw new Error("No Chrome tab with id 999");
    if (opts.createOwnedTarget === false && params.targetId === undefined) return null;
    return { id: Number(params.targetId ?? 5), windowId: 1, url: "https://fixture.test/", title: "Fixture" };
  };
  worker.bringToFront = async (tab) => tab;
  const realAttach = worker.attachDebugger;
  worker.attachDebugger = async (tabId) => { attached.push(tabId); return realAttach(tabId); };
  return { worker, chrome, calls, attached, page, sources, cdpMethods: () => calls.map((c) => c.method) };
}

test("cdp.call validates method/params before touching the debugger", async () => {
  const h = harness();
  await assert.rejects(h.worker.dispatch("cdp.call", { method: "  " }), /non-empty string "method"/);
  await assert.rejects(h.worker.dispatch("cdp.call", { method: "Runtime.evaluate", params: [1] }), /must be a plain object/);
  await assert.rejects(h.worker.dispatch("cdp.call", { method: "Runtime.evaluate", params: "x" }), /must be a plain object/);
  assert.equal(h.attached.length, 0);
  assert.equal(h.calls.length, 0);
});

test("cdp.call sends the exact method and params to the resolved tab and returns the raw result", async () => {
  const h = harness({ respond: (method) => method === "Network.getCookies" ? { cookies: [{ name: "sid" }] } : {} });
  const result = await h.worker.dispatch("cdp.call", { targetId: "7", method: " Network.getCookies ", params: { urls: ["https://fixture.test"] } });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { cookies: [{ name: "sid" }] });
  assert.deepEqual(h.attached, [7]);
  assert.deepEqual(h.calls.at(-1), { method: "Network.getCookies", params: { urls: ["https://fixture.test"] } });
});

test("background mode blocks focus-stealing raw CDP methods; foreground allows them", async () => {
  const h = harness();
  for (const method of ["Page.bringToFront", "Target.activateTarget"]) {
    await assert.rejects(h.worker.dispatch("cdp.call", { method, background: true, foreground: false }), /blocked by background mode/);
  }
  assert.equal(h.calls.length, 0);
  await h.worker.dispatch("cdp.call", { method: "Page.bringToFront", background: false, foreground: true });
  assert.equal(h.cdpMethods().at(-1), "Page.bringToFront");
});

test("cdp.call honours timeoutMs and detaches a hung session", async () => {
  const h = harness({ respond: (method) => method === "Debugger.pause" ? "never" : undefined });
  const started = Date.now();
  await assert.rejects(h.worker.dispatch("cdp.call", { method: "Debugger.pause", timeoutMs: 60 }), /CDP Debugger\.pause timed out after 60ms/);
  assert.ok(Date.now() - started < 2_000, "custom deadline used instead of a longer default");
  assert.equal(h.cdpMethods().filter((m) => m === "Debugger.pause").length, 1, "a timed-out command is not re-sent after the cleanup detach");
  assert.equal(h.worker.cdpCallTimeoutMs({}), 5_000);
  assert.equal(h.worker.cdpCallTimeoutMs({ timeoutMs: 999_999 }), 120_000);
});

test("cdp.targets lists only the resolved tab's targets, never creates a target, and surfaces explicit misses", async () => {
  const h = harness({ targets: [
    { id: "a", tabId: 5, type: "page", url: "https://fixture.test/", attached: true },
    { id: "b", tabId: 5, type: "other", url: "chrome-extension://pw/overlay.html", attached: false, extensionId: "pw" },
    { id: "c", tabId: 9, type: "page", url: "https://private.example/secret", attached: false },
  ] });
  const listed = await h.worker.dispatch("cdp.targets", { targetId: "5" });
  assert.deepEqual(listed.targets.map((t) => t.id), ["a", "b"]);
  assert.equal(listed.otherTabTargetCount, 1);
  assert.ok(!JSON.stringify(listed).includes("private.example"), "other tabs' URLs are not echoed");
  const none = await h.worker.dispatch("cdp.targets", {});
  assert.equal(none.tab, null);
  assert.equal(none.targets.length, 0);
  await assert.rejects(h.worker.dispatch("cdp.targets", { targetId: "missing" }), /No Chrome tab with id/);
  assert.equal(h.attached.length, 0, "diagnostics never attach the debugger");
});

test("scripting denied on about:blank falls back to CDP for func and packaged-file injection", async () => {
  const h = harness();
  h.sources.set("snapshot_injected.js", "globalThis.__piChromeSnapshotPage = async (max, _c, _r, _n, mode) => ({ url: location.href, max, mode });");
  const snapshot = await h.worker.dispatch("page.snapshot", { targetId: "5", maxElements: 12, mode: "forms" });
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), { url: "about:blank", max: 12, mode: "forms" });
  assert.ok(h.cdpMethods().filter((m) => m === "Runtime.evaluate").length >= 2, "file and func both ran through Runtime.evaluate");

  const clicked = await h.worker.resolveTargetInTab(5, { x: 10, y: 20 });
  assert.equal(clicked.found, true, "input target resolution also survives denied scripting");
});

test("non-permission scripting failures are not masked by the CDP fallback", async () => {
  const h = harness();
  h.chrome.scripting.executeScript = async () => { throw new Error("Frame with ID 0 was removed."); };
  await assert.rejects(h.worker.executeScriptWithFallback({ target: { tabId: 5 }, func: () => 1 }, "x"), /Frame with ID 0 was removed/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.worker.isScriptingAccessDenied(new Error(ABOUT_BLANK_DENIED)), true);
});

test("CDP fallback reports page exceptions with the call-site label", async () => {
  const h = harness();
  await assert.rejects(
    h.worker.executeScriptWithFallback({ target: { tabId: 5 }, func: () => { throw new Error("boom in page"); }, args: [] }, "probe page"),
    /probe page: .*boom in page/,
  );
});

// ---- Pi-side formatting for chrome_cdp results ----
function section(start, end) {
  const from = indexSource.indexOf(start);
  const to = indexSource.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing source section: ${start}`);
  return indexSource.slice(from, to);
}
const formatCdpResult = vm.runInNewContext(`${stripTypeScriptTypes(section("const CDP_OVERSIZE_JSON_CHARS", "\nfunction extensionRoot"))}; formatCdpResult`, {
  safeJson: (v) => JSON.stringify(v, null, 2),
  truncateText: (s) => (s.length > 30_000 ? `${s.slice(0, 30_000)}[truncated]` : s),
});

test("chrome_cdp never returns screenshot/binary payloads or oversized details verbatim", () => {
  const data = "A".repeat(4000) + "==";
  const shot = formatCdpResult("Page.captureScreenshot", { data });
  assert.ok(!shot.content[0].text.includes("AAAA"));
  assert.match(shot.content[0].text, /~2999 bytes/);
  assert.equal(shot.details.value.omitted, "data-field");

  const huge = formatCdpResult("DOM.getOuterHTML", { outerHTML: "x".repeat(300_000) });
  assert.equal(huge.details.value.omitted, "oversized-result");
  assert.ok(huge.content[0].text.length < 31_000);

  const small = formatCdpResult("Runtime.evaluate", { result: { type: "number", value: 2 } });
  assert.deepEqual(small.details.value, { result: { type: "number", value: 2 } });
});
