const BRIDGE_URL = "http://127.0.0.1:17318";
const CLIENT_NAME = `Pi Chrome Connector ${chrome.runtime.id}`;
const POLL_ERROR_BACKOFF_MS = 2000;
let polling = false;

// =================== Chrome input (CDP) layer ===================
// Tracks which tabs we have attached chrome.debugger to.
const attachedTabs = new Map(); // tabId -> { detachAt: number, pointer: {x,y} }
const INPUT_IDLE_DETACH_MS = 15_000;
const CDP_VERSION = "1.3";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function rng(min, max) { return min + Math.random() * (max - min); }

function inputStatus() {
  return {
    attachedTabs: Array.from(attachedTabs.keys()),
    permissionGranted: typeof chrome !== "undefined" && !!chrome.debugger,
  };
}

// Last few attach failures, kept for diagnostics.
const attachDebugLog = [];
function recordAttachEvent(entry) {
  attachDebugLog.push({ ...entry, t: Date.now() });
  if (attachDebugLog.length > 20) attachDebugLog.shift();
}

async function attachDebugger(tabId) {
  if (!chrome.debugger) throw new Error("chrome.debugger API unavailable; reload the extension to grant the new permission");
  if (attachedTabs.has(tabId)) {
    const entry = attachedTabs.get(tabId);
    entry.detachAt = Date.now() + INPUT_IDLE_DETACH_MS;
    return entry;
  }
  // Before each attach, force-detach any stale CDP target this extension owns on the tab.
  // Chrome sometimes keeps a half-dead session around (extension reload mid-attach, etc.) and
  // surfaces it as "Cannot access a chrome-extension://" on the next attach attempt.
  try {
    const targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || [])));
    for (const tgt of targets) {
      if (tgt.tabId === tabId && tgt.attached) {
        recordAttachEvent({ kind: "stale-target-found", tabId, target: { id: tgt.id, type: tgt.type, url: tgt.url, extensionId: tgt.extensionId } });
        try { await chrome.debugger.detach({ tabId }); } catch {}
        await sleep(80);
        break;
      }
    }
  } catch {}
  const attemptAttach = async () => {
    try {
      await chrome.debugger.attach({ tabId }, CDP_VERSION);
      return null;
    } catch (error) {
      return error;
    }
  };
  let err = await attemptAttach();
  if (err) {
    const msg = String(err?.message || err);
    const transient = /Cannot access a chrome-extension|Cannot access contents of|No tab with id|Debugger is not attached|Another debugger|Target closed/i.test(msg);
    const tabSnapshot = await chrome.tabs.get(tabId).catch(() => null);
    recordAttachEvent({ kind: "attach-failed", tabId, message: msg, tabUrl: tabSnapshot?.url, transient });
    if (!transient) throw err;
    if (!tabSnapshot || (tabSnapshot.url || "").startsWith("chrome://") || (tabSnapshot.url || "").startsWith("chrome-extension://")) {
      throw new Error(`Chrome can't attach the debugger to this tab (${tabSnapshot?.url ?? "unknown"}). Open a normal http(s) tab and try again.`);
    }
    await sleep(180);
    err = await attemptAttach();
    if (err) {
      recordAttachEvent({ kind: "attach-retry-failed", tabId, message: String(err.message || err), tabUrl: tabSnapshot?.url });
      // One more try after a longer settle. Some Chrome builds need ~500ms after a navigation
      // for content-script registration on the tab to drain before chrome.debugger.attach
      // will accept the target.
      await sleep(500);
      err = await attemptAttach();
      if (err) {
        recordAttachEvent({ kind: "attach-retry2-failed", tabId, message: String(err.message || err), tabUrl: tabSnapshot?.url });
        throw err;
      }
    }
  }
  recordAttachEvent({ kind: "attached", tabId });
  // Seed pointer in a plausible "just left the address bar" location.
  const entry = { detachAt: Date.now() + INPUT_IDLE_DETACH_MS, pointer: { x: 120 + Math.random() * 200, y: 80 + Math.random() * 120 } };
  attachedTabs.set(tabId, entry);
  return entry;
}

async function inputDebug(params) {
  const tab = params?.targetId ? await chrome.tabs.get(Number(params.targetId)).catch(() => null) : null;
  let targets = [];
  try { targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || []))); } catch {}
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    extensionId: chrome.runtime.id,
    attachedTabs: Array.from(attachedTabs.keys()),
    requestedTab: tab ? { id: tab.id, url: tab.url, status: tab.status, title: tab.title } : null,
    cdpTargets: targets,
    recentAttachEvents: attachDebugLog.slice(),
  };
}

async function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch {}
}

async function detachAll() {
  const ids = Array.from(attachedTabs.keys());
  await Promise.all(ids.map(detachDebugger));
}

if (chrome.debugger && chrome.debugger.onDetach) {
  chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
    if (tabId !== undefined) attachedTabs.delete(tabId);
    if (reason === "canceled_by_user") {
      console.warn(`[pi-chrome] debugger canceled by user on tab ${tabId}; Chrome input will reattach on next call`);
    }
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [tabId, entry] of attachedTabs) {
    if (entry.detachAt && entry.detachAt < now) {
      void detachDebugger(tabId);
    }
  }
}, 5000);

function cdpRaw(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      if (chrome.runtime.lastError) reject(new Error(`${method}: ${chrome.runtime.lastError.message}`));
      else resolve(result);
    });
  });
}

// Wraps cdpRaw with one auto-recover on detached/closed sessions:
// chrome.debugger.attach can stay cached in attachedTabs even after Chrome killed
// the session (tab nav, devtools opened/closed, etc). Recover by detaching the
// stale entry and re-attaching, then retry the command once.
// Find foreign chrome-extension targets currently anchored to the tab. Password managers,
// autofill helpers, and other input-attached extensions create type:"other" CDP targets
// whose URL is chrome-extension://<otherId>/...  When that target is in focus, CDP refuses
// our Input.dispatchMouseEvent calls with "Cannot access a chrome-extension:// URL of
// different extension" — surfacing a cryptic error to the user.
async function findForeignExtensionTargets() {
  try {
    const targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || [])));
    return targets.filter((t) => {
      const url = String(t.url || "");
      if (!url.startsWith("chrome-extension://")) return false;
      if (t.extensionId === chrome.runtime.id) return false;
      return true;
    });
  } catch {
    return [];
  }
}

function extractForeignExtId(targets) {
  for (const t of targets) {
    if (t.extensionId && t.extensionId !== chrome.runtime.id) return t.extensionId;
    const m = String(t.url || "").match(/chrome-extension:\/\/([a-p]+)\//);
    if (m && m[1] !== chrome.runtime.id) return m[1];
  }
  return null;
}

async function dismissOverlayViaEscape(tabId) {
  // Esc routes through key dispatcher (target-by-focus), not by mouse coordinates, so it
  // works even when a foreign chrome-extension popup is intercepting pointer events.
  try {
    await cdpRaw(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdpRaw(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(120);
  } catch {}
}

async function cdp(tabId, method, params) {
  try {
    return await cdpRaw(tabId, method, params);
  } catch (error) {
    const msg = String(error?.message || error);
    const isStale = /Debugger is not attached|Detached while|Target closed|No tab with id/i.test(msg);
    const isForeignExtBlock = /Cannot access a chrome-extension:\/\/ URL of different extension/i.test(msg);
    if (isForeignExtBlock && /Input\./.test(method)) {
      // Foreign chrome-extension popup (autofill, password manager) is hijacking input.
      // Try once: dismiss via Esc, then retry.
      const before = await findForeignExtensionTargets();
      recordAttachEvent({ kind: "foreign-ext-detected", tabId, method, foreignExtId: extractForeignExtId(before), targetCount: before.length });
      await dismissOverlayViaEscape(tabId);
      try {
        return await cdpRaw(tabId, method, params);
      } catch (retryErr) {
        const retryMsg = String(retryErr?.message || retryErr);
        if (/Cannot access a chrome-extension:\/\/ URL of different extension/i.test(retryMsg)) {
          const after = await findForeignExtensionTargets();
          const id = extractForeignExtId(after) || extractForeignExtId(before) || "unknown";
          throw new Error(
            `Another Chrome extension (${id}) has an input overlay on this page (e.g. a password manager / autofill popup). \n` +
            `pi-chrome tried to dismiss it with Escape but it reappeared. Disable that extension on this page, close its popup, or focus the field via Tab instead of clicking.`,
          );
        }
        throw retryErr;
      }
    }
    if (!isStale) throw error;
    attachedTabs.delete(tabId);
    await chrome.debugger.attach({ tabId }, CDP_VERSION).catch(() => undefined);
    attachedTabs.set(tabId, { detachAt: Date.now() + INPUT_IDLE_DETACH_MS, pointer: { x: 120 + Math.random() * 200, y: 80 + Math.random() * 120 } });
    return cdpRaw(tabId, method, params);
  }
}

// cdpEval: evaluate a JavaScript expression/string in the page's MAIN world via CDP.
// Bypasses page CSP (Runtime.evaluate is a DevTools protocol command, not subject to CSP).
// Ensures the debugger is attached before evaluation.
// Returns the raw CDP result (with result, exceptionDetails, etc.).
async function cdpEval(tabId, expression) {
  await attachDebugger(tabId);
  return await cdp(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
}

// resolveCdpValue: handle CDP Runtime.evaluate results, resolving object references
// to JSON-serializable values when needed.
async function resolveCdpValue(tabId, result) {
  const value = result.result;
  if (value.type === "object" && value.value) {
    try {
      return JSON.parse(value.value);
    } catch {
      return value.value;
    }
  }
  return value.value;
}

// Resolve target -> {x, y, rect} in viewport coords by running tiny script in tab.
async function resolveTargetInTab(tabId, params) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: (selector, uid, x, y) => {
      const state = window.__PI_CHROME_STATE__;
      let el = null;
      if (uid && state && state.elements && state.elements[uid]) el = state.elements[uid];
      else if (selector) el = document.querySelector(selector);
      if (el) {
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, tag: el.tagName, found: true };
      }
      if (typeof x === "number" && typeof y === "number") return { x, y, rect: null, tag: null, found: true };
      return { found: false };
    },
    args: [params.selector ?? null, params.uid ?? null, params.x ?? null, params.y ?? null],
  });
  const v = results?.[0]?.result;
  if (!v || !v.found) throw new Error("Could not resolve target element for Chrome input");
  return v;
}

function pickInsideRect(rect) {
  if (!rect) return null;
  const insetX = Math.min(rect.width * 0.35, Math.max(2, rect.width / 2 - 1));
  const insetY = Math.min(rect.height * 0.35, Math.max(2, rect.height / 2 - 1));
  return {
    x: rect.left + rect.width / 2 + rng(-insetX, insetX),
    y: rect.top + rect.height / 2 + rng(-insetY, insetY),
  };
}

async function cdpMoveTo(tabId, x, y) {
  const entry = attachedTabs.get(tabId);
  const startX = entry?.pointer?.x ?? Math.max(20, Math.min(400, x - 200));
  const startY = entry?.pointer?.y ?? Math.max(20, Math.min(400, y - 200));
  const n = Math.max(18, Math.min(42, Math.round(Math.hypot(x - startX, y - startY) / 18)));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 8;
    const px = startX + (x - startX) * ease + rng(-wobble, wobble);
    const py = startY + (y - startY) * ease + rng(-wobble, wobble);
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: px, y: py, button: "none", buttons: 0, pointerType: "mouse",
    });
    await sleep(rng(5, 16));
  }
  if (entry) entry.pointer = { x, y };
}

function cdpModifiersFor(mods) {
  let m = 0;
  if (mods?.altKey) m |= 1;
  if (mods?.ctrlKey) m |= 2;
  if (mods?.metaKey) m |= 4;
  if (mods?.shiftKey) m |= 8;
  return m;
}

function cdpKeyInfo(key, shifted) {
  // Map common keys to CDP key event init fields. Returns { code, key, windowsVirtualKeyCode, text }.
  const SPECIAL = {
    Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Tab: { code: "Tab", windowsVirtualKeyCode: 9, text: "\t" },
    Backspace: { code: "Backspace", windowsVirtualKeyCode: 8, text: "" },
    Delete: { code: "Delete", windowsVirtualKeyCode: 46, text: "" },
    Escape: { code: "Escape", windowsVirtualKeyCode: 27, text: "" },
    ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37, text: "" },
    ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38, text: "" },
    ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39, text: "" },
    ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40, text: "" },
    Shift: { code: "ShiftLeft", windowsVirtualKeyCode: 16, text: "" },
    Control: { code: "ControlLeft", windowsVirtualKeyCode: 17, text: "" },
    Alt: { code: "AltLeft", windowsVirtualKeyCode: 18, text: "" },
    Meta: { code: "MetaLeft", windowsVirtualKeyCode: 91, text: "" },
    " ": { code: "Space", windowsVirtualKeyCode: 32, text: " " },
  };
  if (SPECIAL[key]) return { key, ...SPECIAL[key] };
  if (key.length === 1) {
    const ch = key;
    let code, vk;
    if (/^[a-zA-Z]$/.test(ch)) { code = `Key${ch.toUpperCase()}`; vk = ch.toUpperCase().charCodeAt(0); }
    else if (/^[0-9]$/.test(ch)) { code = `Digit${ch}`; vk = ch.charCodeAt(0); }
    else { code = ch; vk = ch.charCodeAt(0); }
    return { key: ch, code, windowsVirtualKeyCode: vk, text: ch };
  }
  return { key, code: key, windowsVirtualKeyCode: 0, text: "" };
}

async function cdpTypeChar(tabId, ch) {
  const needShift = /^[A-Z]$/.test(ch) || "~!@#$%^&*()_+{}|:\"<>?".includes(ch);
  let modifiers = 0;
  if (needShift) {
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 });
    modifiers = 8;
    await sleep(rng(8, 22));
  }
  const info = cdpKeyInfo(ch);
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown", key: info.key, code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode, nativeVirtualKeyCode: info.windowsVirtualKeyCode,
    text: info.text, unmodifiedText: info.text, modifiers,
  });
  await sleep(rng(25, 90));
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp", key: info.key, code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode, modifiers,
  });
  if (needShift) {
    await sleep(rng(5, 18));
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0 });
  }
  await sleep(rng(35, 130));
}

async function chromeInputClick(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  const resolved = await resolveTargetInTab(tab.id, params);
  const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
  await cdpMoveTo(tab.id, point.x, point.y);
  await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse", force: 0.5 });
  await sleep(rng(45, 140));
  await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
  // Reset :focus-visible if the click landed on a focusable element. CDP-driven pointer
  // focus can leave :focus-visible=true in Chromium, which trips heuristics that expect
  // Reset focus styling after pointer click when possible.
  if (params.selector || params.uid) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: "MAIN",
      func: (sel, uid) => {
        const state = window.__PI_CHROME_STATE__;
        let el = null;
        if (uid && state && state.elements && state.elements[uid]) el = state.elements[uid];
        else if (sel) el = document.querySelector(sel);
        if (el && typeof el.focus === "function" && el === document.activeElement) {
          try { el.blur(); el.focus({ preventScroll: true, focusVisible: false }); } catch {}
        }
      },
      args: [params.selector ?? null, params.uid ?? null],
    }).catch(() => undefined);
  }
  return { input: "chrome", x: point.x, y: point.y, tag: resolved.tag };
}

async function chromeInputHover(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  const resolved = await resolveTargetInTab(tab.id, params);
  const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
  await cdpMoveTo(tab.id, point.x, point.y);
  await sleep(rng(80, 220));
  return { input: "chrome", x: point.x, y: point.y, tag: resolved.tag };
}

async function chromeInputKey(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  const key = String(params.key || "");
  if (!key) throw new Error("chrome.key: missing key");
  const mods = params.modifiers || {};
  const modBits = cdpModifiersFor(mods);
  // Press modifiers in standard order, then key, then release in reverse.
  const modOrder = [];
  if (mods.metaKey) modOrder.push({ key: "Meta", code: "MetaLeft", vk: 91 });
  if (mods.ctrlKey) modOrder.push({ key: "Control", code: "ControlLeft", vk: 17 });
  if (mods.altKey) modOrder.push({ key: "Alt", code: "AltLeft", vk: 18 });
  if (mods.shiftKey) modOrder.push({ key: "Shift", code: "ShiftLeft", vk: 16 });
  for (const m of modOrder) {
    await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers: modBits });
    await sleep(rng(6, 18));
  }
  const info = cdpKeyInfo(key);
  // When modifiers are active, browsers usually emit "rawKeyDown" (no text) so chords like Cmd+V don't insert the literal char.
  const downType = modBits ? "rawKeyDown" : "keyDown";
  await cdp(tab.id, "Input.dispatchKeyEvent", {
    type: downType, key: info.key, code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode, nativeVirtualKeyCode: info.windowsVirtualKeyCode,
    text: modBits ? "" : info.text, unmodifiedText: modBits ? "" : info.text, modifiers: modBits,
  });
  await sleep(rng(25, 90));
  await cdp(tab.id, "Input.dispatchKeyEvent", {
    type: "keyUp", key: info.key, code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode, modifiers: modBits,
  });
  for (const m of modOrder.reverse()) {
    await sleep(rng(5, 18));
    await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers: 0 });
  }
  return { input: "chrome", key: info.key, modifiers: mods };
}

async function chromeInputType(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  if (params.selector || params.uid) {
    // Focus target by clicking it first.
    const resolved = await resolveTargetInTab(tab.id, params);
    const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
    await cdpMoveTo(tab.id, point.x, point.y);
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse", force: 0.5 });
    await sleep(rng(45, 110));
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
    await sleep(rng(50, 120));
  }
  const text = String(params.text || "");
  for (const ch of Array.from(text)) await cdpTypeChar(tab.id, ch);
  if (params.pressEnter) {
    await cdpTypeChar(tab.id, "\r").catch(() => undefined);
    await chromeInputKey({ ...params, key: "Enter" });
  }
  return { input: "chrome", length: text.length };
}

async function chromeInputFill(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  if (!(params.selector || params.uid)) throw new Error("chrome.fill: selector or uid required");
  const resolved = await resolveTargetInTab(tab.id, params);
  const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
  await cdpMoveTo(tab.id, point.x, point.y);
  // Triple-click selects all in input fields.
  for (let i = 1; i <= 3; i++) {
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: i, pointerType: "mouse", force: 0.5 });
    await sleep(rng(20, 60));
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: i, pointerType: "mouse" });
    await sleep(rng(20, 60));
  }
  // Delete selection.
  await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
  await sleep(rng(20, 60));
  const text = String(params.text || "");
  for (const ch of Array.from(text)) await cdpTypeChar(tab.id, ch);
  if (params.submit) await chromeInputKey({ ...params, key: "Enter" });
  return { input: "chrome", length: text.length };
}

async function chromeInputScroll(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  const resolved = (params.selector || params.uid) ? await resolveTargetInTab(tab.id, params) : { x: 100, y: 100, rect: null };
  const x = resolved.rect ? resolved.rect.left + Math.min(resolved.rect.width, 800) / 2 : resolved.x;
  const y = resolved.rect ? resolved.rect.top + Math.min(resolved.rect.height, 600) / 2 : resolved.y;
  const totalY = params.deltaY || 0, totalX = params.deltaX || 0;
  // Profile mimics a trackpad flick: short ramp-up (~15% of events), then geometric decay
  // with a ~12% drop per event. Gives momentum tail tests something to find, and the small
  // tail deltas (a handful of <20px events) put IntersectionObserver thresholds in range.
  const peak = Math.max(Math.abs(totalY), Math.abs(totalX));
  // Aim peak event ~22px so cumulative wheel approach to target seeds low-ratio IO samples.
  const PEAK_TARGET = 22;
  const w = [];
  // Build weights for an arbitrary n, then iterate to find an n where peak * (w_peak/sum) <= PEAK_TARGET.
  function build(n) {
    const arr = [];
    const peakIdx = Math.max(1, Math.floor(n * 0.15));
    for (let i = 0; i < n; i++) {
      if (i <= peakIdx) arr.push(0.5 + 0.5 * (i / peakIdx)); // 0.5 → 1.0
      else arr.push(Math.pow(0.88, i - peakIdx));            // ~12% drop per step
    }
    return arr;
  }
  let n = Math.max(12, params.steps || 24);
  for (let attempt = 0; attempt < 8; attempt++) {
    const arr = build(n);
    const s = arr.reduce((a, b) => a + b, 0);
    const peakStep = peak * (Math.max(...arr) / s);
    if (peakStep <= PEAK_TARGET || n >= 240) {
      w.length = 0;
      w.push(...arr);
      break;
    }
    n = Math.ceil(n * 1.4);
  }
  if (w.length === 0) w.push(...build(n));
  const sumW = w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n; i++) {
    const dy = totalY * (w[i] / sumW), dx = totalX * (w[i] / sumW);
    await cdp(tab.id, "Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, deltaX: dx, deltaY: dy, pointerType: "mouse",
    });
    // Sleep one+ frame so IntersectionObserver / rAF samples can run between events.
    await sleep(rng(22, 48));
  }
  return { input: "chrome", deltaX: totalX, deltaY: totalY, steps: n };
}

async function chromeInputTap(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  const resolved = (params.selector || params.uid || (typeof params.x === "number" && typeof params.y === "number"))
    ? await resolveTargetInTab(tab.id, params)
    : null;
  if (!resolved || !resolved.found) throw new Error("chrome.tap: target not found");
  const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
  const tp = { x: point.x, y: point.y, radiusX: 8, radiusY: 8, rotationAngle: 0, force: 0.5, id: 1 };
  await cdp(tab.id, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [tp] });
  await sleep(rng(40, 110));
  await cdp(tab.id, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  return { input: "chrome", x: point.x, y: point.y, tag: resolved.tag };
}

async function chromeInputDrag(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  const from = await resolveTargetInTab(tab.id, { selector: params.fromSelector ?? null, uid: params.fromUid ?? null, x: params.fromX ?? null, y: params.fromY ?? null });
  const to = await resolveTargetInTab(tab.id, { selector: params.toSelector ?? null, uid: params.toUid ?? null, x: params.toX ?? null, y: params.toY ?? null });
  const fp = from.rect ? pickInsideRect(from.rect) : { x: from.x, y: from.y };
  const tp = to.rect ? pickInsideRect(to.rect) : { x: to.x, y: to.y };
  await cdpMoveTo(tab.id, fp.x, fp.y);
  await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: fp.x, y: fp.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse", force: 0.5 });
  await sleep(rng(60, 140));
  const steps = params.steps || 20;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 6;
    const x = fp.x + (tp.x - fp.x) * ease + rng(-wobble, wobble);
    const y = fp.y + (tp.y - fp.y) * ease + rng(-wobble, wobble);
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1, pointerType: "mouse" });
    await sleep(rng(10, 26));
  }
  await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: tp.x, y: tp.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
  return { input: "chrome", from: fp, to: tp, steps };
}

async function chromeInputUpload(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  if (!(params.selector || params.uid)) throw new Error("chrome.upload: selector or uid required");
  const paths = Array.isArray(params.paths) ? params.paths.map(String) : [];
  if (!paths.length) throw new Error("chrome.upload: no file paths provided");
  const expression = `(() => {
    const selector = ${JSON.stringify(params.selector ?? null)};
    const uid = ${JSON.stringify(params.uid ?? null)};
    const state = window.__PI_CHROME_STATE__;
    const el = uid && state && state.elements ? state.elements[uid] : (selector ? document.querySelector(selector) : null);
    if (!el || el.tagName !== "INPUT" || el.type !== "file") throw new Error("Target must be <input type=file>");
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return el;
  })()`;
  const evaluated = await cdp(tab.id, "Runtime.evaluate", { expression, objectGroup: "pi-chrome-upload", includeCommandLineAPI: false, returnByValue: false });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text || "Could not resolve file input");
  const objectId = evaluated.result?.objectId;
  if (!objectId) throw new Error("Could not resolve file input object");
  await cdp(tab.id, "DOM.enable", {}).catch(() => undefined);
  const requested = await cdp(tab.id, "DOM.requestNode", { objectId });
  if (!requested.nodeId) throw new Error("Could not resolve file input node");
  await cdp(tab.id, "DOM.setFileInputFiles", { nodeId: requested.nodeId, files: paths });
  await cdp(tab.id, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() { this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); return this.files ? this.files.length : 0; }`,
    returnByValue: true,
  }).catch(() => undefined);
  await cdp(tab.id, "Runtime.releaseObject", { objectId }).catch(() => undefined);
  return { input: "chrome", uploaded: paths.map((path) => ({ path })) };
}
// ===============================================================


function armKeepaliveAlarm() {
  chrome.alarms.create("pi-bridge-keepalive", { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "pi" });
  chrome.action.setBadgeBackgroundColor({ color: "#4f46e5" });
  armKeepaliveAlarm();
  void pollLoop();
});

chrome.runtime.onStartup.addListener(() => {
  armKeepaliveAlarm();
  void pollLoop();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pi-bridge-keepalive") void pollLoop();
});

chrome.action.onClicked.addListener(() => {
  armKeepaliveAlarm();
  void pollLoop();
});

armKeepaliveAlarm();

setInterval(() => {
  void pollLoop();
}, 1000);

async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    while (true) {
      const response = await fetch(`${BRIDGE_URL}/next?name=${encodeURIComponent(CLIENT_NAME)}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`bridge /next HTTP ${response.status}`);
      const expected = response.headers.get("x-pi-chrome-version");
      const ours = chrome.runtime.getManifest().version;
      if (expected && expected !== ours && isVersionOlder(ours, expected)) {
        console.warn(`[pi-chrome] extension v${ours} behind pi-chrome v${expected}; reloading extension`);
        try { chrome.runtime.reload(); } catch {}
        return;
      }
      const payload = await response.json();
      if (payload.type === "command") await handleCommand(payload.command);
    }
  } catch (error) {
    await sleep(POLL_ERROR_BACKOFF_MS);
  } finally {
    polling = false;
  }
}

async function handleCommand(command) {
  try {
    const result = await dispatch(command.action, command.params ?? {});
    await postResult({ id: command.id, ok: true, result });
  } catch (error) {
    await postResult({ id: command.id, ok: false, error: error?.message ?? String(error) });
  }
}

async function postResult(result) {
  await fetch(`${BRIDGE_URL}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
  });
}

function isVersionOlder(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

async function dispatch(action, params) {
  switch (action) {
    case "tab.version":
      return {
        extensionId: chrome.runtime.id,
        extensionVersion: chrome.runtime.getManifest().version,
        bridgeUrl: BRIDGE_URL,
        userAgent: navigator.userAgent,
      };
    case "tab.list":
      return (await chrome.tabs.query({})).map(formatTab);
    case "tab.new": {
      const tab = await chrome.tabs.create({ url: params.url || "about:blank", active: true });
      return formatTab(tab);
    }
    case "tab.activate": {
      const tab = await getTabByParams(params);
      await chrome.windows.update(tab.windowId, { focused: true });
      return formatTab(await chrome.tabs.update(tab.id, { active: true }));
    }
    case "tab.close": {
      const tab = await getTabByParams(params);
      await chrome.tabs.remove(tab.id);
      return { closed: tab.id };
    }
    case "page.snapshot":
      return executeInTab(params, snapshotPage, [
        params.maxElements || 80,
        params.containingText ?? null,
        params.roleFilter ?? null,
        params.nearUid ?? null,
      ]);
    case "page.evaluate":
      return evaluateInTab(params);
    case "page.click":
      return withOptionalSnapshot(params, chromeInputClick);
    case "page.hover":
      return chromeInputHover(params);
    case "page.drag":
      return chromeInputDrag(params);
    case "page.upload":
      return chromeInputUpload(params);
    case "page.type":
      return withOptionalSnapshot(params, chromeInputType);
    case "page.fill":
      return withOptionalSnapshot(params, chromeInputFill);
    case "page.key":
      return withOptionalSnapshot(params, chromeInputKey);
    case "page.scroll":
      return chromeInputScroll(params);
    case "page.tap":
      return chromeInputTap(params);
    case "input.status":
      return inputStatus();
    case "input.debug":
      return inputDebug(params);
    case "page.console.list":
      return executeInTab(params, listConsoleMessages, [params.clear === true]);
    case "page.network.list":
      return executeInTab(params, listNetworkRequests, [params.includePreservedRequests === true, params.clear === true]);
    case "page.network.get":
      return executeInTab(params, getNetworkRequest, [params.requestId]);
    case "page.waitFor": {
      // Poll in the service worker using CDP (bypasses CSP). The old approach
      // ran a polling loop in the page with new Function() for expression checks,
      // which fails under strict CSP.
      const tab = await getTabByParams(params);
      if (params.foreground) await bringToFront(tab);
      const timeoutMs = params.timeoutMs || 10000;
      const intervalMs = params.intervalMs || 250;
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        let ok = false;
        if (params.kind === "selector") {
          const result = await evaluateInTab({ ...params, expression: `!!document.querySelector(${JSON.stringify(params.value)})`, foreground: false });
          ok = Boolean(result);
        } else {
          try {
            const result = await evaluateInTab({ ...params, expression: params.value, foreground: false });
            ok = Boolean(result);
          } catch { ok = false; }
        }
        if (ok) return { elapsedMs: Date.now() - started };
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${params.kind}: ${params.value}`);
    }
    case "page.probe":
      // Lightweight capability probe for /chrome-doctor. Runs in MAIN world.
      return executeInTab(params, probePage, []);
    case "page.navigate": {
      const tab = await getTabByParams(params);
      if (params.foreground) await bringToFront(tab);
      if (params.initScript) {
        // Register a one-shot document_start content script. We register, navigate, wait, then unregister.
        await registerInitScript(tab.id, params.initScript);
      }
      const wait = params.waitUntilLoad !== false ? waitForTabComplete(tab.id, params.timeoutMs || 15000) : Promise.resolve(undefined);
      const updated = await chrome.tabs.update(tab.id, { url: params.url });
      try {
        await wait;
      } finally {
        if (params.initScript) await unregisterInitScript(tab.id).catch(() => undefined);
      }
      return formatTab(await chrome.tabs.get(updated.id));
    }
    case "page.screenshot":
      return takeScreenshot(params);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

function formatTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    highlighted: tab.highlighted,
    title: tab.title || "",
    url: tab.url || "",
    status: tab.status,
    pinned: tab.pinned,
    incognito: tab.incognito,
  };
}

async function getTabByParams(params) {
  const tabs = await chrome.tabs.query({});
  let tab;
  if (params.targetId !== undefined) {
    const id = Number(params.targetId);
    tab = tabs.find((candidate) => candidate.id === id);
  } else if (params.urlIncludes) {
    tab = tabs.find((candidate) => (candidate.url || "").includes(params.urlIncludes));
  } else if (params.titleIncludes) {
    tab = tabs.find((candidate) => (candidate.title || "").includes(params.titleIncludes));
  } else {
    const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = active[0] || tabs.find((candidate) => candidate.active) || tabs[0];
  }
  if (!tab?.id) throw new Error("No matching Chrome tab found");
  if ((tab.url || "").startsWith("chrome://") || (tab.url || "").startsWith("chrome-extension://")) {
    throw new Error(`Chrome blocks extension automation on protected URL: ${tab.url}`);
  }
  return tab;
}

// Helper sources that get concatenated into the injected MAIN-world script. Kept as separate
// functions so callers below can reference them by `.toString()`. The helpers do not perform any
// eval themselves — they're plain function declarations.
const HELPER_FUNCS = [
  getPiChromeState,
  rememberElement,
  elementBySelectorOrUid,
  installPiChromeInstrumentation,
  resolvePoint,
  dispatchInputEvents,
  setNativeValue,
  normalizeKey,
  isElementVisible,
  occluderAt,
  pageHash,
  pointerEventSequence,
  sleepPage,
  rand,
  dispatchPointerLikeEvent,
  humanMoveTo,
  humanClickPoint,
  printableKeyCode,
  dispatchKeyEvent,
  typeCharacter,
  scrollPage,
];

async function executeInTab(params, func, args) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);

  // Phase 1: Define helper functions in the page via CDP (bypasses CSP).
  // Each helper is assigned to window.<name> so the action function (run via
  // executeScript) can reference them by name. We use Runtime.evaluate which
  // operates outside the page's CSP sandbox.
  const assignments = HELPER_FUNCS.map((helper) => {
    const src = helper.toString();
    // Extract function name from "function name(...) { ... }"
    const m = src.match(/^function\s+(\w+)/);
    const name = m ? m[1] : "helper";
    return `window.${name}=${src}`;
  }).join(";");
  // Wrap in async IIFE so awaitPromise: true works (Runtime.evaluate requires an expression).
  await cdpEval(tab.id, `(async()=>{${assignments}})()`);

  // Phase 2: Execute the action function via chrome.scripting.executeScript.
  // The func: parameter is serialized by Chrome's internal mechanism (not new Function),
  // so it works under strict CSP. The action references helper names that are now
  // available as globals in the page.
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: func,
    args: args || [],
  });

  const first = results?.[0];
  if (first?.error) {
    const message = typeof first.error === "string" ? first.error : (first.error.message || JSON.stringify(first.error));
    throw new Error(message);
  }
  return first?.result;
}

// Dedicated executor for page.evaluate. Uses CDP Runtime.evaluate which bypasses
// page CSP entirely (DevTools protocol is not subject to content security policy).
// This fixes the issue where strict CSP (script-src 'self' without 'unsafe-eval')
// would block new Function() / eval, causing chrome_evaluate to fail silently.
async function evaluateInTab(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  const expression = String(params.expression ?? "");
  const awaitPromise = params.awaitPromise !== false;

  // Use CDP Runtime.evaluate — bypasses page CSP entirely.
  // Runtime.evaluate is a DevTools protocol command that evaluates in the page context
  // regardless of the page's Content-Security-Policy.
  const cdpResult = await cdpEval(tab.id, expression);

  if (cdpResult.exceptionDetails) {
    throw new Error(cdpResult.exceptionDetails.text || "Evaluation failed");
  }

  const value = cdpResult.result;

  // Handle special value types that don't serialize through returnByValue
  if (value.type === "object" && value.objectId) {
    // Object reference — serialize it to JSON via callFunctionOn
    const jsonResult = await cdp(tab.id, "Runtime.callFunctionOn", {
      objectId: value.objectId,
      functionDeclaration: "function() { return JSON.stringify(this); }",
      returnByValue: true,
    });
    if (jsonResult.exceptionDetails) {
      return `[Object: unable to serialize]`;
    }
    try {
      return JSON.parse(jsonResult.result.value);
    } catch {
      return `[Object: ${jsonResult.result.value?.slice(0, 200)}]`;
    }
  }

  if (value.type === "object" && value.value !== undefined) {
    // Already materialized by returnByValue
    return value.value;
  }

  return value.value;
}

async function withOptionalSnapshot(params, actionFn) {
  const result = await actionFn(params);
  if (params.includeSnapshot) {
    const snapshot = await executeInTab({ ...params, foreground: false }, snapshotPage, [params.maxElements || 80, null, null, null]);
    return { result, snapshot };
  }
  return result;
}

// One-shot init script registry, scoped per tab. The script source is injected at
// document_start of the next committed navigation in that tab, in MAIN world, then cleared.
const initScriptIds = new Map();
async function registerInitScript(tabId, source) {
  initScriptIds.set(tabId, source);
}
async function unregisterInitScript(tabId) {
  initScriptIds.delete(tabId);
}

if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    const source = initScriptIds.get(details.tabId);
    if (!source) return;
    chrome.scripting.executeScript({
      target: { tabId: details.tabId, frameIds: [0] },
      world: "MAIN",
      injectImmediately: true,
      // Use code: instead of func: with new Function(). Chrome's code: injection
      // is NOT subject to page CSP (it's treated as extension script source).
      code: source + "\n",
    }).catch(() => undefined);
  });
}

// Always inject early console/network capture at document_start on every navigation.
// Catches console messages, errors, and network requests that fire during page load,
// before chrome_snapshot or chrome_evaluate install the instrumentation normally.
// The function installEarlyCapture sets __piChromeWrapped flags so the post-hoc
// installPiChromeInstrumentation() call is idempotent.
if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    chrome.scripting.executeScript({
      target: { tabId: details.tabId, frameIds: [0] },
      world: "MAIN",
      injectImmediately: true,
      func: installEarlyCapture,
      args: [],
    }).catch(() => undefined);
  });
}

async function bringToFront(tab) {
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for tab ${tabId} to load`));
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function takeScreenshot(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  let previousActiveId;
  if (!tab.active) {
    const activeBefore = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    previousActiveId = activeBefore[0]?.id;
    await chrome.tabs.update(tab.id, { active: true });
  }
  try {
    if (params.fullPage) {
      // Tile-stitched full page capture: scroll, capture, paste, repeat.
      const tiles = await executeInTab({ ...params, foreground: false }, captureFullPageTiles, []);
      // captureFullPageTiles only computes scroll positions / metrics; we capture per scroll here
      // (chrome.tabs.captureVisibleTab can't be called from MAIN world).
      const captured = [];
      for (const tile of tiles.tiles) {
        await executeInTab({ ...params, foreground: false }, scrollToY, [tile.scrollY]);
        // Small settle delay; many sites have on-scroll animations / lazy-load.
        await sleep(120);
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: params.format || "png",
          quality: params.format === "jpeg" ? params.quality : undefined,
        });
        captured.push({ y: tile.y, dataUrl });
      }
      await executeInTab({ ...params, foreground: false }, scrollToY, [tiles.originalScrollY]);
      return {
        fullPage: true,
        tab: formatTab(tab),
        dimensions: { width: tiles.width, height: tiles.height, viewportHeight: tiles.viewportHeight, dpr: tiles.dpr },
        tiles: captured,
      };
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: params.format || "png",
      quality: params.format === "jpeg" ? params.quality : undefined,
    });
    return { dataUrl, tab: formatTab(tab) };
  } finally {
    if (previousActiveId !== undefined && previousActiveId !== tab.id) {
      await chrome.tabs.update(previousActiveId, { active: true }).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// MAIN-world helpers (function declarations injected into the page).
// ---------------------------------------------------------------------------

function getPiChromeState() {
  const state = window.__PI_CHROME_STATE__ || {
    nextElementUid: 1,
    elements: {},
    console: [],
    network: [],
    nextRequestId: 1,
    instrumentationInstalled: false,
  };
  window.__PI_CHROME_STATE__ = state;
  return state;
}

function rememberElement(element) {
  const state = getPiChromeState();
  if (!element.__piChromeUid) element.__piChromeUid = "el-" + state.nextElementUid++;
  state.elements[element.__piChromeUid] = element;
  return element.__piChromeUid;
}

function elementBySelectorOrUid(selector, uid) {
  if (uid) {
    const element = getPiChromeState().elements[uid];
    if (!element || !element.isConnected) throw new Error(`No live element for uid: ${uid}. Take a fresh chrome_snapshot.`);
    return element;
  }
  if (selector) {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`No element matches selector: ${selector}`);
    return element;
  }
  return null;
}

function isElementVisible(element) {
  if (!element || !element.getBoundingClientRect) return false;
  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none") return false;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  if (rect.bottom < 0 || rect.right < 0) return false;
  if (rect.top > innerHeight || rect.left > innerWidth) return false;
  return true;
}

function occluderAt(x, y, expected) {
  const top = document.elementFromPoint(x, y);
  if (!top || top === expected) return null;
  if (expected && expected.contains(top)) return null;
  if (top.contains(expected)) return null;
  return {
    tag: top.tagName.toLowerCase(),
    id: top.id || undefined,
    className: typeof top.className === "string" ? top.className : undefined,
  };
}

function pageHash() {
  // Cheap rolling hash used for `pageMutated`. Combines first 4kb of body innerText with the
  // current values of inputs/textareas (which are not part of innerText) and the count of
  // descendants of <body>. This catches: text changes, input value edits, and DOM structure
  // changes — the three things a click/type/fill might cause.
  const body = document.body;
  const text = (body ? body.innerText : "").slice(0, 4000);
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  if (body) {
    const inputs = body.querySelectorAll("input,textarea,select");
    let valueBlob = "";
    for (let i = 0; i < inputs.length && valueBlob.length < 4000; i++) {
      const v = inputs[i].value;
      if (typeof v === "string") valueBlob += v + "\x00";
    }
    for (let i = 0; i < valueBlob.length; i++) h = (h * 31 + valueBlob.charCodeAt(i)) | 0;
    h = (h * 31 + body.getElementsByTagName("*").length) | 0;
  }
  return h;
}

function sleepPage(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function dispatchPointerLikeEvent(element, type, x, y, prevX, prevY, opts = {}) {
  const isPointer = type.startsWith("pointer");
  const Ctor = isPointer ? PointerEvent : MouseEvent;
  const isMove = type === "pointermove" || type === "mousemove";
  const isUpOrClick = type === "pointerup" || type === "mouseup" || type === "click";
  const init = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x + (window.screenX || 0),
    screenY: y + (window.screenY || 0),
    movementX: Number.isFinite(prevX) ? x - prevX : 0,
    movementY: Number.isFinite(prevY) ? y - prevY : 0,
    button: 0,
    buttons: isMove || isUpOrClick ? 0 : 1,
  };
  if (isPointer) {
    init.pointerType = "mouse";
    init.pointerId = 1;
    init.isPrimary = true;
    init.width = 1;
    init.height = 1;
    init.pressure = opts.pressure ?? (type === "pointerdown" ? 0.5 : 0);
    init.tangentialPressure = 0;
    init.tiltX = 0;
    init.tiltY = 0;
  }
  const ev = new Ctor(type, init);
  element.dispatchEvent(ev);
  return ev.defaultPrevented;
}

function pointerEventSequence(element, x, y, sequence) {
  let defaultPrevented = false;
  const state = getPiChromeState();
  const prevX = state.pointer?.x;
  const prevY = state.pointer?.y;
  for (const type of sequence) {
    defaultPrevented = dispatchPointerLikeEvent(element, type, x, y, prevX, prevY) || defaultPrevented;
  }
  state.pointer = { x, y, t: performance.now() };
  return defaultPrevented;
}

async function humanMoveTo(x, y, steps) {
  const state = getPiChromeState();
  const startX = Number.isFinite(state.pointer?.x) ? state.pointer.x : rand(12, Math.max(24, innerWidth - 12));
  const startY = Number.isFinite(state.pointer?.y) ? state.pointer.y : rand(12, Math.max(24, innerHeight - 12));
  const n = steps || Math.max(12, Math.min(42, Math.round(Math.hypot(x - startX, y - startY) / 18)));
  let prevX = startX, prevY = startY;
  let defaultPrevented = false;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 8;
    const px = startX + (x - startX) * ease + rand(-wobble, wobble);
    const py = startY + (y - startY) * ease + rand(-wobble, wobble);
    const el = document.elementFromPoint(px, py) || document.body || document.documentElement;
    defaultPrevented = dispatchPointerLikeEvent(el, "pointermove", px, py, prevX, prevY) || defaultPrevented;
    defaultPrevented = dispatchPointerLikeEvent(el, "mousemove", px, py, prevX, prevY) || defaultPrevented;
    prevX = px; prevY = py;
    await sleepPage(rand(4, 18));
  }
  state.pointer = { x, y, t: performance.now() };
  return defaultPrevented;
}

function humanClickPoint(point) {
  if (!point.rect) return { x: point.x, y: point.y };
  const rect = point.rect;
  const insetX = Math.min(rect.width * 0.35, Math.max(2, rect.width / 2 - 1));
  const insetY = Math.min(rect.height * 0.35, Math.max(2, rect.height / 2 - 1));
  return {
    x: rect.left + rect.width / 2 + rand(-insetX, insetX),
    y: rect.top + rect.height / 2 + rand(-insetY, insetY),
  };
}

function installPiChromeInstrumentation() {
  const state = getPiChromeState();
  if (state.instrumentationInstalled) return;
  state.instrumentationInstalled = true;
  const pushConsole = (level, args) => {
    state.console.push({
      id: state.console.length + 1,
      level,
      timestamp: Date.now(),
      url: location.href,
      args: Array.from(args).map((arg) => {
        try {
          if (typeof arg === "string") return arg;
          if (arg instanceof Error) return { name: arg.name, message: arg.message, stack: arg.stack };
          return JSON.parse(JSON.stringify(arg));
        } catch {
          return String(arg);
        }
      }),
    });
    if (state.console.length > 500) state.console.splice(0, state.console.length - 500);
  };
  for (const level of ["debug", "log", "info", "warn", "error"]){
    const original = console[level];
    if (typeof original !== "function" || original.__piChromeWrapped) continue;
    const wrapped = function(...args) {
      pushConsole(level, args);
      return original.apply(this, args);
    };
    wrapped.__piChromeWrapped = true;
    console[level] = wrapped;
  }
  window.addEventListener("error", (event) => pushConsole("pageerror", [event.message, event.filename + ":" + event.lineno + ":" + event.colno]));
  window.addEventListener("unhandledrejection", (event) => pushConsole("unhandledrejection", [event.reason]));

  const trimBody = (text) => typeof text === "string" && text.length > 200000 ? text.slice(0, 200000) + `\n[truncated ${text.length - 200000} chars]` : text;
  const record = (entry) => {
    state.network.push(entry);
    if (state.network.length > 1000) state.network.splice(0, state.network.length - 1000);
    return entry;
  };
  if (window.fetch && !window.fetch.__piChromeWrapped) {
    const originalFetch = window.fetch.bind(window);
    const wrappedFetch = async (...args) => {
      const id = "req-" + state.nextRequestId++;
      const startedAt = Date.now();
      const input = args[0];
      const init = args[1] || {};
      const url = typeof input === "string" ? input : input?.url;
      const method = (init.method || input?.method || "GET").toUpperCase();
      const entry = record({ id, type: "fetch", method, url: String(url || ""), startedAt, pageUrl: location.href, status: "pending" });
      try {
        const response = await originalFetch(...args);
        entry.status = response.status;
        entry.statusText = response.statusText;
        entry.ok = response.ok;
        entry.responseUrl = response.url;
        entry.durationMs = Date.now() - startedAt;
        entry.responseHeaders = Array.from(response.headers.entries());
        response.clone().text().then((text) => {
          entry.responseBody = trimBody(text);
          entry.responseBodyTruncated = typeof text === "string" && text.length > 200000;
        }).catch((error) => { entry.responseBodyError = error?.message || String(error); });
        return response;
      } catch (error) {
        entry.error = error?.message || String(error);
        entry.durationMs = Date.now() - startedAt;
        throw error;
      }
    };
    wrappedFetch.__piChromeWrapped = true;
    window.fetch = wrappedFetch;
  }
  if (window.XMLHttpRequest && !XMLHttpRequest.prototype.open.__piChromeWrapped) {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__piChromeRequest = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
      return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.open.__piChromeWrapped = true;
    XMLHttpRequest.prototype.send = function(body) {
      const id = "req-" + state.nextRequestId++;
      const startedAt = Date.now();
      const info = this.__piChromeRequest || {};
      const entry = record({ id, type: "xhr", method: info.method || "GET", url: info.url || "", startedAt, pageUrl: location.href, status: "pending" });
      this.addEventListener("loadend", () => {
        entry.status = this.status;
        entry.statusText = this.statusText;
        entry.responseUrl = this.responseURL;
        entry.durationMs = Date.now() - startedAt;
        try { entry.responseHeadersText = this.getAllResponseHeaders(); } catch {}
        try {
          if (typeof this.responseText === "string") {
            entry.responseBody = trimBody(this.responseText);
            entry.responseBodyTruncated = this.responseText.length > 200000;
          }
        } catch (error) { entry.responseBodyError = error?.message || String(error); }
      });
      this.addEventListener("error", () => { entry.error = "XMLHttpRequest error"; entry.durationMs = Date.now() - startedAt; });
      return originalSend.call(this, body);
    };
  }
}

// Early-capture version of installPiChromeInstrumentation, designed to be injected
// at document_start via webNavigation.onCommitted. Wraps console, fetch, and XHR
// before the page's own JavaScript runs, so page-load errors are captured.
// Sets __piChromeWrapped flags so the post-hoc installPiChromeInstrumentation()
// sees them and skips (idempotent).
// NOTE: This function is self-contained — it does NOT close over any outer scope
// because it gets serialized by chrome.scripting.executeScript({func: ...}).
function installEarlyCapture() {
  if (window.__piChromeEarlyCaptureInstalled) return;
  window.__piChromeEarlyCaptureInstalled = true;
  var state = window.__PI_CHROME_STATE__;
  if (!state) {
    state = {
      nextElementUid: 1,
      elements: {},
      console: [],
      network: [],
      nextRequestId: 1,
      instrumentationInstalled: false,
    };
    window.__PI_CHROME_STATE__ = state;
  }
  function pushConsole(level, args) {
    state.console.push({
      id: state.console.length + 1,
      level: level,
      timestamp: Date.now(),
      url: location.href,
      args: Array.from(args).map(function(arg) {
        try {
          if (typeof arg === "string") return arg;
          if (arg instanceof Error) return { name: arg.name, message: arg.message, stack: arg.stack };
          return JSON.parse(JSON.stringify(arg));
        } catch (e) {
          return String(arg);
        }
      }),
    });
    if (state.console.length > 500) state.console.splice(0, state.console.length - 500);
  }
  for (var i = 0; i < 5; i++) {
    var levels = ["debug", "log", "info", "warn", "error"];
    var level = levels[i];
    var original = console[level];
    if (typeof original !== "function" || original.__piChromeWrapped) continue;
    var wrapped = function(lvl, orig) {
      return function() {
        pushConsole(lvl, arguments);
        return orig.apply(this, arguments);
      };
    }(level, original);
    wrapped.__piChromeWrapped = true;
    console[level] = wrapped;
  }
  window.addEventListener("error", function(event) {
    pushConsole("pageerror", [event.message, event.filename + ":" + event.lineno + ":" + event.colno]);
  });
  window.addEventListener("unhandledrejection", function(event) {
    pushConsole("unhandledrejection", [event.reason]);
  });
  var trimBody = function(text) {
    return typeof text === "string" && text.length > 200000 ? text.slice(0, 200000) + "\n[truncated " + (text.length - 200000) + " chars]" : text;
  };
  var record = function(entry) {
    state.network.push(entry);
    if (state.network.length > 1000) state.network.splice(0, state.network.length - 1000);
    return entry;
  };
  if (window.fetch && !window.fetch.__piChromeWrapped) {
    var originalFetch = window.fetch.bind(window);
    var wrappedFetch = async function() {
      var args = [];
      for (var k = 0; k < arguments.length; k++) args.push(arguments[k]);
      var id = "req-" + state.nextRequestId++;
      var startedAt = Date.now();
      var input = args[0];
      var init = args[1] || {};
      var url = typeof input === "string" ? input : (input ? input.url : "");
      var method = (init.method || (input ? input.method : null) || "GET").toUpperCase();
      var entry = record({ id: id, type: "fetch", method: method, url: String(url || ""), startedAt: startedAt, pageUrl: location.href, status: "pending" });
      try {
        var response = await originalFetch.apply(window, args);
        entry.status = response.status;
        entry.statusText = response.statusText;
        entry.ok = response.ok;
        entry.responseUrl = response.url;
        entry.durationMs = Date.now() - startedAt;
        entry.responseHeaders = Array.from(response.headers.entries());
        response.clone().text().then(function(text) {
          entry.responseBody = trimBody(text);
          entry.responseBodyTruncated = typeof text === "string" && text.length > 200000;
        }).catch(function(error) { entry.responseBodyError = error ? error.message : String(error); });
        return response;
      } catch (error) {
        entry.error = error ? error.message : String(error);
        entry.durationMs = Date.now() - startedAt;
        throw error;
      }
    };
    wrappedFetch.__piChromeWrapped = true;
    window.fetch = wrappedFetch;
  }
  if (window.XMLHttpRequest && !XMLHttpRequest.prototype.open.__piChromeWrapped) {
    var originalOpen = XMLHttpRequest.prototype.open;
    var originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__piChromeRequest = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.open.__piChromeWrapped = true;
    XMLHttpRequest.prototype.send = function(body) {
      var id = "req-" + state.nextRequestId++;
      var startedAt = Date.now();
      var info = this.__piChromeRequest || {};
      var entry = record({ id: id, type: "xhr", method: info.method || "GET", url: info.url || "", startedAt: startedAt, pageUrl: location.href, status: "pending" });
      this.addEventListener("loadend", function() {
        entry.status = this.status;
        entry.statusText = this.statusText;
        entry.responseUrl = this.responseURL;
        entry.durationMs = Date.now() - startedAt;
        try { entry.responseHeadersText = this.getAllResponseHeaders(); } catch (e) {}
        try {
          if (typeof this.responseText === "string") {
            entry.responseBody = trimBody(this.responseText);
            entry.responseBodyTruncated = this.responseText.length > 200000;
          }
        } catch (error) { entry.responseBodyError = error ? error.message : String(error); }
      });
      this.addEventListener("error", function() { entry.error = "XMLHttpRequest error"; entry.durationMs = Date.now() - startedAt; });
      return originalSend.apply(this, arguments);
    };
  }
  state.instrumentationInstalled = true;
}

function snapshotPage(maxElements, containingText, roleFilter, nearUid) {
  installPiChromeInstrumentation();
  const unique = (selector) => {
    try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
  };
  const cssEscape = (value) => (window.CSS && CSS.escape) ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  const selectorFor = (element) => {
    if (element.id && unique("#" + cssEscape(element.id))) return "#" + cssEscape(element.id);
    const attr = ["aria-label", "name", "placeholder", "data-testid", "role"].find((name) => element.getAttribute(name));
    if (attr) {
      const candidate = element.tagName.toLowerCase() + "[" + attr + "=" + JSON.stringify(element.getAttribute(attr)) + "]";
      if (unique(candidate)) return candidate;
    }
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      if (current.classList.length > 0) part += "." + Array.from(current.classList).slice(0, 2).map(cssEscape).join(".");
      const siblings = Array.from(current.parentElement?.children ?? []).filter((sibling) => sibling.tagName === current.tagName);
      if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
      parts.unshift(part);
      const candidate = parts.join(" > ");
      if (unique(candidate)) return candidate;
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const visible = (element) => isElementVisible(element);
  const labelFor = (element) => (
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    element.getAttribute("placeholder") ||
    element.innerText ||
    element.value ||
    element.textContent ||
    ""
  ).trim().replace(/\s+/g, " ").slice(0, 160);
  let candidates = Array.from(document.querySelectorAll('a, button, input, textarea, select, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])'));
  if (containingText) {
    const needle = String(containingText).toLowerCase();
    candidates = candidates.filter((element) => labelFor(element).toLowerCase().includes(needle));
  }
  if (roleFilter) {
    const wanted = String(roleFilter).toLowerCase();
    candidates = candidates.filter((element) => {
      const role = (element.getAttribute("role") || element.tagName).toLowerCase();
      return role === wanted;
    });
  }
  let near;
  if (nearUid) {
    const state = getPiChromeState();
    near = state.elements[nearUid];
  }
  if (near) {
    const nearRect = near.getBoundingClientRect();
    const cx = nearRect.left + nearRect.width / 2;
    const cy = nearRect.top + nearRect.height / 2;
    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const da = Math.hypot(ra.left + ra.width / 2 - cx, ra.top + ra.height / 2 - cy);
      const db = Math.hypot(rb.left + rb.width / 2 - cx, rb.top + rb.height / 2 - cy);
      return da - db;
    });
  }
  const elements = candidates.filter(visible).slice(0, maxElements).map((element, index) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const occluded = occluderAt(cx, cy, element);
    return {
      index,
      uid: rememberElement(element),
      tag: element.tagName.toLowerCase(),
      selector: selectorFor(element),
      label: labelFor(element),
      href: element.href || undefined,
      type: element.getAttribute("type") || undefined,
      role: element.getAttribute("role") || undefined,
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      inert: Boolean(element.closest?.("[inert]")),
      pointerEvents: style.pointerEvents,
      occluded: occluded || undefined,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    };
  });
  return {
    title: document.title,
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    text: document.body ? document.body.innerText.replace(/\s+\n/g, "\n").trim().slice(0, 30000) : "",
    elements,
    filter: { containingText: containingText || undefined, roleFilter: roleFilter || undefined, nearUid: nearUid || undefined },
  };
}

function probePage() {
  // Sanity probe used by /chrome-doctor. Returns evidence that MAIN-world execution works.
  return {
    arithmetic: 1 + 1,
    location: location.href,
    title: document.title,
    documentReady: document.readyState,
    userAgent: navigator.userAgent.slice(0, 200),
    webdriver: !!navigator.webdriver,
  };
}

function captureFullPageTiles() {
  // Returns the *plan* for tile capture; the actual chrome.tabs.captureVisibleTab calls happen
  // in the SW. We just report the scroll positions and metrics.
  const html = document.documentElement;
  const body = document.body;
  const width = Math.max(html.scrollWidth, body ? body.scrollWidth : 0, innerWidth);
  const height = Math.max(html.scrollHeight, body ? body.scrollHeight : 0, innerHeight);
  const viewportHeight = innerHeight;
  const dpr = window.devicePixelRatio || 1;
  const originalScrollY = scrollY;
  const tiles = [];
  let y = 0;
  while (y < height) {
    tiles.push({ y, scrollY: y });
    y += viewportHeight;
  }
  return { width, height, viewportHeight, dpr, originalScrollY, tiles };
}

function scrollToY(y) {
  window.scrollTo({ top: y, left: 0, behavior: "instant" });
  return { scrollY };
}

function resolvePoint(selector, uid, x, y) {
  const element = elementBySelectorOrUid(selector, uid);
  if (element) {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = element.getBoundingClientRect();
    return { element, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect };
  }
  if (typeof x !== "number" || typeof y !== "number") throw new Error("Provide selector, uid, or x/y");
  return { element: document.elementFromPoint(x, y), x, y, rect: undefined };
}

async function clickPage(selector, uid, x, y) {
  installPiChromeInstrumentation();
  const before = pageHash();
  const point = resolvePoint(selector, uid, x, y);
  if (!point.element) throw new Error("No element at click point");
  const clickPoint = humanClickPoint(point);
  point.x = clickPoint.x;
  point.y = clickPoint.y;
  point.element = document.elementFromPoint(point.x, point.y) || point.element;
  const visible = isElementVisible(point.element);
  const occluded = occluderAt(point.x, point.y, point.element);
  let defaultPrevented = await humanMoveTo(point.x, point.y);
  const state = getPiChromeState();
  const prevX = state.pointer?.x;
  const prevY = state.pointer?.y;
  defaultPrevented = dispatchPointerLikeEvent(point.element, "pointerdown", point.x, point.y, prevX, prevY, { pressure: 0.5 }) || defaultPrevented;
  defaultPrevented = dispatchPointerLikeEvent(point.element, "mousedown", point.x, point.y, prevX, prevY) || defaultPrevented;
  if (typeof point.element.focus === "function" && /^(A|BUTTON|INPUT|TEXTAREA|SELECT|SUMMARY)$/.test(point.element.tagName)) {
    try { point.element.focus({ preventScroll: true }); } catch { try { point.element.focus(); } catch {} }
  }
  await sleepPage(rand(45, 140));
  defaultPrevented = dispatchPointerLikeEvent(point.element, "pointerup", point.x, point.y, prevX, prevY) || defaultPrevented;
  defaultPrevented = dispatchPointerLikeEvent(point.element, "mouseup", point.x, point.y, prevX, prevY) || defaultPrevented;
  defaultPrevented = dispatchPointerLikeEvent(point.element, "click", point.x, point.y, prevX, prevY) || defaultPrevented;
  state.pointer = { x: point.x, y: point.y, t: performance.now() };
  // Heuristic: if the clicked thing looks like a media play affordance and the page has paused
  // audio/video, the DOM-event click may not unlock autoplay. Surface a warning.
  let autoplayHint;
  const labelRaw = (point.element.getAttribute("aria-label") || point.element.textContent || "").trim();
  const label = labelRaw.toLowerCase();
  if (/^(play|start|begin|next|continue|unmute)/.test(label)) {
    const idleMedia = Array.from(document.querySelectorAll("audio,video")).some((m) => m.paused);
    if (idleMedia) autoplayHint = "This element looks like a media affordance and the page has paused media. DOM-event clicks do not satisfy user-activation gates; audio/video may not start.";
  }
  const pageMutated = pageHash() !== before;
  // Smart-auto retry hint: only set when DOM-event path produced no observable change AND the
  // element looks gated, OR the page just emitted a user-activation rejection. The dispatcher
  // uses this to decide whether to retry with Chrome input.
  let suggestChromeInput = false;
  let suggestReason;
  if (!pageMutated) {
    if (autoplayHint) { suggestChromeInput = true; suggestReason = "play/media affordance + idle media"; }
    else if (/copy(\s|$)|paste|share|download|fullscreen|sign in with|continue with|allow|enable/i.test(label)) {
      suggestChromeInput = true; suggestReason = `label '${labelRaw.slice(0, 40)}' looks gated`;
    } else {
      // Inspect recent console errors for activation-gate rejections.
      const recent = (state.console || []).slice(-8);
      const hit = recent.find((e) => /NotAllowedError|Document is not focused|requires transient activation|gesture is required/.test(
        (e.args || []).map((a) => typeof a === "string" ? a : (a && a.message) || JSON.stringify(a)).join(" ")
      ));
      if (hit) { suggestChromeInput = true; suggestReason = "recent console error indicates user-activation gate"; }
    }
  }
  return {
    x: point.x,
    y: point.y,
    selector,
    uid,
    tag: point.element.tagName,
    label: labelRaw.slice(0, 80) || undefined,
    input: "dom",
    defaultPrevented,
    elementVisible: visible,
    occludedBy: occluded || undefined,
    pageMutated,
    autoplayHint,
    suggestChromeInput: suggestChromeInput || undefined,
    suggestReason,
  };
}

async function hoverPage(selector, uid, x, y) {
  installPiChromeInstrumentation();
  const point = resolvePoint(selector, uid, x, y);
  if (!point.element) throw new Error("No element to hover");
  await humanMoveTo(point.x, point.y);
  const state = getPiChromeState();
  const prevX = state.pointer?.x, prevY = state.pointer?.y;
  let defaultPrevented = false;
  for (const type of ["pointerover", "mouseover", "pointerenter", "mouseenter"]) {
    defaultPrevented = dispatchPointerLikeEvent(point.element, type, point.x, point.y, prevX, prevY) || defaultPrevented;
  }
  // Small dwell so hover-intent handlers fire.
  await sleepPage(rand(80, 220));
  return { x: point.x, y: point.y, selector, uid, tag: point.element.tagName, defaultPrevented, input: "dom" };
}

async function dragPage(fromUid, fromSelector, fromX, fromY, toUid, toSelector, toX, toY, steps) {
  installPiChromeInstrumentation();
  const before = pageHash();
  const from = resolvePoint(fromSelector, fromUid, fromX, fromY);
  const to = resolvePoint(toSelector, toUid, toX, toY);
  if (!from.element) throw new Error("Drag source element not found");
  if (!to.element) throw new Error("Drag target element not found");
  // Move to source.
  await humanMoveTo(from.x, from.y);
  const state = getPiChromeState();
  let prevX = state.pointer?.x, prevY = state.pointer?.y;
  // Build a shared DataTransfer so HTML5 drag-and-drop handlers can populate / read it.
  const dt = new DataTransfer();
  const dragInit = (type, target, x, y) => {
    const ev = new DragEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y,
      screenX: x + (window.screenX || 0), screenY: y + (window.screenY || 0),
      button: 0, buttons: 1, view: window,
      dataTransfer: dt,
    });
    target.dispatchEvent(ev);
    return ev;
  };
  dispatchPointerLikeEvent(from.element, "pointerover", from.x, from.y, prevX, prevY);
  dispatchPointerLikeEvent(from.element, "pointerdown", from.x, from.y, prevX, prevY, { pressure: 0.5 });
  dispatchPointerLikeEvent(from.element, "mousedown", from.x, from.y, prevX, prevY);
  await sleepPage(rand(40, 110));
  dragInit("dragstart", from.element, from.x, from.y);
  dragInit("drag", from.element, from.x, from.y);
  let lastOver = from.element;
  const n = steps || 18;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 6;
    const x = from.x + (to.x - from.x) * ease + rand(-wobble, wobble);
    const y = from.y + (to.y - from.y) * ease + rand(-wobble, wobble);
    const overEl = document.elementFromPoint(x, y) || to.element;
    dispatchPointerLikeEvent(overEl, "pointermove", x, y, prevX, prevY);
    dispatchPointerLikeEvent(overEl, "mousemove", x, y, prevX, prevY);
    if (overEl !== lastOver) {
      dragInit("dragleave", lastOver, x, y);
      dragInit("dragenter", overEl, x, y);
      lastOver = overEl;
    }
    dragInit("dragover", overEl, x, y);
    dragInit("drag", from.element, x, y);
    prevX = x; prevY = y;
    await sleepPage(rand(8, 26));
  }
  dispatchPointerLikeEvent(to.element, "pointerover", to.x, to.y, prevX, prevY);
  dispatchPointerLikeEvent(to.element, "mouseover", to.x, to.y, prevX, prevY);
  dragInit("drop", to.element, to.x, to.y);
  dragInit("dragend", from.element, to.x, to.y);
  dispatchPointerLikeEvent(to.element, "pointerup", to.x, to.y, prevX, prevY);
  dispatchPointerLikeEvent(to.element, "mouseup", to.x, to.y, prevX, prevY);
  state.pointer = { x: to.x, y: to.y, t: performance.now() };
  return {
    from: { x: from.x, y: from.y },
    to: { x: to.x, y: to.y },
    steps: n,
    pageMutated: pageHash() !== before,
    note: "DOM-event drag with HTML5 DragEvent + shared DataTransfer.",
  };
}

async function scrollPage(selector, uid, deltaY, deltaX, steps) {
  installPiChromeInstrumentation();
  const before = pageHash();
  let target;
  if (selector || uid) {
    target = elementBySelectorOrUid(selector, uid);
  } else {
    target = document.scrollingElement || document.documentElement || document.body;
  }
  if (!target) throw new Error("No scroll target");
  const rect = target.getBoundingClientRect ? target.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
  const cx = Math.max(0, Math.min(innerWidth - 1, rect.left + Math.min(rect.width, innerWidth) / 2));
  const cy = Math.max(0, Math.min(innerHeight - 1, rect.top + Math.min(rect.height, innerHeight) / 2));
  const n = Math.max(3, Math.min(40, steps || Math.max(3, Math.ceil(Math.abs(deltaY || 0) / 100))));
  // Front-loaded wheel deltas, momentum-style.
  const totalY = deltaY || 0;
  const totalX = deltaX || 0;
  const weights = [];
  for (let i = 1; i <= n; i++) weights.push(1 / i);
  const sumW = weights.reduce((a, b) => a + b, 0);
  let movedY = 0, movedX = 0;
  for (let i = 0; i < n; i++) {
    const dy = totalY * (weights[i] / sumW);
    const dx = totalX * (weights[i] / sumW);
    const ev = new WheelEvent("wheel", {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: cx, clientY: cy,
      deltaX: dx, deltaY: dy, deltaMode: 0,
    });
    target.dispatchEvent(ev);
    if (!ev.defaultPrevented) {
      // Apply scroll ourselves; mirrors what the browser would do.
      if (target === document.scrollingElement || target === document.documentElement || target === document.body) {
        window.scrollBy({ left: dx, top: dy, behavior: "instant" });
      } else {
        target.scrollTop += dy;
        target.scrollLeft += dx;
      }
    }
    movedY += dy; movedX += dx;
    await sleepPage(rand(12, 28));
  }
  return {
    deltaX: movedX, deltaY: movedY, steps: n,
    scrollTop: target.scrollTop, scrollLeft: target.scrollLeft,
    pageMutated: pageHash() !== before,
    input: "dom",
  };
}

function uploadFiles(selector, uid, files) {
  installPiChromeInstrumentation();
  const element = elementBySelectorOrUid(selector, uid);
  if (!element || element.tagName !== "INPUT" || element.type !== "file") {
    throw new Error("Target must be <input type=file>");
  }
  const dt = new DataTransfer();
  for (const f of files) {
    const bytes = Uint8Array.from(atob(f.base64 || ""), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], f.name, { type: f.type || "application/octet-stream" }));
  }
  element.files = dt.files;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { uploaded: files.map((f) => ({ name: f.name, type: f.type, size: (f.base64 || "").length })) };
}

function dispatchInputEvents(element, data, inputType = "insertText") {
  element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data }));
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function setNativeValue(element, value) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) descriptor.set.call(element, value);
  else element.value = value;
}

function printableKeyCode(ch) {
  if (ch === " ") return 32;
  const upper = ch.toUpperCase();
  if (/^[A-Z]$/.test(upper)) return upper.charCodeAt(0);
  if (/^[0-9]$/.test(ch)) return ch.charCodeAt(0);
  return ch.charCodeAt(0) || 0;
}

function dispatchKeyEvent(element, type, key, mods = {}) {
  const code = key.length === 1 && /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` :
    key.length === 1 && /^[0-9]$/.test(key) ? `Digit${key}` :
    key === " " ? "Space" : key;
  const SPECIAL = { Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Escape: 27,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, " ": 32, Shift: 16, Control: 17, Alt: 18, Meta: 91 };
  const keyCode = key.length === 1 ? printableKeyCode(key) : (SPECIAL[key] ?? 0);
  const ev = new KeyboardEvent(type, {
    key,
    code,
    keyCode,
    which: keyCode,
    charCode: type === "keypress" && key.length === 1 ? key.charCodeAt(0) : 0,
    shiftKey: !!mods.shiftKey,
    ctrlKey: !!mods.ctrlKey,
    altKey: !!mods.altKey,
    metaKey: !!mods.metaKey,
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
  });
  element.dispatchEvent(ev);
  return ev;
}

async function typeCharacter(element, ch) {
  const needShift = ch.length === 1 && (/^[A-Z]$/.test(ch) || "~!@#$%^&*()_+{}|:\"<>?".includes(ch));
  if (needShift) {
    dispatchKeyEvent(element, "keydown", "Shift", { shiftKey: true });
    await sleepPage(rand(8, 24));
  }
  const mods = { shiftKey: needShift };
  const down = dispatchKeyEvent(element, "keydown", ch, mods);
  if (down.defaultPrevented) {
    if (needShift) dispatchKeyEvent(element, "keyup", "Shift", { shiftKey: false });
    return { defaultPrevented: true };
  }
  if (ch.length === 1) dispatchKeyEvent(element, "keypress", ch, mods);

  if (element.isContentEditable) {
    // execCommand("insertText") fires its own beforeinput + input. Don't double-dispatch.
    document.execCommand("insertText", false, ch);
  } else if ("value" in element) {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? element.value.length;
    const next = element.value.slice(0, start) + ch + element.value.slice(end);
    const before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: ch });
    element.dispatchEvent(before);
    if (!before.defaultPrevented) {
      setNativeValue(element, next);
      try { element.selectionStart = element.selectionEnd = start + ch.length; } catch {}
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
    }
  } else {
    throw new Error("Focused element is not text-editable");
  }

  await sleepPage(rand(25, 95));
  dispatchKeyEvent(element, "keyup", ch, mods);
  if (needShift) {
    await sleepPage(rand(5, 18));
    dispatchKeyEvent(element, "keyup", "Shift", { shiftKey: false });
  }
  await sleepPage(rand(35, 140));
  return { defaultPrevented: false };
}

async function typeIntoPage(selector, uid, text, pressEnter) {
  installPiChromeInstrumentation();
  const before = pageHash();
  let element = elementBySelectorOrUid(selector, uid) || document.activeElement;
  if (!element) throw new Error(selector || uid ? `No element for ${selector || uid}` : "No active element");
  const initialValue = "value" in element ? element.value : (element.isContentEditable ? element.textContent : null);
  element.focus();
  if (!(element.isContentEditable || "value" in element)) throw new Error("Focused element is not text-editable");
  for (const ch of Array.from(text)) await typeCharacter(element, ch);
  if (pressEnter) pressKeyInPage("Enter");
  const finalValue = "value" in element ? element.value : element.textContent;
  const valueMatches = "value" in element ? element.value.includes(text) : (element.textContent || "").includes(text);
  const pageMutated = pageHash() !== before;
  // Smart-auto retry hint when typing didn't land at all (e.g., editor blocks DOM-event input).
  let suggestChromeInput = false, suggestReason;
  if (text.length > 0 && initialValue === finalValue) {
    suggestChromeInput = true;
    suggestReason = "value did not change — editor likely rejects DOM-event input";
  }
  return {
    selector, uid, length: text.length, pressEnter,
    input: "dom",
    valueMatches,
    pageMutated,
    suggestChromeInput: suggestChromeInput || undefined,
    suggestReason,
  };
}

function fillPage(selector, uid, text, submit) {
  installPiChromeInstrumentation();
  const before = pageHash();
  let element = elementBySelectorOrUid(selector, uid) || document.activeElement;
  if (!element) throw new Error(selector || uid ? `No element for ${selector || uid}` : "No active element");
  element.focus();
  if (element.isContentEditable) {
    element.textContent = "";
    document.execCommand("insertText", false, text);
  } else if ("value" in element) {
    setNativeValue(element, text);
    const length = String(text).length;
    try { element.selectionStart = element.selectionEnd = length; } catch {}
    dispatchInputEvents(element, text, "insertReplacementText");
  } else {
    throw new Error("Focused element is not text-editable");
  }
  if (submit) pressKeyInPage("Enter");
  return {
    selector, uid, length: String(text).length, submit,
    input: "dom",
    valueMatches: "value" in element ? element.value === String(text) : undefined,
    pageMutated: pageHash() !== before,
  };
}

async function pressKeyInPage(key) {
  const normalized = normalizeKey(key);
  const target = document.activeElement || document.body;
  const before = pageHash();
  const down = dispatchKeyEvent(target, "keydown", normalized);
  if (normalized.length === 1) dispatchKeyEvent(target, "keypress", normalized);
  // Character insertion for printable keys when focus is in an editable.
  if (normalized.length === 1 && !down.defaultPrevented && (target.isContentEditable || ("value" in target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")))) {
    if (target.isContentEditable) {
      const bi = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: normalized });
      target.dispatchEvent(bi);
      if (!bi.defaultPrevented) {
        document.execCommand("insertText", false, normalized);
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: normalized }));
      }
    } else {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      const bi = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: normalized });
      target.dispatchEvent(bi);
      if (!bi.defaultPrevented) {
        setNativeValue(target, target.value.slice(0, start) + normalized + target.value.slice(end));
        try { target.selectionStart = target.selectionEnd = start + 1; } catch {}
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: normalized }));
      }
    }
  } else if (normalized === "Backspace" && "value" in target) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    if (start > 0 || end > start) {
      const from = start === end ? start - 1 : start;
      const bi = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward" });
      target.dispatchEvent(bi);
      if (!bi.defaultPrevented) {
        setNativeValue(target, target.value.slice(0, from) + target.value.slice(end));
        try { target.selectionStart = target.selectionEnd = from; } catch {}
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      }
    }
  }
  await sleepPage(rand(25, 95));
  const up = dispatchKeyEvent(target, "keyup", normalized);
  if (normalized === "Enter") {
    const form = target.closest?.("form");
    if (form) form.requestSubmit?.();
  }
  return {
    key: normalized,
    input: "dom",
    defaultPrevented: down.defaultPrevented || up.defaultPrevented,
    pageMutated: pageHash() !== before,
  };
}

function listConsoleMessages(clear) {
  installPiChromeInstrumentation();
  const state = getPiChromeState();
  const messages = state.console.slice();
  if (clear) state.console = [];
  return { messages, count: messages.length };
}

function listNetworkRequests(includePreservedRequests, clear) {
  installPiChromeInstrumentation();
  const state = getPiChromeState();
  const currentUrl = location.href;
  const requests = state.network
    .filter((request) => includePreservedRequests || request.pageUrl === currentUrl)
    .map(({ responseBody, ...summary }) => ({ ...summary, hasResponseBody: responseBody !== undefined }));
  if (clear) state.network = [];
  return { requests, count: requests.length, note: "Captures fetch/XHR after instrumentation is installed. Browser-initiated document/static asset requests are not captured." };
}

function getNetworkRequest(requestId) {
  installPiChromeInstrumentation();
  const request = getPiChromeState().network.find((entry) => entry.id === requestId);
  if (!request) throw new Error(`No network request with id ${requestId}`);
  return request;
}

function normalizeKey(key) {
  const table = {
    enter: "Enter",
    escape: "Escape",
    tab: "Tab",
    backspace: "Backspace",
    delete: "Delete",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
  };
  return table[String(key).toLowerCase()] || key;
}
