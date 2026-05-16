# Changelog

All notable user-facing changes to `pi-chrome`.

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
