# pi-chrome FAQ

## Does this work with Brave / Arc / Edge / Vivaldi?

Yes. Any Chromium-based browser that supports unpacked extensions and the `chrome.debugger` API will work. The extension is named "Pi Chrome Connector" but the source is browser-agnostic. Firefox / WebKit are out of scope (different extension models).

## Will it slow my browser down?

The companion extension is idle when no Pi command is in flight. It uses Manifest V3 service worker activation, so it wakes for a request and goes back to sleep. No content script is injected globally.

## Does it work in Chrome incognito?

By default no — extensions need explicit "Allow in incognito" permission. Toggle it on `chrome://extensions` if you want pi-chrome to see incognito tabs. We don't recommend it for sensitive work.

## Will sites detect that I'm automating?

Interactive controls use Chrome's real input layer via CDP, so normal user-activation gates are satisfied and input is closer to real browser use than DOM-dispatched events. pi-chrome also shapes pointer/keyboard/scroll behavior, but this is not a guarantee of undetectability. Some detectors check for the `chrome.debugger` API attached, and Chrome will show the "Chrome is being debugged" banner.

The [`test-suite/`](../test-suite) grades browser-control behavior against common detection signals. Its `quality` bucket is adversarial signal, not a blanket promise that every site will treat automation as human.

## Why do I see a banner saying "Pi Chrome Connector started debugging this browser"?

That's Chrome's built-in warning when an extension uses `chrome.debugger`. pi-chrome uses Chrome's input layer for interactive controls, so the banner appears while attached.

## Can a malicious page escape and access my other tabs?

No — pages cannot directly talk to extensions. Commands flow agent → local bridge (`127.0.0.1:17318`) → extension → tab. The bridge binds to loopback only and rejects browser-origin command requests, so ordinary web pages cannot use CORS to drive it.

Chrome control is also locked per Pi session until you run `/chrome authorize`; `/chrome revoke` locks it again. The remaining risk surface is **other local processes running as you** that can connect to loopback and imitate Pi. If that's in your threat model, run pi-chrome in a separate OS user account.

## Can multiple Pi sessions use it at once?

Yes. The first session opens the local bridge; later sessions detect it and pipe their commands through the same bridge. Each Pi session must be authorized with `/chrome authorize` before its chrome_* tools work. Each session also owns its **own** dedicated automation window (ownership is keyed by session id inside the one extension), so concurrent sessions never navigate into or close each other's tabs.

Subagent sessions that run inside an authorized Pi process (for example with pi-subagents) also get the chrome_* tools. They share the parent's `/chrome authorize` grant and bridge, but each subagent gets its own automation tab and tab group, which are cleaned up when the subagent session ends.

## Does pi-chrome navigate my current tab?

No. The first chrome_* action that has no explicit target opens a **dedicated automation window** that pi-chrome owns (falling back to a dedicated tab only if a separate window can't be created), and reuses it for the rest of the session. Your existing tabs and windows are never reused or overwritten. Pass `targetId`/`urlIncludes`/`titleIncludes` to deliberately act on a tab you already have open.

The window survives `/reload` and Chrome service-worker restarts because ownership is tracked by id and mirrored to `chrome.storage.session`. It is closed when you run `/chrome revoke` and on real session end (not on `/reload`); cleanup only ever closes that session's own window/tab.

**After a full browser restart**, `chrome.storage.session` is cleared by Chrome. If Chrome's session-restore reopens the old automation window, pi-chrome no longer recognizes it (its tracking is gone), so it is left alone as an ordinary window — pi-chrome will open a fresh dedicated window for the new run rather than reclaim or close the restored one. pi-chrome never closes a window it can't positively identify as its own, so a user window is never at risk.

## Why ship as an unpacked extension?

pi-chrome ships as an unpacked extension so the source and broad browser permissions are easy to inspect and update with the npm package. The downside: you load it manually from `chrome://extensions` and reload it after package updates.

## What happens when I update pi-chrome?

`/chrome doctor` will warn you if the loaded extension is older than the installed `pi-chrome`. Reload it from `chrome://extensions` to pick up the new version. Updates that add Chrome permissions may require re-approval once.

## What's the install footprint?

- Pi side: one extension that registers 23 tools and a few slash commands.
- Chrome side: one unpacked extension, ~2000 LOC of plain JavaScript, no dependencies.

## Can I script it without Pi?

The Pi-facing tools are thin wrappers around an HTTP bridge at `127.0.0.1:17318`. You could call it directly from any process, but the API is internal and may change. If you need a stable scripting interface, file an issue and we'll consider stabilizing.

## What can humans do that pi-chrome cannot?

pi-chrome controls web pages through Chrome extension APIs, page inspection, screenshots, and browser input. It is not full OS-level human control. Known gaps include native Chrome/OS dialogs (print/save-as, some permission bubbles, password-manager prompts), arbitrary OS app interaction, visual CAPTCHA challenges, hardware-backed auth (passkeys/security keys/biometrics), rich multi-touch/pinch/stylus gestures, and DOM inspection inside cross-origin iframes. Some of these can still be handled with screenshot + coordinate input or user assistance, but they are not first-class deterministic workflows.

## Does `chrome_evaluate` work on strict-CSP pages?

Yes. `chrome_evaluate` and `chrome_snapshot` run in the page's MAIN world through CDP `Runtime.evaluate`, which is a DevTools protocol command and is **not** subject to the page's Content-Security-Policy. They work even on pages that block `'unsafe-eval'` (e.g. github.com and many bank/SaaS apps). `chrome_navigate`'s `initScript` injects at document_start via CDP and likewise bypasses CSP. `chrome_screenshot`, tab tools, and real Chrome input also keep working under any CSP.

## How do I tell whether a click or type worked?

Use `includeSnapshot=true` on `chrome_click`, `chrome_type`, `chrome_fill`, or `chrome_key`. The tool returns the Chrome-input result plus a fresh snapshot, so the agent can verify text, URL, visible elements, or form values before continuing.

If the page did not change, take a fresh snapshot or screenshot and check for overlays, disabled controls, stale element uids, or app-side validation.

## How do I attach a file to a React file input?

`chrome_upload_file` — uses Chrome DevTools file-input control and fires `input` + `change` events. It does **not** open the native file picker. Works with React/Vue/Angular controlled inputs.

## Can it record videos?

Not yet. Screenshots only. Video recording is on the roadmap.

## How do I file a good bug report?

Include `/chrome doctor` output, the exact tool call, and the result envelope. If the page is public, link to it; if private, distill it into a benchmark page under `test-suite/challenges/`. See [CONTRIBUTING.md](../CONTRIBUTING.md).
