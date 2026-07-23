# Changelog

All notable user-facing changes to `pi-chrome`.

## Unreleased

- **Reliable per-session cleanup.** Real session shutdown now waits briefly for Chrome cleanup before stopping the bridge, preventing fast terminal/workspace closes from discarding the queued cleanup command. Cleanup also closes every tab created by that Pi session while preserving existing user tabs and only removing those tabs from the Pi session group.

## 0.15.40 — 2026-06-22

- **Automation targets reuse the session tab group.** When `chrome_navigate` / implicit page actions create a new pi-chrome automation tab, it is now created in this session's existing tab-group window when possible and joins that same group, avoiding duplicate same-title `Pi Session: ...` groups.

## 0.15.39 — 2026-06-07

- **Dedicated automation tab/window (no more hijacking your active tab).** When a chrome_* action runs without an explicit target, pi-chrome now opens and reuses a dedicated automation window it owns (falling back to a dedicated tab if a separate window can't be created) instead of navigating whatever tab you currently have open. Your existing tabs/windows are left untouched. Pass `targetId`/`urlIncludes`/`titleIncludes` to act on a specific existing tab.
  - **Per session.** Ownership is scoped to the calling Pi session, so concurrent sessions sharing one companion extension each get their own automation window instead of fighting over a tab.
  - **Survives `/reload` and Chrome service-worker restarts.** Ownership is tracked by id and mirrored to `chrome.storage.session`, so the window is reused rather than orphaned.
  - **Guarded tab management.** `chrome_tab` `activate`/`close`/`group`/`ungroup` with no target now act on the session's automation tab if present, otherwise error — they no longer fall back to (or spawn a throwaway tab to touch) your active tab.
  - **Safe, non-blocking cleanup.** The owned target is closed on `/chrome revoke` and on real session end (never on `/reload`); cleanup only ever closes the calling session's own window/tab — never user tabs/windows or another session's target — and is fire-and-forget so it never blocks `/quit`, `/reload`, or session end.
- **One session, one tab group.** `chrome_tab new` now reuses this session's existing Pi tab group even when another Chrome window is focused, creating the tab in that group's window because Chrome tab groups cannot span windows. The old `group:false` / `groupTitle:""` opt-out is ignored; Pi-created tabs are never intentionally left ungrouped, and a grouping failure closes the just-created tab before returning an error.

## 0.15.38 — 2026-06-07

- **Overlay-safe click/fill fallbacks.** `chrome_click` and `chrome_fill` now fall back to DOM-dispatched click/value events when Chrome's debugger input path is blocked by another extension overlay (for example password-manager/autofill UI), unless `domFallback:false` is passed.

## 0.15.37 — 2026-06-07

- **Hardened Chrome input targeting.** `chrome_click`/`chrome_fill`/related input paths now fail fast with resolved tab/CDP target metadata when debugger attach hits a stale or protected target, instead of surfacing bare `chrome-extension://` errors or hanging until the bridge timeout.
- **Internal timeouts and cleanup.** Companion extension commands, debugger attach, CDP commands, and script injection now have shorter internal timeouts with debugger cleanup, so stuck input dispatch returns actionable errors before the 30s bridge timeout.
- **Clear stale uid errors.** Snapshot uids that no longer map to live elements now report `snapshot uid ... is stale; refresh chrome_snapshot`.
- **`chrome_fill` fallback.** If real CDP input is blocked by another extension overlay (for example password-manager/autofill UI), `chrome_fill` falls back to setting the field value through the page DOM and dispatching `input`/`change` events, unless `domFallback:false` is passed.

## 0.15.36 — 2026-06-03

- **Richer page observation.** `chrome_snapshot` now returns a concise, agent-friendly observation — structural layout/context, page hints, visible actions, form fields, a page map, query matches, and a diff of changes since the previous snapshot — instead of a raw JSON dump. New `mode` (`auto`/`interactive`/`forms`/`pageMap`/`text`/`changes`/`full`), `query`, and `maxTextChars` parameters let the agent zoom in instead of dumping the whole page.
- **New `chrome_find` tool.** Find elements, regions, or text by natural-language query (`'merge button'`, `'email error'`) and get ranked matches with stable uids and coordinates. Thin wrapper around `chrome_snapshot({ query })`.
- **New `chrome_inspect` tool.** Inspect one snapshot uid/selector deeply: nearby text, nearby actions, form context, ancestors, and a suggested click target. Falls back to a focused snapshot if the loaded extension predates `page.inspect`.
- **`includeSnapshot` now embeds the formatted snapshot.** `chrome_click`/`chrome_type`/`chrome_fill`/`chrome_key` with `includeSnapshot=true` append the fresh concise snapshot to the tool text so the agent can verify in one round trip.
- **Snapshot logic moved to a packaged `snapshot_injected.js`.** The MAIN-world snapshot/inspect implementation ships as an eval-free packaged script, shared `window.__PI_CHROME_STATE__` (same `el-` uid scheme) with the existing input helpers.

## 0.15.34 — 2026-06-01

- **Every tab Pi uses now joins the session group.** Previously only `chrome_tab new`/`group` created/used the `Pi Session: <name-or-id>` group; tabs Pi drove via `page.*` actions (navigate, click, type, snapshot, screenshot, etc.) on the existing/active tab stayed ungrouped. Now any ungrouped tab Pi interacts with is pulled into this session's group, so the user can see exactly which tabs Pi is driving. Tabs already in a group (the user's or another session's) are left untouched.
- **Fixed punctuation being dropped by `chrome_type`/`chrome_key`.** Printable punctuation derived its `code`/virtual-keyCode from `charCodeAt()`, so `.` mapped to keyCode 46 (VK_DELETE), `-` to 45 (VK_INSERT), shifted symbols to wrong codes, and `code` was the raw char (`"."`) instead of the physical key (`"Period"`). Apps with keydown handlers (e.g. Gmail's filter address field) saw a Delete/Insert key and silently rejected the character. Both the CDP and DOM-event input paths now resolve keys through a proper US-keyboard layout map.

## 0.15.33 — 2026-05-31

- **Background is now the default.** `chrome_*` tools run silently without focusing Chrome unless you opt in. Pass `background: false` per call, or run `/chrome background off`, to bring Chrome forward and watch. Tool/param descriptions and docs updated to match.

## 0.15.32 — 2026-05-31

- **Session tab-group naming tweak.** Per-session groups are now titled `Pi Session: <name-or-id>` (added a colon separator).

## 0.15.31 — 2026-05-31

Per-session tab groups.

- **Each Pi session gets its own tab group.** Auto-grouped tabs are now named `Pi Session <name>` using the session's display name, falling back to the session id when unnamed. Multiple Pi sessions driving the same Chrome no longer share one group — each collects its tabs separately. Pass an explicit `groupTitle` to override, or `group:false` / `groupTitle:""` on `action=new` to opt out.

## 0.15.30 — 2026-05-31

Tab grouping for `chrome_tab`.

- **Pi-opened tabs auto-group.** `action=new` now drops every tab into a shared `Pi` tab group per window by default (created once, then reused), so agent tabs stay visually separated from your own. Opt out per call with `groupTitle:""` or `group:false`.
- **`chrome_tab` can group/ungroup tabs.** New `action=group` (and `action=ungroup`) plus `groupTitle`/`groupColor` params. Grouping reuses an existing same-title group in the window instead of spawning duplicates. Defaults: title `Pi`, color `blue`; color validated against Chrome's 9 group colors. Target an existing tab with `targetId`/`urlIncludes`/`titleIncludes`.
- **Tab listings include group info.** `formatTab` now reports `groupId` and a `group` record (`title`, `color`, `collapsed`, `windowId`, `piGroup`), and `chrome_tab list` prefixes grouped tabs with `[Group Title]`.
- Requires the new `tabGroups` extension permission — reload the companion extension after updating.

## 0.15.29 — 2026-05-31

Strict-CSP support: `chrome_evaluate`, `chrome_snapshot`, `chrome_wait_for`, and `chrome_navigate initScript` now work on pages that block `unsafe-eval`.

- **CDP-based evaluation bypasses page CSP.** `chrome_evaluate`/`chrome_snapshot` (and all snapshot-driven inspection) previously ran user code in the page MAIN world via the **Function constructor**, which is blocked by `script-src 'self'` without `'unsafe-eval'` — so they returned null/empty (or `EvalError`) on github.com and many bank/SaaS apps. They now evaluate through CDP `Runtime.evaluate`, a DevTools protocol command that is not subject to the page's Content-Security-Policy. Rich return values (undefined/function/symbol/bigint/Error markers, DOMRect expansion) and the expression/statement fallback are preserved.
- **`chrome_wait_for` polls via CDP.** The selector/expression polling loop moved from in-page `new Function()` to service-worker-side CDP evaluation, so waits work under strict CSP too.
- **`chrome_navigate initScript` injects via CDP.** Document-start init scripts now register with `Page.addScriptToEvaluateOnNewDocument` instead of `new Function()` on `webNavigation.onCommitted`, so seeding localStorage / stubbing `Date.now` works under strict CSP.
- **Tests.** Added a Node unit harness (`test-suite/unit/csp-eval.test.mjs`, run via `npm test`) validating the evaluate/execute/waitFor refactor, and an in-browser regression challenge (42 `strict-csp-evaluate`) that reads a JS-only secret under strict CSP. Updated challenge 39's notes and docs (FAQ, EXAMPLES, COMPARISON, primer) which previously stated eval/snapshot fail under strict CSP.

## 0.15.28 — 2026-05-31

Low-risk reliability fixes from a long-session bug report.

- **Bridge self-heals when the owning session dies.** A Pi session running in shared-client mode used to fail every `chrome_*` call with a bare `fetch failed` once the session that owned `127.0.0.1:17318` exited. The client now detects the unreachable owner, takes over the bridge port, and re-runs the command locally instead of staying stuck.
- **Actionable timeout messages.** A 30s timeout now says *why*: extension not polling (not installed/closed), polling but didn't pick up the command, or picked it up but never returned a result (long-running action / failed result post) — instead of one generic message.
- **`chrome_type` / `chrome_fill` DOM path no longer throws `pressKeyInPage is not defined`.** The helper is now included in the injected MAIN-world helper set and its callers await it.
- **`getBoundingClientRect()` / DOMRect now serialize in `chrome_evaluate`.** DOMRect-like values return `{x,y,width,height,top,right,bottom,left}` instead of `{}`.
- **Clearer stale-target errors.** A missing `targetId` now lists the current tabs and suggests re-targeting via `chrome_tab list` or `urlIncludes`/`titleIncludes`, instead of a bare "No matching Chrome tab found".
- **`pageMutated=false` no longer reads as failure.** Click/type/fill summaries explain it's a coarse heuristic that can miss real effects, and suggest verifying with `includeSnapshot`.

## 0.15.26 — 2026-05-16

- **Documentation accuracy.** README, FAQ, examples, comparison, and test-suite docs now describe the 41-challenge suite, gate buckets, strict-CSP fallback, and current human-vs-extension limitations.
- **Published benchmark assets.** The npm package now includes `test-suite/` so the documented benchmark pages are available from installed packages, not only from the repository checkout.

## 0.15.25 — 2026-05-16

- **Reload after older installs.** `/reload` now recovers from stale singleton state left by pi-chrome 0.15.19 and earlier instead of skipping the freshly loaded extension.
- **Test suite coverage.** Added gate buckets plus strict-CSP fallback, dynamic wait readiness, and explicit tab lifecycle challenges.

## 0.15.24 — 2026-05-16

- **Unload Chrome tools on lock.** `chrome_*` tools now deactivate when `/chrome revoke` runs or timed authorization expires, keeping the prompt/tool list small after Chrome control locks again.

## 0.15.23 — 2026-05-16

- **Attribution.** The 0.15.22 features below are pulled from Dani Bednarski's fork (`DaniBedz/pi-chrome`). Thank you, Dani.

## 0.15.22 — 2026-05-16

Features in this release are pulled from Dani Bednarski's fork (`DaniBedz/pi-chrome`). Thank you, Dani.

- **Earlier page-load capture.** Companion extension now injects console/network instrumentation at `document_start`, so initial React render errors and early API calls show up in `chrome_list_console_messages` / `chrome_list_network_requests`.
- **Quieter locked state.** Startup no longer shows a persistent Chrome bridge notification/status item before authorization; status bar appears only when Chrome control is authorized.
- **Lazy tool registration.** `chrome_*` tools and primer are registered only after `/chrome authorize`, reducing prompt/tool overhead while Chrome control is locked.

## 0.15.21 — 2026-05-16

### Reverted 0.16.x and 0.17.x lines

- Versions 0.16.0 through 0.17.2 were published to npm and subsequently unpublished. 0.17.3 was prepared locally but never published. The work introduced in those versions — mandatory pairing, signed-envelope auth, standalone bridge daemon, idempotent onboard, etc. — is reachable only via git tags (`v0.16.0` … `v0.17.3`) and is not in the current main branch.
- This release is **tree-equivalent to 0.15.20** with a version-only bump so future patch releases can ship cleanly.

## 0.15.20 — 2026-05-15

- **Interruptible `chrome_*` tools.** All `chrome_*` tools now honor the agent harness `AbortSignal`, so pressing Esc aborts in-flight bridge calls (including the long-polling `chrome_wait_for`) immediately instead of waiting out the full `timeoutMs`.

## 0.15.19 — 2026-05-14

- **Simpler package description.** README hero and npm/pi.dev description now use the same concise authorization-focused sentence.

## 0.15.18 — 2026-05-14

- **Cleaner package description.** npm/pi.dev description now focuses on the existing Chrome profile and explicit authorization model, avoiding implementation details.

## 0.15.17 — 2026-05-14

- **Docs accuracy pass.** Updated README, FAQ, comparison, contributing notes, and package metadata for the current real-input-only, terminal-authorized tool surface.
- **Input verification fix.** `includeSnapshot=true` now works for `chrome_click`, `chrome_type`, `chrome_fill`, and `chrome_key`, returning the Chrome-input result plus a fresh snapshot.

## 0.15.16 — 2026-05-14

- **Visible `/chrome` loading state.** Bare `/chrome` and `/chrome status` now immediately say “Checking Chrome connection…” before probing the companion extension, so a slow Chrome bridge no longer looks like the command did nothing.

## 0.15.15 — 2026-05-14

- **Terminal authorization restored.** `/chrome authorize` is back to terminal-based confirmation. Removed the browser-side Chrome consent page and companion-extension consent polling.

## 0.15.14 — 2026-05-14

- **Clearer consent wait state.** After the Chrome approval page opens, Pi now says “Approve or deny the Chrome approval page to continue” instead of looking stuck at the launch step.

## 0.15.13 — 2026-05-14

- **Fix Chrome-side consent hang.** `/chrome authorize` now launches the browser consent page as a short command, then polls for the decision. This avoids holding one long extension command open while the user reads/clicks the page, which could leave Pi stuck at “Opening Chrome approval page…”.

## 0.15.12 — 2026-05-14

- **Docs accuracy.** Clarified that the bundled Chrome extension currently polls `127.0.0.1:17318`; custom bridge ports are not supported without editing/reloading the extension source. Also softened the unpacked-extension rationale to avoid overstating Web Store limitations and fixed stale strict-CSP guidance for `chrome_evaluate`.

## 0.15.11 — 2026-05-14

- **README cleanup.** Removed the Playwright/CDP/Selenium comparison table and low-signal Composes with / Contributing sections from the package page because they are noisy and easy to drift.

## 0.15.10 — 2026-05-14

- **Browser-side Chrome consent.** `/chrome authorize` now opens a Pi Chrome Connector approval page inside Chrome showing duration, workspace, process id, and extension/package versions. Chrome control unlocks only after the user approves there; denying, closing the tab, or timeout leaves control locked.
- **README cleanup.** Removed npm/download/license shield badges from the package page because they are noisy and easy to drift.

## 0.15.9 — 2026-05-14

- **Tighter `/chrome` menu.** Removed the redundant “Connection status” item from the interactive `/chrome` menu because connection/auth/background are already shown in the menu header. `/chrome status` remains available as a slash command.

## 0.15.8 — 2026-05-14

- **Simpler `/chrome` submenus.** Authorize menu now offers 15 minutes, 30 minutes, indefinite, and custom minutes only. Background menu now offers only foreground/background. Esc from a submenu returns to the main `/chrome` menu.

## 0.15.7 — 2026-05-14

- **Grouped `/chrome` menu.** Bare `/chrome` now opens a status dashboard with grouped actions: authorize, lock, status, doctor, background/watch mode, and onboard. Authorize/background open submenus instead of showing one flat command list.

## 0.15.6 — 2026-05-14

- **Bare `/chrome` is now a command menu.** Running `/chrome` shows interactive options for every `/chrome ...` command, including authorize/revoke/status/doctor/onboard/background variants.

## 0.15.5 — 2026-05-14

- **Chrome control authorization.** `chrome_*` tools are locked until the user runs `/chrome authorize` in the current Pi session. Grants can be one command, 15 minutes, 1 hour, or the session; `/chrome revoke` locks control again and `/chrome status` shows auth state.
- **Browser-origin bridge hardening.** The loopback bridge no longer sends wildcard CORS headers. `/command` accepts only local-process requests, while extension polling/result endpoints reject non-extension browser origins, blocking ordinary web pages from driving or draining the bridge through `127.0.0.1`.

## 0.15.4 — 2026-05-14

- **Quiet renamed to background.** Public UX now uses `/chrome background [on|off|toggle|status]` and docs/status say “run in background” instead of “quiet mode”.

## 0.15.3 — 2026-05-14

- **Chrome real input only.** Public trusted/synthetic mode controls were removed. Interactive tools now always use Chrome's real input layer; `/chrome clicks` and public `trusted` parameters are gone.

## 0.15.2 — 2026-05-13

- **Recipe prompts rewritten in user-language.** Earlier recipes leaked tool names into the `You:` prompts ("Use `chrome_tab list` to find my GitHub notifications tab…"), implying users need to know the tool catalog before they can ask anything. Prompts now read as natural intent; the agent trace below each one still shows the `chrome_*` primitives the agent picked. Affects the 30-second try-this block, all 3 hero recipes (PR triage / Linear standup / Bug repro), and 3 of the 6 collapsed recipes (auth-only data pull, network forensics, file upload).

## 0.15.1 — 2026-05-13

- **Architecture diagram now renders on pi.dev.** Replaced Unicode box-drawing characters (`┌─┐│└┘┬▼`) with plain ASCII (`+ - | v`). Pi.dev's monospace font was dropping the horizontal `─` glyphs, leaving the diagram as floating vertical bars. ASCII renders everywhere.
- **`author` switched to object form.** Was `"tianrendong (Earendil Inc.)"` — npm's author-string spec parses `(parens)` as the URL slot, so `"Earendil Inc."` ended up in `author.url`. Now `{ "name": "tianrendong", "company": "Earendil Inc." }`.

## 0.15.0 — 2026-05-13

- **README rewrite — top-3 recipes as terminal mockups.** PR triage, Linear standup, and Bug-repro-with-evidence each get a copy-pasteable prompt → tool trace → result block modeled on the hero example. The other six recipes (form auto-fill, admin cross-check, visual diff, auth-only data pull, network forensics, file upload) collapsed into a `<details>` block so the section sells before it catalogs.
- **Comparison table rewritten.** Dropped the all-✅ "Works on strict-CSP pages" row (zero signal). New table leads with "Time from `pi install` → first useful action on your real account" (~60s vs. hours) and "Survives MFA / SSO without code" (✅ already logged in). Multi-session row reframed as the bolded "Multiple agents drive the same Chrome at once". Footnote ² rewritten to highlight mode-aware scoring + open invitation for competing tools to PR their scores.
- **Section reorder: sells before catalogs.** New flow: hero → 60-second install → 30-second try-this → killer recipes → comparison → honest results → tool catalog → click/watch modes (with Diagnostics folded in) → architecture → benchmark suite → security model & why unpacked (combined) → composes-with → roadmap → contributing → license. Hero blockquote now precedes shields badges so pi.dev no longer scrapes a broken-image badge as the description. Package `description` shortened to 255 chars so pi.dev hero stops truncating mid-word. `author` set to `"tianrendong (Earendil Inc.)"`.

## 0.14.9

- Primer (agent system prompt) now teaches the **trusted-mode escape hatch** explicitly. Previously the bridge would hit a CSP-locked page (github.com, banks, many SaaS apps), `chrome_evaluate`/`chrome_snapshot` would throw `EvalError: 'unsafe-eval' is not an allowed source of script`, and the agent would conclude *"bridge can't drive this page"* and ask the user for a fallback. New primer makes three things self-discoverable: (1) `trusted: true` on click/type/key/fill/hover/drag/scroll dispatches through chrome.debugger / CDP and bypasses page CSP entirely, (2) the recipe for strict-CSP pages is `chrome_screenshot` + trusted input at viewport coordinates, (3) when synthetic input produces no `pageMutated` or you see a CSP/eval error, **escalate to `trusted: true` yourself instead of asking the user**. Also corrects the old claim that `chrome_evaluate` works without `'unsafe-eval'` (it does not — Function constructor is gated by `script-src`).
- Add `scripts/sync-manifest-version.js` wired to npm's `version` + `prepublishOnly` lifecycle hooks. Bumping the package version with `npm version <bump>` now auto-syncs `extensions/chrome-profile-bridge/browser-extension/manifest.json` and stages it into the version commit — kills the recurring drift class (cf. 0.14.4, 0.14.8, this fix).

## 0.14.8

- Repo moved to its own home: https://github.com/tianrendong/pi-chrome. No code changes; updated `repository`, `homepage`, and `bugs` URLs in `package.json`.

## 0.14.7

- Replace "30+ challenges" hand-wave in README + COMPARISON.md with the accurate framing from chrome-benchmark: **38 primitive challenges + 4 hermetic BrowserGym-style long-horizon tasks**, scored by **expected-outcome-by-mode** (not raw PASS count). Explains why a synthetic-events tool isn't supposed to satisfy a clipboard user-activation gate — matching that expectation is the pass.

## 0.14.6

- Fix Browser Use license in `docs/COMPARISON.md`: MIT (not Apache-2.0). Confirmed against upstream LICENSE on GitHub.

## 0.14.5

- `docs/COMPARISON.md` rewritten with a three-axis landscape (drivers / agent frameworks / cloud providers). Adds Browser Use, Stagehand, Skyvern, Magnitude, Alumnium, OpenAI Operator, Project Mariner, Surfer 2, Anthropic Computer Use, Browserbase, Steel.dev, Hyperbrowser, Anchor, Browserless. Adds Interop section, public-benchmark cheat sheet (WebArena, WorkArena++, BrowseComp, Mind2Web 2, WebChoreArena, MiniWoB++, BrowserGym).
- README gains a one-liner pointing at the new three-axis framing.
- Sourced from `benchmark-search` session research. No code changes.

## 0.14.4

- Sync `manifest.json` version to match `package.json` (0.14.3 shipped with stale manifest, would trigger spurious `/chrome doctor` drift warnings). No code or behavior changes.

## 0.14.3

- Documentation & discoverability overhaul.
- New README: hero, alternatives comparison table, 20-tool reference grouped by job, killer recipes, architecture diagram, honest-results explainer, benchmark suite plug.
- `docs/COMPARISON.md` — deep comparison vs Playwright / Puppeteer / Stagehand / browser-use / Selenium.
- `docs/EXAMPLES.md` — ready-to-paste agent prompts (PR triage, Linear standup, bug repro, network forensics, multi-tab admin cross-check, etc.).
- `docs/FAQ.md` — covers Brave/Arc, incognito, detection, banner, multi-session, CSP, file uploads, common envelope causes.
- `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE` added.
- `package.json`: `homepage`, `repository`, `bugs`, expanded keywords for npm search.
- No code changes to the tools or extension.

## 0.14.2

- Recover from foreign-extension input overlays so input tools don't get hijacked by other Chrome extensions.

## 0.14.1

- Harder `attachDebugger` retry path so trusted clicks survive transient Chrome debugger contention.
- New `trusted.debug` diagnostic surface.

## 0.14.0

- Bare `/chrome` opens a `SettingsList` dialog. `space` cycles values, `enter` saves.

## 0.13.0

- Flattened `/chrome` tree. Cycle-on-pick for `clicks` / `quiet`. Status header at the top of the picker.

## 0.12.1

- Fixed anti-automation regressions across 7 benchmark challenges (`07/13/21/27/28`).

## 0.12.0

- Unified all slash commands under `/chrome` (`/chrome doctor`, `/chrome onboard`, `/chrome clicks`, `/chrome quiet`).

## 0.11.x

- Plain-English audit pass across `/chrome doctor`, `/chrome onboard`, `/chrome quiet`, README.
- `chrome_tap` (real CDP touch events).
- Smoother `trustedScroll`; CDP debugger auto-recovers from detach.
- Smart-auto trusted mode default. Extension renamed to **Pi Chrome Connector**.
- Per-event scroll delta cap so IntersectionObserver thresholds land naturally.

## 0.10.x

- Trusted-input mode via `chrome.debugger` (CDP) — opt-in, indistinguishable-from-human clicks/keys.
- `chrome_key` modifiers (Cmd+V, Ctrl+Shift+Tab, etc.) for trusted chords.
- Interactive `/chrome-trusted` picker (later folded into `/chrome`).

## 0.9.x

- Humanized synthetic input (pointer paths, key cadence variance).
- Anti-automation benchmark test suite landed in `test-suite/`.

## 0.8.0

- `chrome_evaluate` no longer returns `null` for valid expressions — dedicated MAIN-world `evaluateInTab` pipeline with statement-mode fallback and tagged envelope for `undefined`/errors/symbols/bigints.
- Truthful action result envelopes: `isTrusted`, `defaultPrevented`, `elementVisible`, `occludedBy`, `valueMatches`, `pageMutated`.
- Extended `/chrome doctor`: bridge mode/URL, extension version drift, MAIN-world helper injection, `navigator.webdriver` fingerprint, CDP availability probe.
- Removed misleading `returnByValue` param. Implemented `chrome_screenshot.fullPage` via tile stitching.
- Autoplay-gate heuristic for `chrome_click`.

## 0.7.0

- Initial public `pi-chrome` release. Companion Chrome extension + local bridge + first tool set.
