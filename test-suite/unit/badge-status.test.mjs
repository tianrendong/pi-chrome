// Unit harness for pi-chrome's connection-status toolbar badge (LED) and popup status page.
//
// We test the parts that are unit-testable without driving the full pollLoop:
//   1. Initial badge paint (red "off") — synchronous on worker load.
//   2. Popup snapshot on connect — synchronous, no polling involved.
//   3. Non-popup ports are ignored.
//
// The state transitions inside pollLoop (online / auth) are exercised by integration tests;
// driving the worker's while(true) pollLoop deterministically in a unit test requires
// re-implementing the bridge protocol, which is not what this harness is for.

import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/browser-extension/service_worker.js");
const src = fs.readFileSync(workerPath, "utf8");

let passes = 0, failures = 0;
function ok(cond, msg) {
  if (cond) passes++;
  else { failures++; console.error(`  ✗ ${msg}`); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (got: ${JSON.stringify(a)}, expected: ${JSON.stringify(b)})`); }

function makeHarness() {
  const badges = [];
  const popupMessages = [];

  // Fetch is not used by the tests in this file; we still provide a stub so the service
  // worker's pollLoop does not throw on the first tick.
  async function noFetch() { return { ok: true, status: 204, headers: { get: () => null }, json: async () => ({}), text: async () => "" }; }

  const chrome = {
    runtime: {
      id: "unittest-bridge-status",
      getManifest: () => ({ version: "0.15.42" }),
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onConnect: { addListener: (cb) => { chrome.runtime._onConnect = cb; } },
      _onConnect: null,
      lastError: null,
    },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} }, clear: () => {}, clearAll: () => {} },
    action: {
      onClicked: { addListener: () => {} },
      setBadgeBackgroundColor: (opts) => { badges.push({ kind: "bg", ...opts }); },
      setBadgeText: (opts) => { badges.push({ kind: "text", ...opts }); },
    },
    debugger: { sendCommand: () => {}, attach: async () => {}, detach: async () => {}, getTargets: (cb) => cb([]), onDetach: { addListener: () => {} } },
    scripting: { executeScript: async () => [{ result: undefined }], registerContentScripts: async () => {}, unregisterContentScripts: async () => {} },
    webNavigation: { onCommitted: { addListener: () => {} } },
    tabs: {
      onUpdated: { addListener: () => {} },
      query: async () => [],
      get: async () => { throw new Error("not used"); },
      create: async () => { throw new Error("not used"); },
      update: async () => { throw new Error("not used"); },
      remove: async () => {},
      group: async () => 0,
      ungroup: async () => {},
    },
    tabGroups: undefined,
    windows: undefined,
    storage: undefined,
  };

  function fakeConnect({ name } = {}) {
    const messages = [];
    const handlers = { message: [], disconnect: [] };
    return {
      name,
      postMessage: (msg) => { messages.push(msg); popupMessages.push(msg); },
      onMessage: { addListener: (cb) => handlers.message.push(cb) },
      onDisconnect: { addListener: (cb) => handlers.disconnect.push(cb) },
      _fireMessage: (msg) => handlers.message.forEach((cb) => cb(msg)),
      _fireDisconnect: () => handlers.disconnect.forEach((cb) => cb()),
      _messages: messages,
    };
  }

  const sandbox = {
    console, JSON, Date, Math, Promise, Array, Object, String, Number, Boolean,
    Error, TypeError, Map, Set, BigInt, Symbol, structuredClone,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    fetch: noFetch,
    navigator: { userAgent: "unit-test" },
    WebSocket: function () {},
    chrome,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  return { chrome, badges, popupMessages, fakeConnect };
}

async function run() {
  // ===== Initial badge =====
  {
    const h = makeHarness();
    const lastBadge = () => {
      const text = [...h.badges].reverse().find((b) => b.kind === "text");
      const bg = [...h.badges].reverse().find((b) => b.kind === "bg");
      return { text: text?.text, color: bg?.color };
    };
    const b = lastBadge();
    eq(b.text, "off", "initial badge text is 'off' (offline)");
    eq(b.color, "#dc2626", "initial badge color is red (offline)");
  }

  // ===== Popup port receives a status snapshot on connect =====
  {
    const h = makeHarness();
    ok(typeof h.chrome.runtime._onConnect === "function", "service worker registered a chrome.runtime.onConnect handler");
    const popupPort = h.fakeConnect({ name: "popup" });
    h.chrome.runtime._onConnect(popupPort);
    // The snapshot is now async (the worker probes the bridge before answering), so give it
    // a couple of microtask ticks to flush.
    await new Promise((r) => setTimeout(r, 50));
    ok(popupPort._messages.length >= 1, `popup received a status snapshot on connect (got ${popupPort._messages.length})`);
    const snap = popupPort._messages[popupPort._messages.length - 1];
    ok(snap, "snapshot is defined");
    eq(snap.type, "status", "snapshot message type is 'status'");
    ok(typeof snap.companionVersion === "string", "snapshot includes companionVersion");
    ok(typeof snap.bridgeUrl === "string", "snapshot includes bridgeUrl");
    ok(["offline", "online", "auth"].includes(snap.state), "snapshot state is one of the three known values");
    eq(snap.automationTargetCount, 0, "snapshot starts with zero automation targets");
    ok(snap.bridgeProbe && typeof snap.bridgeProbe === "object", "snapshot includes a bridgeProbe result");
  }

  // ===== Popup port ignored for non-popup names =====
  {
    const h = makeHarness();
    const otherPort = h.fakeConnect({ name: "something-else" });
    h.chrome.runtime._onConnect(otherPort);
    eq(otherPort._messages.length, 0, "non-popup port does not receive a status snapshot");
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
