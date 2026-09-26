// Bridge transport resilience in the shipped worker, plus same-process (subagent) loading in index.ts.
// Worker timers are scaled 1000x down so the real 45s /next deadline elapses in ~45ms.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const workerSource = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/browser-extension/service_worker.js", import.meta.url), "utf8");
const indexSource = fs.readFileSync(new URL("../../extensions/chrome-profile-bridge/index.ts", import.meta.url), "utf8");

function loadWorker(fetchImpl) {
  const listener = { addListener() {}, removeListener() {} };
  const chrome = {
    runtime: { id: "test", getManifest: () => ({ version: "0.0.1" }), getURL: (f) => `chrome-extension://test/${f}`, onInstalled: listener, onStartup: listener, reload() {} },
    alarms: { create() {}, onAlarm: listener }, action: { onClicked: listener }, webNavigation: { onCommitted: listener },
    debugger: { onDetach: listener }, scripting: {}, tabs: { onUpdated: listener },
  };
  const sandbox = {
    chrome, console, AbortController, URL,
    navigator: { userAgent: "unit-test" },
    setTimeout: (fn, ms, ...args) => setTimeout(fn, Math.ceil((ms || 0) / 1000), ...args),
    clearTimeout, setInterval: () => 0, clearInterval() {},
    fetch: fetchImpl,
  };
  sandbox.self = sandbox;
  vm.runInNewContext(workerSource, sandbox);
  return sandbox;
}

function response(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, json: async () => body };
}

test("a half-open /next long poll is aborted at its deadline and polling resumes", async () => {
  const requests = [];
  let aborted = 0;
  const worker = loadWorker((url, options = {}) => {
    requests.push({ url, options });
    if (requests.length === 1) {
      // Zombie socket: never settles unless aborted.
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          aborted++;
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }
    return Promise.reject(new Error("bridge down"));
  });
  const first = worker.pollLoop();
  assert.ok(requests[0]?.options.signal, "the /next fetch carries an abort signal");
  // Resolves only after the scaled 45s deadline fires and the 2s backoff elapses.
  await first;
  assert.equal(aborted, 1, "the stalled /next fetch was aborted");
  await worker.pollLoop();
  assert.equal(requests.length, 2, "a later poll opens a fresh /next request instead of staying parked");
});

test("a command result is posted exactly once, retried on transport failure, and not retried on 4xx", async () => {
  const posts = [];
  let postStatus = [500, 200];
  const worker = loadWorker(async (url, options = {}) => {
    if (url.includes("/result")) {
      posts.push(JSON.parse(options.body));
      const status = postStatus.shift() ?? 200;
      if (status === 0) throw new Error("fetch failed");
      return response(status, {});
    }
    throw new Error("not polling in this test");
  });
  await worker.handleCommand({ id: "cmd-1", action: "tab.version", params: {} });
  assert.equal(posts.length, 2, "one retry after HTTP 500");
  assert.ok(posts.every((p) => p.id === "cmd-1" && p.ok === true), "the retry re-sends the success payload, not an error payload");

  posts.length = 0;
  postStatus = [0, 0, 0];
  await worker.handleCommand({ id: "cmd-2", action: "tab.version", params: {} });
  assert.equal(posts.length, 3, "network failures retry up to the attempt limit");
  assert.ok(posts.every((p) => p.ok === true), "a failed success-post never turns into a second, error result");

  posts.length = 0;
  postStatus = [404];
  await worker.handleCommand({ id: "cmd-3", action: "no.such.action", params: {} });
  assert.equal(posts.length, 1, "4xx (unknown command id) is final");
  assert.equal(posts[0].ok, false);
  assert.match(posts[0].error, /Unknown action/);
});

test("cdp.call widens only its own command deadline", () => {
  const worker = loadWorker(async () => { throw new Error("offline"); });
  assert.equal(worker.commandTimeoutMs("page.click", { timeoutMs: 90_000 }), 25_000);
  assert.equal(worker.commandTimeoutMs("cdp.call", {}), 25_000);
  assert.equal(worker.commandTimeoutMs("cdp.call", { timeoutMs: 60_000 }), 65_000);
  assert.equal(worker.commandTimeoutMs("cdp.call", { timeoutMs: 10_000_000 }), 125_000, "capped below the MV3 worker lifetime");
});

// ---- index.ts: a subagent session loads pi-chrome again in the same process. ----
function loadFactoryPrelude(globalState, root) {
  const from = indexSource.indexOf("\tconst alreadyLoaded = globalState[PI_CHROME_GLOBAL_KEY];");
  const to = indexSource.indexOf("\tconst bridge = new ChromeProfileBridge(", from);
  assert.ok(from > 0 && to > from, "factory prelude section");
  const body = stripTypeScriptTypes(`(() => {\n${indexSource.slice(from, to)}\nreturn true;\n})()`);
  const warnings = [];
  const token = Symbol(root);
  const sandbox = {
    globalState, currentRoot: root, instanceToken: token, PI_CHROME_GLOBAL_KEY: "loaded", PI_CHROME_VERSION: "9.9.9",
    console: { warn: (msg) => warnings.push(msg) },
  };
  const loaded = vm.runInNewContext(body, sandbox);
  return { loaded: loaded === true, token, warnings };
}

test("a same-root second load (subagent session) is not skipped, and does not steal the singleton flag", () => {
  const globalState = {};
  const parent = loadFactoryPrelude(globalState, "/pkg/pi-chrome");
  assert.equal(parent.loaded, true);
  assert.equal(globalState.loaded.token, parent.token);
  const subagent = loadFactoryPrelude(globalState, "/pkg/pi-chrome");
  assert.equal(subagent.loaded, true, "subagent gets its own pi-chrome instance and chrome_* tools");
  assert.equal(subagent.warnings.length, 0);
  assert.equal(globalState.loaded.token, parent.token, "only the first instance owns (and later clears) the flag");
});

test("a second install root is still treated as a duplicate", () => {
  const globalState = {};
  loadFactoryPrelude(globalState, "/npm/pi-chrome");
  const other = loadFactoryPrelude(globalState, "/checkout/pi-chrome");
  assert.equal(other.loaded, false);
  assert.match(other.warnings[0], /already loaded from \/npm\/pi-chrome/);
});

test("a stale same-root flag from an older release does not block loading", () => {
  const globalState = { loaded: { version: "0.15.19", root: "/pkg/pi-chrome" } };
  assert.equal(loadFactoryPrelude(globalState, "/pkg/pi-chrome").loaded, true);
});
