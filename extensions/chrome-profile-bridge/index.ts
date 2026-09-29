import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";

/**
 * Existing-profile Chrome bridge for pi.
 *
 * This is intentionally not a remote-debugging-port integration. Chrome blocks default-profile
 * remote debugging in many normal launches, so pi-chrome uses a companion extension from the
 * browser-extension folder bundled next to this Pi extension.
 *
 * The companion extension runs inside the user's real Chrome profile and polls this local
 * pi extension for commands. That gives pi access to the user's existing tabs/authenticated
 * profile, subject to the browser extension permissions the user grants.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type ToolTextResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
};

type BridgeCommand = {
	id: string;
	action: string;
	params: Record<string, unknown>;
};

type PendingCommand = {
	command: BridgeCommand;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	deliveredAt?: number;
};

type BridgeResult = {
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
};

const PI_CHROME_PKG_PATH = resolve(__dirname, "..", "..", "package.json");
function readPiChromeVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(PI_CHROME_PKG_PATH, "utf8")) as { version?: string };
		if (pkg.version) return pkg.version;
	} catch {}
	return "0.0.0-dev";
}
const PI_CHROME_VERSION = readPiChromeVersion();
const PI_CHROME_GLOBAL_KEY = "__piChromeProfileBridgeLoaded__";
// Authorization is kept on globalThis (separate from the singleton flag, which is cleared on
// reload) so a /reload — which tears down and re-evaluates the module — does not silently drop
// an active /chrome authorize grant.
const PI_CHROME_AUTH_KEY = "__piChromeProfileBridgeAuth__";
const DEFAULT_HOST = process.env.PI_CHROME_BRIDGE_HOST ?? "127.0.0.1";
const DEFAULT_PORT = Number(process.env.PI_CHROME_BRIDGE_PORT ?? "17318");
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 30_000;
const MAX_ELEMENTS = 80;
const BACKGROUND_PARAM_DESCRIPTION = "If true, avoid explicit Chrome focus/tab activation for this call. /chrome background on (default) enforces this for every call and ignores false. Ask the user to run /chrome background off to allow foreground work.";

function truncateText(text: string, maxChars = MAX_TEXT_CHARS): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} characters]`;
}

function safeJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

const snapshotModeValues = ["auto", "interactive", "forms", "pageMap", "text", "changes", "full"] as const;

function compactLine(value: unknown, max = 140): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function rectText(rect: any): string {
	if (!rect) return "?";
	return `${rect.x},${rect.y} ${rect.width}x${rect.height}`;
}

function formatChromeSnapshot(snapshot: any): string {
	if (!snapshot || typeof snapshot !== "object") return safeJson(snapshot);
	if (snapshot.mode === "full") return truncateText(safeJson(snapshot));
	const lines: string[] = [];
	lines.push(`# Chrome snapshot${snapshot.mode ? ` (${snapshot.mode})` : ""}`);
	lines.push(`${snapshot.title || "(untitled)"}`);
	if (snapshot.url) lines.push(`${snapshot.url}`);
	if (snapshot.viewport) lines.push(`viewport=${snapshot.viewport.width}x${snapshot.viewport.height} scroll=${snapshot.viewport.scrollX || 0},${snapshot.viewport.scrollY || 0}`);
	if (snapshot.summary?.modal) lines.push(`modal: ${snapshot.summary.modal.uid} ${compactLine(snapshot.summary.modal.label)}`);
	if (snapshot.summary?.focused) lines.push(`focused: ${snapshot.summary.focused.uid} ${snapshot.summary.focused.role || ""} ${compactLine(snapshot.summary.focused.label)}`);
	if (Array.isArray(snapshot.summary?.hints) && snapshot.summary.hints.length) {
		lines.push("\n## Hints");
		for (const hint of snapshot.summary.hints.slice(0, 6)) lines.push(`- ${hint}`);
	}
	if (snapshot.diff && !snapshot.diff.firstSnapshot) {
		const changed = [
			...(snapshot.diff.changes || []).map((c: any) => c.kind === "textChanged" ? "text changed" : `${c.kind}: ${compactLine(c.before, 50)} → ${compactLine(c.after, 50)}`),
			...(snapshot.diff.added || []).slice(0, 4).map((e: any) => `added ${e.uid} ${e.role || ""} ${compactLine(e.label)}`),
			...(snapshot.diff.updated || []).slice(0, 4).map((u: any) => `updated ${u.uid} ${compactLine(u.after?.label || u.before?.label)}`),
		];
		if (changed.length) {
			lines.push("\n## Changed since last snapshot");
			for (const item of changed.slice(0, 10)) lines.push(`- ${item}`);
		}
	}
	if (Array.isArray(snapshot.matches) && snapshot.matches.length) {
		lines.push(`\n## Matches for "${snapshot.query}"`);
		for (const match of snapshot.matches.slice(0, 12)) {
			if (match.kind === "text") lines.push(`- ${match.uid} text ${compactLine(match.text)} @ ${rectText(match.rect)}`);
			else if (match.kind === "region") lines.push(`- ${match.uid} region ${compactLine(match.label)} headings=${(match.headings || []).map((h: string) => compactLine(h, 50)).join(" | ")}`);
			else lines.push(`- ${match.uid} ${match.role || match.tag || "element"}${match.disabled ? " disabled" : ""} ${compactLine(match.label || match.selector)} @ ${rectText(match.rect)}`);
		}
	}
	if (snapshot.mode === "pageMap" && snapshot.pageMap) {
		lines.push("\n## Page map");
		for (const region of (snapshot.pageMap.regions || []).slice(0, 18)) {
			lines.push(`- ${region.uid} ${region.kind}: ${compactLine(region.label)}`);
			for (const action of (region.actions || []).slice(0, 5)) lines.push(`  - ${action.uid} ${action.role || ""}${action.disabled ? " disabled" : ""} ${compactLine(action.label)}`);
		}
		if (snapshot.pageMap.headings?.length) {
			lines.push("\nHeadings:");
			for (const h of snapshot.pageMap.headings.slice(0, 20)) lines.push(`- ${h.uid} h${h.level || ""} ${compactLine(h.text)}`);
		}
	}
	if (Array.isArray(snapshot.layout) && snapshot.layout.length && snapshot.mode !== "changes") {
		lines.push("\n## Layout / context");
		for (const section of snapshot.layout.slice(0, snapshot.mode === "pageMap" ? 18 : 8)) {
			const bits = [`${section.uid}`, section.role || section.tag, compactLine(section.label || section.text || "(unnamed section)", 110), `@ ${rectText(section.rect)}`];
			lines.push(`- ${bits.filter(Boolean).join(" ")}`);
			const fieldLabels = (section.fields || []).slice(0, 4).map((f: any) => `${f.uid} ${compactLine(f.label || f.role, 40)}`);
			const actionLabels = (section.actions || []).slice(0, 5).map((a: any) => `${a.uid}${a.disabled ? " disabled" : ""} ${compactLine(a.label || a.role, 40)}`);
			if (fieldLabels.length) lines.push(`  fields: ${fieldLabels.join("; ")}`);
			if (actionLabels.length) lines.push(`  actions: ${actionLabels.join("; ")}`);
		}
	}
	if ((snapshot.mode === "forms" || snapshot.forms?.fields?.length) && snapshot.mode !== "pageMap") {
		const fields = snapshot.forms?.fields || [];
		const submits = snapshot.forms?.submits || [];
		if (fields.length || submits.length) lines.push("\n## Forms");
		for (const field of fields.slice(0, snapshot.mode === "forms" ? 40 : 12)) {
			const bits = [field.uid, field.role || field.tag, field.required ? "required" : "", field.invalid ? "invalid" : "", field.disabled ? "disabled" : "", compactLine(field.label || field.selector, 90)];
			if (field.value) bits.push(`value=${compactLine(field.value, 50)}`);
			else if (field.valueRedacted) bits.push("value=[redacted]");
			lines.push(`- ${bits.filter(Boolean).join(" ")} @ ${rectText(field.rect)}`);
		}
		for (const submit of submits.slice(0, 8)) lines.push(`- ${submit.uid} submit/action${submit.disabled ? " disabled" : ""} ${compactLine(submit.label || submit.selector)} @ ${rectText(submit.rect)}`);
	}
	if (Array.isArray(snapshot.elements) && snapshot.mode !== "pageMap") {
		lines.push("\n## Visible actions");
		for (const el of snapshot.elements.slice(0, snapshot.mode === "interactive" ? 60 : 25)) {
			const flags = [el.disabled ? "disabled" : "", el.occluded ? `occluded-by-${el.occluded.tag}` : ""].filter(Boolean).join(",");
			const context = el.context?.label ? ` in ${el.context.uid} ${compactLine(el.context.label, 60)}` : "";
			lines.push(`- ${el.uid} ${el.role || el.tag}${flags ? ` [${flags}]` : ""} ${compactLine(el.label || el.selector)}${context} @ ${rectText(el.rect)}`);
		}
		if (snapshot.elements.length > (snapshot.mode === "interactive" ? 60 : 25)) lines.push(`- … ${snapshot.elements.length - (snapshot.mode === "interactive" ? 60 : 25)} more; retry with maxElements or mode=interactive`);
	}
	if ((snapshot.mode === "text" || snapshot.mode === "auto") && Array.isArray(snapshot.textSnippets) && snapshot.textSnippets.length) {
		lines.push("\n## Text snippets");
		for (const snip of snapshot.textSnippets.slice(0, snapshot.mode === "text" ? 40 : 14)) lines.push(`- ${snip.uid} ${compactLine(snip.text, snapshot.mode === "text" ? 240 : 160)}`);
		if (snapshot.textTruncated) lines.push("- … page text truncated; retry with mode=text or maxTextChars for more");
	}
	lines.push("\nTip: use chrome_snapshot({query:'...', mode:'interactive|forms|pageMap|text|changes|full'}) or nearUid to zoom in.");
	return truncateText(lines.join("\n"));
}

function formatIncludedSnapshotText(raw: unknown, text: string): string {
	const payload = raw && typeof raw === "object"
		? (raw as { snapshot?: unknown; navigation?: { settled?: boolean; from?: string; to?: string; waitedMs?: number } })
		: undefined;
	const snapshot = payload?.snapshot;
	const navigation = payload?.navigation;
	let body = text;
	if (navigation) {
		body += navigation.settled === false
			? `\n⚠ The action started a navigation that had not finished after ${navigation.waitedMs ?? "?"}ms (${navigation.from || "?"} → ${navigation.to || "?"}). The snapshot below may describe the page being replaced; re-check with chrome_snapshot.`
			: `\nNavigated ${navigation.from || "?"} → ${navigation.to || "?"} (waited ${navigation.waitedMs ?? "?"}ms for load).`;
	}
	return snapshot ? `${body}\n\n${formatChromeSnapshot(snapshot)}` : body;
}

// Pi-side text for chrome_type's before/after evidence. The worker returns valueBefore/valueAfter
// (or valueRedacted), existingTextLengthBefore, and insertedAt.
function describeTypeEvidence(result: unknown, typedLength: number, pressEnter: boolean): string[] {
	if (!result || typeof result !== "object") return [];
	const r = result as Record<string, unknown>;
	const lines: string[] = [];
	if (r.valueRedacted === true) {
		lines.push(`Field value [redacted] (${r.existingTextLengthBefore ?? "?"} → ${r.valueLengthAfter ?? "?"} chars; insertedAt=${r.insertedAt ?? "unknown"}).`);
	} else if (typeof r.valueBefore === "string" || typeof r.valueAfter === "string") {
		const before = typeof r.valueBefore === "string" ? JSON.stringify(r.valueBefore) : "?";
		const after = typeof r.valueAfter === "string" ? JSON.stringify(r.valueAfter) : "?";
		lines.push(`Field went from ${before} to ${after}${r.insertedAt ? ` (insertedAt=${r.insertedAt})` : ""}.`);
	}
	const unchanged = typedLength > 0 && r.replaced !== true
		&& typeof r.existingTextLengthBefore === "number" && r.existingTextLengthBefore === r.valueLengthAfter
		&& (r.valueRedacted === true || r.valueBefore === r.valueAfter);
	if (unchanged) {
		lines.push("\u26a0 The field value did not change: the keystrokes did not reach this field. It may not have keyboard focus (background/hidden tabs often cannot take focus); focus it with a uid/selector click, or ask the user to run /chrome background off, then verify.");
	} else if (r.insertedAt === "caret-middle" && typedLength > 0) {
		lines.push("⚠ Text was spliced into the middle of existing content; chrome_type does NOT replace. Use chrome_fill (or chrome_type replace=true) to replace a field's value.");
		if (pressEnter) lines.push("⚠ If Enter submitted the form, it submitted the spliced value above, not just your text.");
	} else if (r.insertedAt === "caret-end" && typedLength > 0) {
		lines.push("Note: text was appended to existing content (chrome_type does not replace).");
	}
	return lines;
}

// Keep raw CDP payloads (screenshots, huge DOM dumps) out of the model context and transcript.
const CDP_OVERSIZE_JSON_CHARS = 262_144;
function formatCdpResult(method: string, value: unknown): ToolTextResult {
	const data = value && typeof value === "object" ? (value as { data?: unknown }).data : undefined;
	if (typeof data === "string" && (/captureScreenshot|printToPDF|screencast/i.test(method) || data.length >= CDP_OVERSIZE_JSON_CHARS)) {
		const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
		const bytes = Math.floor((data.length / 4) * 3) - padding;
		const fields = Object.keys(value as object).filter((key) => key !== "data");
		const text = `CDP ${method} returned ~${bytes} bytes in its "data" field; the payload was omitted to protect the context window. Use chrome_screenshot to save images to disk.${fields.length ? ` Other fields: ${fields.join(", ")}.` : ""}`;
		return { content: [{ type: "text", text }], details: { value: { omitted: "data-field", bytes, fields } } };
	}
	const text = value === undefined ? "undefined" : typeof value === "string" ? value : (safeJson(value) ?? "undefined");
	if (text.length > CDP_OVERSIZE_JSON_CHARS) {
		const fields = value && typeof value === "object" ? Object.keys(value as object) : [];
		return {
			content: [{ type: "text", text: `${truncateText(text)}\n\n[details omitted: ${text.length} chars of JSON]` }],
			details: { value: { omitted: "oversized-result", chars: text.length, fields } },
		};
	}
	return { content: [{ type: "text", text: truncateText(text) }], details: { value } };
}

// chrome_screenshot writes a timestamped file per capture (plus -tileN files and a .json manifest for
// full-page captures) into .pi/chrome-screenshots. Prune that folder at capture time so it stays
// bounded. Only files matching the tool's own naming are eligible; the newest `keep` captures are always
// kept, and nothing inside the retention window is removed. Best-effort: errors never fail a capture.
const SCREENSHOT_NAME_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:-tile\d+)?\.(?:png|jpeg)(?:\.json)?$/;
const SCREENSHOT_KEEP_NEWEST = 20;
const SCREENSHOT_RETENTION_DAYS = 7;

function screenshotCaptureTime(stamp: string): number {
	const iso = stamp.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1:$2:$3.$4Z");
	return Date.parse(iso);
}

function screenshotFilesToPrune(names: string[], now: number, retentionDays = SCREENSHOT_RETENTION_DAYS, keep = SCREENSHOT_KEEP_NEWEST): string[] {
	if (!(retentionDays > 0)) return [];
	const captures = new Map<string, string[]>();
	for (const name of names) {
		const match = SCREENSHOT_NAME_RE.exec(name);
		if (!match) continue;
		const files = captures.get(match[1]) ?? [];
		files.push(name);
		captures.set(match[1], files);
	}
	const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
	const newestFirst = [...captures.keys()].sort().reverse();
	const prune: string[] = [];
	for (const stamp of newestFirst.slice(keep)) {
		const takenAt = screenshotCaptureTime(stamp);
		if (Number.isFinite(takenAt) && takenAt < cutoff) prune.push(...(captures.get(stamp) ?? []));
	}
	return prune;
}

async function pruneScreenshotDir(dir: string, retentionDays?: number): Promise<number> {
	try {
		const names = await readdir(dir);
		let removed = 0;
		for (const name of screenshotFilesToPrune(names, Date.now(), retentionDays)) {
			try {
				await unlink(join(dir, name));
				removed++;
			} catch {
				// Locked or already gone: keep going.
			}
		}
		return removed;
	} catch {
		return 0;
	}
}
// End screenshot pruning.

function formatChromeInspect(inspect: any): string {
	if (!inspect || typeof inspect !== "object") return safeJson(inspect);
	const t = inspect.target || {};
	const lines: string[] = [];
	lines.push(`# Chrome inspect ${t.uid || ""}`.trim());
	lines.push(`${t.role || t.tag || "element"}${t.disabled ? " disabled" : ""}${t.occluded ? ` occluded-by-${t.occluded.tag}` : ""} ${compactLine(t.label || t.selector)}`);
	if (t.selector) lines.push(`selector: ${t.selector}`);
	if (t.rect) lines.push(`rect: ${rectText(t.rect)}`);
	if (inspect.clickSuggestion) lines.push(`suggested click: chrome_click({ uid: "${inspect.clickSuggestion.uid}" }) or x=${inspect.clickSuggestion.x}, y=${inspect.clickSuggestion.y}`);
	if (Array.isArray(inspect.nearbyText) && inspect.nearbyText.length) {
		lines.push("\n## Nearby text");
		for (const item of inspect.nearbyText.slice(0, 12)) lines.push(`- ${item.uid} ${compactLine(item.text, 180)}`);
	}
	if (inspect.formContext) {
		lines.push("\n## Form context");
		for (const field of (inspect.formContext.fields || []).slice(0, 20)) lines.push(`- ${field.uid} ${field.role || field.tag}${field.disabled ? " disabled" : ""} ${compactLine(field.label || field.selector)}${field.value ? ` value=${compactLine(field.value, 60)}` : field.valueRedacted ? " value=[redacted]" : ""}`);
		for (const action of (inspect.formContext.actions || []).slice(0, 10)) lines.push(`- ${action.uid} action${action.disabled ? " disabled" : ""} ${compactLine(action.label || action.selector)}`);
	}
	if (Array.isArray(inspect.nearbyActions) && inspect.nearbyActions.length) {
		lines.push("\n## Nearby actions");
		for (const action of inspect.nearbyActions.slice(0, 18)) lines.push(`- ${action.uid} ${action.role || action.tag}${action.disabled ? " disabled" : ""} ${compactLine(action.label || action.selector)} @ ${rectText(action.rect)}`);
	}
	if (Array.isArray(inspect.ancestors) && inspect.ancestors.length) {
		lines.push("\n## Ancestors");
		for (const a of inspect.ancestors.slice(0, 6)) lines.push(`- ${a.uid} ${a.role || a.tag} ${compactLine(a.label || a.selector, 120)}`);
	}
	return truncateText(lines.join("\n"));
}

function extensionRoot(): string {
	// Resolve relative to this extension file, not ctx.cwd. ctx.cwd can temporarily be
	// an attachment/clipboard path when Pi is handling pasted images.
	if (typeof __dirname === "string") return __dirname;
	return process.cwd();
}

function workspaceCwd(ctx: ExtensionContext): string {
	for (const candidate of [ctx.cwd, process.cwd()]) {
		if (!candidate) continue;
		try {
			if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
		} catch {
			// try next candidate
		}
	}
	return process.cwd();
}

function browserExtensionPath(): string {
	return join(extensionRoot(), "browser-extension");
}

function hostnameOf(url: string | undefined): string {
	if (!url) return "";
	try { return new URL(url).hostname; } catch { return ""; }
}

// Description of a click/type/fill result's significant fields so the agent doesn't have to
// guess whether the action actually changed the page.
function summarizeActionResult(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const r = result as Record<string, unknown>;
	const parts: string[] = [];
	// NOTE: pageMutated is a coarse heuristic (a hash over body text + input values + node count).
	// Many real effects — class/aria/data-state toggles, JS-held state, canvas, async updates —
	// don't move it, so a false value is NOT proof the action did nothing. Surface it only as a
	// soft hint, and never present it as a failure on its own.
	if (r.pageMutated === false) parts.push("no coarse DOM change detected (may still have taken effect — verify with includeSnapshot)");
	if (r.defaultPrevented === true) parts.push("defaultPrevented=true");
	if (r.elementVisible === false) parts.push("element NOT visible");
	if (r.occludedBy) {
		const o = r.occludedBy as { tag?: string; id?: string };
		parts.push(`occluded by <${o.tag ?? "?"}${o.id ? "#" + o.id : ""}>`);
	}
	if (r.valueMatches === false) parts.push("input value did not stick");
	if (r.autoplayHint) parts.push("autoplay-gated affordance");
	return parts.length ? parts.join("; ") : undefined;
}

function readRequestBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolveBody, rejectBody) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
		request.on("error", rejectBody);
	});
}

function corsHeadersFor(request: IncomingMessage): Record<string, string> {
	const origin = String(request.headers.origin ?? "");
	if (!origin.startsWith("chrome-extension://")) return {};
	return {
		"access-control-allow-origin": origin,
		"access-control-allow-methods": "GET,POST,OPTIONS",
		"access-control-allow-headers": "content-type",
		"access-control-expose-headers": "x-pi-chrome-version",
		"vary": "origin",
	};
}

function isBrowserOriginAllowed(request: IncomingMessage): boolean {
	const origin = String(request.headers.origin ?? "");
	if (origin) return origin.startsWith("chrome-extension://");
	const secFetchSite = String(request.headers["sec-fetch-site"] ?? "");
	return !secFetchSite || secFetchSite === "none" || secFetchSite === "same-origin";
}

function isLocalProcessRequest(request: IncomingMessage): boolean {
	return !request.headers.origin && !request.headers["sec-fetch-site"];
}

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		...(extraHeaders ?? {}),
	});
	response.end(JSON.stringify(body));
}

class ChromeProfileBridge {
	private server: Server | undefined;
	private pending = new Map<string, PendingCommand>();
	private queue: BridgeCommand[] = [];
	private waiters: Array<(command: BridgeCommand | undefined) => void> = [];
	private lastSeenAt: number | undefined;
	private clientName: string | undefined;
	private mode: "server" | "client" | undefined;

	constructor(
		private readonly host: string,
		private readonly port: number,
	) {}

	get url(): string {
		return `http://${this.host}:${this.port}`;
	}

	get connected(): boolean {
		// MV3 service workers can pause between polls/alarms. Treat a recent poll as
		// connected without sending a probe command; real chrome_* tool calls are
		// the authoritative end-to-end health check.
		return this.lastSeenAt !== undefined && Date.now() - this.lastSeenAt < 5 * 60_000;
	}

	status(): Record<string, unknown> {
		return {
			url: this.url,
			mode: this.mode ?? "starting",
			connected: this.connected,
			lastSeenAt: this.lastSeenAt,
			clientName: this.clientName,
			queuedCommands: this.queue.length,
			pendingCommands: this.pending.size,
		};
	}

	async start(): Promise<void> {
		if (this.server || this.mode === "client") return;
		await this.bindServerOrClient();
	}

	// A client-mode session (another Pi session or a subagent owns the port) never sees extension
	// polls itself, so its local status always reads "not connected". Ask the owner instead.
	async connectionStatus(): Promise<Record<string, unknown>> {
		const local = this.status();
		if (this.mode !== "client") return local;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1_000);
		try {
			const response = await fetch(`${this.url}/status`, { signal: controller.signal });
			if (!response.ok) return local;
			const owner = (await response.json()) as Record<string, unknown>;
			return {
				...local,
				connected: owner.connected === true,
				lastSeenAt: typeof owner.lastSeenAt === "number" ? owner.lastSeenAt : local.lastSeenAt,
				clientName: typeof owner.clientName === "string" ? owner.clientName : local.clientName,
				ownerMode: owner.mode,
			};
		} catch {
			return local;
		} finally {
			clearTimeout(timer);
		}
	}

	// Try to own the bridge port. On success we are the server; on EADDRINUSE another Pi
	// session owns it and we run as a client that forwards commands to that owner.
	private async bindServerOrClient(): Promise<void> {
		const server = createServer((request, response) => {
			void this.handle(request, response).catch((error) => {
				sendJson(response, 500, { error: (error as Error).message });
			});
		});
		try {
			await new Promise<void>((resolveStart, rejectStart) => {
				server.once("error", rejectStart);
				server.listen(this.port, this.host, () => {
					server.off("error", rejectStart);
					resolveStart();
				});
			});
			this.server = server;
			this.mode = "server";
		} catch (error) {
			server.close();
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
			// Another Pi session already owns the bridge port. Use it as the shared
			// machine-local broker so multiple Pi sessions can control Chrome at once.
			this.mode = "client";
		}
	}

	// Client-mode self-heal: when the owning Pi session disappears, fetches to its port fail
	// with `fetch failed` / ECONNREFUSED forever. Try to grab the now-free port and become the
	// server ourselves so chrome_* tools recover without a manual restart.
	private async tryPromoteToServer(): Promise<boolean> {
		if (this.mode !== "client") return this.mode === "server";
		this.mode = undefined;
		await this.bindServerOrClient();
		return this.mode === "server";
	}

	stop(): void {
		if (this.mode === "client") {
			this.mode = undefined;
			return;
		}
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Chrome profile bridge stopped"));
		}
		this.pending.clear();
		this.queue = [];
		for (const waiter of this.waiters) waiter(undefined);
		this.waiters = [];
		this.server?.close();
		this.server = undefined;
		this.mode = undefined;
	}

	send(action: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
		if (this.mode === "client") return this.sendViaOwner(action, params, timeoutMs, signal);
		return this.sendLocal(action, params, timeoutMs, signal);
	}

	private sendLocal(action: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
		const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		const command = { id, action, params };
		return new Promise((resolveCommand, rejectCommand) => {
			if (signal?.aborted) {
				rejectCommand(new Error("Chrome command aborted"));
				return;
			}
			const cleanupAbort = () => {
				if (signal) signal.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				clearTimeout(timer);
				this.pending.delete(id);
				this.queue = this.queue.filter((queued) => queued.id !== id);
				cleanupAbort();
				rejectCommand(new Error("Chrome command aborted"));
			};
			const timer = setTimeout(() => {
				const entry = this.pending.get(id);
				this.pending.delete(id);
				this.queue = this.queue.filter((queued) => queued.id !== id);
				cleanupAbort();
				rejectCommand(new Error(this.timeoutMessage(entry, timeoutMs)));
			}, timeoutMs);
			this.pending.set(id, {
				command,
				resolve: (value) => { cleanupAbort(); resolveCommand(value); },
				reject: (err) => { cleanupAbort(); rejectCommand(err); },
				timer,
			});
			if (signal) signal.addEventListener("abort", onAbort, { once: true });
			this.enqueue(command);
		});
	}

	// Classify why a local command timed out so the agent isn't left guessing. The three
	// distinct failure modes are: extension never polled (not installed / not running),
	// extension polled but never picked up this command, and extension picked up the command
	// but never posted a result back (long-running action or a failed /result post).
	private timeoutMessage(entry: PendingCommand | undefined, timeoutMs: number): string {
		const pollAgeMs = this.lastSeenAt === undefined ? undefined : Date.now() - this.lastSeenAt;
		if (entry?.deliveredAt) {
			return `Timed out after ${timeoutMs}ms: the Chrome extension received the command but never returned a result. The action may be long-running, or the result post failed. Run /chrome doctor; if it persists, reload 'Pi Chrome Connector' at chrome://extensions.`;
		}
		if (pollAgeMs === undefined || pollAgeMs > 60_000) {
			return `Timed out after ${timeoutMs}ms: the Chrome extension is not polling (last seen ${pollAgeMs === undefined ? "never" : Math.round(pollAgeMs / 1000) + "s ago"}). Run /chrome onboard, then load the bundled browser-extension folder in your normal Chrome profile and keep that Chrome window open.`;
		}
		return `Timed out after ${timeoutMs}ms: the Chrome extension is polling (last seen ${Math.round(pollAgeMs / 1000)}s ago) but did not pick up this command in time. Retry; if it persists, reload 'Pi Chrome Connector' at chrome://extensions.`;
	}

	private async sendViaOwner(action: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs + 2_000);
		const forwardAbort = () => controller.abort();
		if (signal) {
			if (signal.aborted) controller.abort();
			else signal.addEventListener("abort", forwardAbort, { once: true });
		}
		try {
			const response = await fetch(`${this.url}/command`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action, params, timeoutMs }),
				signal: controller.signal,
			});
			const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; error?: string };
			if (response.status === 404) {
				throw new Error(
					"A running Pi session owns the Chrome bridge but is using an older pi-chrome without multi-session support. Restart that Pi session after `pi update`, then retry.",
				);
			}
			if (!response.ok || !payload.ok) throw new Error(payload.error ?? `Chrome bridge owner HTTP ${response.status}`);
			return payload.result;
		} catch (error) {
			if ((error as Error).name === "AbortError") {
				if (signal?.aborted) throw new Error("Chrome command aborted");
				throw new Error(`Timed out waiting for shared Chrome bridge owner after ${timeoutMs}ms`);
			}
			// `fetch failed` / ECONNREFUSED means the Pi session that owned the bridge port is gone.
			// Try to take over the port ourselves and re-run the command locally instead of staying
			// stuck as a client pointed at a dead owner.
			if (this.isOwnerUnreachable(error)) {
				const promoted = await this.tryPromoteToServer().catch(() => false);
				if (promoted) return this.sendLocal(action, params, timeoutMs, signal);
				throw new Error(
					"The Pi session that owned the Chrome bridge is unreachable and this session could not take over the bridge port. Restart this Pi session, or run /chrome doctor.",
				);
			}
			throw error;
		} finally {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", forwardAbort);
		}
	}

	private isOwnerUnreachable(error: unknown): boolean {
		const message = (error as Error)?.message ?? "";
		const code = (error as NodeJS.ErrnoException)?.code ?? "";
		const cause = (error as { cause?: NodeJS.ErrnoException })?.cause;
		const causeCode = cause?.code ?? "";
		return (
			/fetch failed|ECONNREFUSED|ECONNRESET|other side closed|socket hang up/i.test(message) ||
			code === "ECONNREFUSED" ||
			causeCode === "ECONNREFUSED" ||
			causeCode === "ECONNRESET"
		);
	}

	private enqueue(command: BridgeCommand): void {
		const waiter = this.waiters.shift();
		if (waiter) waiter(command);
		else this.queue.push(command);
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", this.url);
		const corsHeaders = corsHeadersFor(request);
		if (request.method === "OPTIONS") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			sendJson(response, 200, { ok: true }, corsHeaders);
			return;
		}
		if (request.method === "GET" && url.pathname === "/status") {
			sendJson(response, 200, this.status());
			return;
		}
		if (request.method === "POST" && url.pathname === "/command") {
			if (!isLocalProcessRequest(request)) {
				sendJson(response, 403, { ok: false, error: "Chrome commands are accepted only from local Pi processes" });
				return;
			}
			const body = JSON.parse(await readRequestBody(request)) as {
				action?: string;
				params?: Record<string, unknown>;
				timeoutMs?: number;
			};
			if (!body.action) {
				sendJson(response, 400, { ok: false, error: "Missing command action" });
				return;
			}
			try {
				const result = await this.sendLocal(body.action, body.params ?? {}, body.timeoutMs ?? DEFAULT_TIMEOUT_MS);
				sendJson(response, 200, { ok: true, result });
			} catch (error) {
				sendJson(response, 504, { ok: false, error: (error as Error).message });
			}
			return;
		}
		if (request.method === "GET" && url.pathname === "/next") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			this.lastSeenAt = Date.now();
			this.clientName = url.searchParams.get("name") ?? undefined;
			let aborted = false;
			let activeWaiter: ((command: BridgeCommand | undefined) => void) | undefined;
			request.once("close", () => {
				aborted = true;
				if (activeWaiter) this.waiters = this.waiters.filter((entry) => entry !== activeWaiter);
			});
			let command = this.queue.shift();
			if (!command) {
				command = await this.waitForCommand(25_000, (waiter) => {
					activeWaiter = waiter;
				});
			}
			if (aborted) {
				// Long-poll connection died before we could deliver. Requeue any command we pulled
				// so the next live /next picks it up instead of dropping it on the floor.
				if (command) this.queue.unshift(command);
				return;
			}
			// Mark the command as delivered so a later timeout can distinguish "extension never
			// picked it up" from "extension is running it / failed to post a result".
			if (command) {
				const entry = this.pending.get(command.id);
				if (entry) entry.deliveredAt = Date.now();
			}
			// Re-read version on every /next so bumping package.json takes effect without pi restart.
			const currentVersion = readPiChromeVersion();
			sendJson(
				response,
				200,
				command
					? { type: "command", command, expectedExtensionVersion: currentVersion }
					: { type: "none", expectedExtensionVersion: currentVersion },
				{ ...corsHeaders, "x-pi-chrome-version": currentVersion },
			);
			return;
		}
		if (request.method === "POST" && url.pathname === "/result") {
			if (!isBrowserOriginAllowed(request)) {
				sendJson(response, 403, { ok: false, error: "browser origin not allowed" });
				return;
			}
			this.lastSeenAt = Date.now();
			const result = JSON.parse(await readRequestBody(request)) as BridgeResult;
			const pending = this.pending.get(result.id);
			if (!pending) {
				sendJson(response, 404, { ok: false, error: "unknown command id" }, corsHeaders);
				return;
			}
			clearTimeout(pending.timer);
			this.pending.delete(result.id);
			if (result.ok) pending.resolve(result.result);
			else pending.reject(new Error(result.error ?? "Chrome extension command failed"));
			sendJson(response, 200, { ok: true }, corsHeaders);
			return;
		}
		sendJson(response, 404, { error: "not found" });
	}

	private waitForCommand(
		timeoutMs: number,
		registerWaiter?: (waiter: (command: BridgeCommand | undefined) => void) => void,
	): Promise<BridgeCommand | undefined> {
		return new Promise((resolveWait) => {
			let settled = false;
			const waiter = (command: BridgeCommand | undefined) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.waiters = this.waiters.filter((entry) => entry !== waiter);
				resolveWait(command);
			};
			const timer = setTimeout(() => waiter(undefined), timeoutMs);
			this.waiters.push(waiter);
			registerWaiter?.(waiter);
		});
	}
}

const tabActionValues = ["list", "new", "activate", "close", "group", "ungroup", "version"] as const;
const imageFormatValues = ["png", "jpeg"] as const;
const waitForValues = ["selector", "expression"] as const;
const CHROME_TOOL_NAMES = [
	"chrome_launch",
	"chrome_tab",
	"chrome_snapshot",
	"chrome_find",
	"chrome_inspect",
	"chrome_navigate",
	"chrome_evaluate",
	"chrome_click",
	"chrome_type",
	"chrome_fill",
	"chrome_key",
	"chrome_wait_for",
	"chrome_list_console_messages",
	"chrome_list_network_requests",
	"chrome_get_network_request",
	"chrome_screenshot",
	"chrome_hover",
	"chrome_drag",
	"chrome_tap",
	"chrome_scroll",
	"chrome_upload_file",
	"chrome_cdp",
	"chrome_cdp_targets",
] as const;
const CHROME_TOOL_NAME_SET = new Set<string>(CHROME_TOOL_NAMES);
const CHROME_TOOL_CHANGE_ENTRY = "pi-chrome-tool-change";
type ChromeToolChangeEntry = {
	content: string;
	action: "authorized" | "reauthorized" | "revoked" | "expired";
	tools: string[];
	authorizedUntil?: number | "indefinite";
	at: number;
};

function StringEnum<T extends readonly [string, ...string[]]>(values: T) {
	return Type.Union(values.map((value) => Type.Literal(value)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]]);
}

export default function (pi: ExtensionAPI): void {
	const instanceToken = Symbol("pi-chrome-instance");
	const currentRoot = extensionRoot();
	const globalState = globalThis as typeof globalThis & {
		[PI_CHROME_GLOBAL_KEY]?: { version: string; root: string; token?: symbol };
		[PI_CHROME_AUTH_KEY]?: { until: number | "indefinite" };
	};
	const alreadyLoaded = globalState[PI_CHROME_GLOBAL_KEY];
	// Only a *different* install root (two copies of pi-chrome) is a duplicate. A same-root re-entry is
	// legitimate: subagent sessions (e.g. pi-subagents) load extensions into their own runner in this
	// process, so this factory runs once per session. Skipping it left subagents with no chrome_* tools.
	// Each instance gets its own bridge; the second binds as a client of the port owner (EADDRINUSE),
	// so all sessions share the one Chrome connector. Stale flags from older releases (<=0.15.19) that
	// point at this same root are harmless for the same reason.
	if (alreadyLoaded && alreadyLoaded.root !== currentRoot) {
		console.warn(
			`pi-chrome already loaded from ${alreadyLoaded.root} (v${alreadyLoaded.version}); skipping duplicate from ${currentRoot}.`,
		);
		return;
	}
	if (!alreadyLoaded) globalState[PI_CHROME_GLOBAL_KEY] = { version: PI_CHROME_VERSION, root: currentRoot, token: instanceToken };

	const bridge = new ChromeProfileBridge(DEFAULT_HOST, DEFAULT_PORT);
	let backgroundEnabled = true;
	let chromeAuthorizedUntil: number | "indefinite" | undefined;
	// Restore an authorization that survived a /reload. Drop it if it already expired.
	const persistedAuth = globalState[PI_CHROME_AUTH_KEY];
	if (persistedAuth) {
		if (persistedAuth.until === "indefinite" || persistedAuth.until > Date.now()) {
			chromeAuthorizedUntil = persistedAuth.until;
		} else {
			delete globalState[PI_CHROME_AUTH_KEY];
		}
	}
	const persistAuth = (): void => {
		if (chromeAuthorizedUntil === undefined) delete globalState[PI_CHROME_AUTH_KEY];
		else globalState[PI_CHROME_AUTH_KEY] = { until: chromeAuthorizedUntil };
	};
	let chromeToolsRegistered = false;
	let chromeToolsUsable = false;
	let authExpiryTimer: NodeJS.Timeout | undefined;
	let countdownInterval: NodeJS.Timeout | undefined;
	// Remembered so bridge sends can tag tabs with this session's group even when ctx isn't handy.
	let sessionCtx: ExtensionContext | undefined;

	const clearAuthExpiryTimer = (): void => {
		if (!authExpiryTimer) return;
		clearTimeout(authExpiryTimer);
		authExpiryTimer = undefined;
	};

	const clearCountdownInterval = (): void => {
		if (!countdownInterval) return;
		clearInterval(countdownInterval);
		countdownInterval = undefined;
	};

	const chromeToolsActive = (tools = pi.getActiveTools()): boolean => tools.some((name) => CHROME_TOOL_NAME_SET.has(name));

	const activateChromeTools = (): boolean => {
		registerChromeTools(pi);
		const before = pi.getActiveTools();
		const next = [...new Set([...before, ...CHROME_TOOL_NAMES])];
		pi.setActiveTools(next);
		return !chromeToolsActive(before) && chromeToolsActive(next);
	};

	const deactivateChromeTools = (): boolean => {
		const before = pi.getActiveTools();
		pi.setActiveTools(before.filter((name) => !CHROME_TOOL_NAME_SET.has(name)));
		return chromeToolsActive(before);
	};

	const logChromeToolChange = (
		action: "authorized" | "reauthorized" | "revoked" | "expired",
		options: { label?: string; authorizedUntil?: number | "indefinite" } = {},
	): void => {
		const content = action === "authorized"
			? `Chrome tools enabled by /chrome authorize${options.label ? ` (${options.label})` : ""}.`
			: action === "reauthorized"
				? `Chrome tool authorization updated by /chrome authorize${options.label ? ` (${options.label})` : ""}.`
				: action === "expired"
					? "Chrome tools disabled because /chrome authorize grant expired."
					: "Chrome tools disabled by /chrome revoke.";
		// Session-history log only (custom entry, not sent to the model). The model already learns about
		// the change from pi's tool/prompt-section delta, so a model-facing message would be redundant.
		pi.appendEntry<ChromeToolChangeEntry>(CHROME_TOOL_CHANGE_ENTRY, {
			content,
			action,
			tools: [...CHROME_TOOL_NAMES],
			authorizedUntil: options.authorizedUntil,
			at: Date.now(),
		});
	};

	// Bound the entire request, including shared-owner forwarding/takeover. Revoke can launch
	// this in the background; shutdown must wait before tearing down the bridge.
	const cleanupAutomationTargetBestEffort = async (timeoutMs = 2_000): Promise<void> => {
		const sessionKey = sessionKeyFor(sessionCtx);
		if (sessionKey === undefined) return; // Never clean up an unscoped/default session.
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				bridge.send("automation.cleanup", { sessionKey }, timeoutMs, controller.signal).catch(() => undefined),
				new Promise<void>((resolveCleanup) => {
					timer = setTimeout(() => { controller.abort(); resolveCleanup(); }, timeoutMs);
				}),
			]);
		} catch {
			// Shutdown/revoke remains best-effort when Chrome or its bridge is unavailable.
		} finally {
			clearTimeout(timer);
		}
	};

	const lockChromeControl = (logAction?: "revoked" | "expired"): void => {
		clearAuthExpiryTimer();
		clearCountdownInterval();
		const wasUsable = chromeToolsUsable;
		deactivateChromeTools();
		chromeToolsUsable = false;
		if (logAction && wasUsable) logChromeToolChange(logAction, { authorizedUntil: undefined });
		chromeAuthorizedUntil = undefined;
		persistAuth();
		// Revoking control ends pi-chrome's automation for this session; tidy up the target we own.
		void cleanupAutomationTargetBestEffort();
	};

	const authSummary = (): string => {
		if (chromeAuthorizedUntil === "indefinite") return "authorized indefinitely";
		if (typeof chromeAuthorizedUntil === "number") {
			const remainingMs = chromeAuthorizedUntil - Date.now();
			if (remainingMs > 0) return `authorized for ~${Math.ceil(remainingMs / 60_000)}m`;
		}
		return "locked";
	};

	const chromeControlAuthorized = (): boolean => {
		if (chromeAuthorizedUntil === "indefinite") return true;
		if (typeof chromeAuthorizedUntil === "number" && chromeAuthorizedUntil > Date.now()) return true;
		if (chromeAuthorizedUntil !== undefined) lockChromeControl("expired");
		return false;
	};

	const requireChromeControlAuthorized = (): void => {
		if (!chromeControlAuthorized()) {
			throw new Error("Chrome control locked. Ask the user to run /chrome authorize before using chrome_* tools.");
		}
	};

	// Tab-group title for this Pi session: prefer the user-set display name, else the session id.
	const sessionGroupTitle = (ctx: ExtensionContext): string => {
		const sm = ctx.sessionManager;
		const name = sm.getSessionName?.();
		const id = sm.getSessionId?.();
		return `Pi Session: ${name || id || "unknown"}`;
	};

	const authCountdownLabel = (): string => {
		if (chromeAuthorizedUntil === "indefinite") return " (indefinite)";
		if (typeof chromeAuthorizedUntil === "number") {
			const remainingMs = chromeAuthorizedUntil - Date.now();
			if (remainingMs > 0) {
				const mins = Math.ceil(remainingMs / 60_000);
				return mins >= 1 ? ` (${mins}m)` : " (<1m)";
			}
		}
		return "";
	};

	// Stable per-session key the service worker uses to scope its dedicated automation tab/window
	// to *this* session (one extension brokers all sessions). The session id is stable across
	// /reload, so the automation target is reused rather than orphaned. Returns undefined only
	// before session_start, in which case the worker uses its default bucket.
	const sessionKeyFor = (ctx: ExtensionContext | undefined): string | undefined => {
		const id = ctx?.sessionManager?.getSessionId?.();
		return typeof id === "string" && id ? `session:${id}` : undefined;
	};

	const updateChromeStatus = (ctx: ExtensionContext): void => {
		if (chromeControlAuthorized()) {
			ctx.ui.setStatus("chrome", ctx.ui.theme.fg("success", "●") + " Chrome Bridge" + authCountdownLabel());
		} else {
			ctx.ui.setStatus("chrome", undefined);
		}
	};

	// Ticks every 60 s while a timed authorization is active to keep the countdown current.
	const startCountdownTicker = (ctx: ExtensionContext): void => {
		clearCountdownInterval();
		if (chromeAuthorizedUntil === "indefinite" || typeof chromeAuthorizedUntil !== "number") return;
		countdownInterval = setInterval(() => {
			if (!chromeControlAuthorized()) {
				clearCountdownInterval();
				return;
			}
			updateChromeStatus(ctx);
		}, 60_000);
	};

	const scheduleAuthExpiry = (ctx: ExtensionContext, until: number | "indefinite"): void => {
		clearAuthExpiryTimer();
		startCountdownTicker(ctx);
		if (until === "indefinite") return;
		authExpiryTimer = setTimeout(() => {
			if (chromeAuthorizedUntil !== until) return;
			try {
				lockChromeControl("expired");
				ctx.ui.notify("Chrome control authorization expired. Run /chrome authorize to allow chrome_* tools again.", "info");
				updateChromeStatus(ctx);
			} catch (error) {
				console.warn(`Failed to expire pi-chrome authorization cleanly: ${(error as Error).message}`);
			}
		}, Math.max(0, until - Date.now()));
	};

	const authorizedBridgeSend = async (action: string, params: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> => {
		requireChromeControlAuthorized();
		// Background on is a session policy, not a default that tool arguments can override.
		// Apply it here so tab.new, chrome_launch(url), and tools without a background parameter
		// cannot bypass it. Background off still permits per-call background:true.
		const typed = params as { background?: boolean; foreground?: boolean };
		const requestedBackground = typed.background ?? (typed.foreground !== undefined ? !typed.foreground : false);
		const background = backgroundEnabled || requestedBackground;
		if (action === "tab.activate" && background) {
			throw new Error("Tab activation is blocked by background mode. Ask the user to run /chrome background off to allow foreground work.");
		}
		// Scope every action to this session's dedicated automation target and tab group.
		const sessionKey = sessionKeyFor(sessionCtx);
		let wireParams: Record<string, unknown> = { ...params, background, foreground: !background };
		if (sessionKey !== undefined && params.sessionKey === undefined) wireParams.sessionKey = sessionKey;
		const sessionTitle = sessionCtx !== undefined ? sessionGroupTitle(sessionCtx) : undefined;
		// Any tab Pi opens through tab.new/tab.group must use THIS session's group, even if a caller
		// passes group:false or a custom groupTitle. This central guard covers chrome_tab plus internal
		// callers such as chrome_launch(url).
		if ((action === "tab.new" || action === "tab.group") && sessionTitle !== undefined) {
			wireParams = { ...wireParams, groupTitle: sessionTitle };
		}
		// Any tab Pi *uses* (page.* interactions and raw cdp.call) should join this session's group, mirroring the
		// auto-grouping that tab.new already does. Tagging the wire params lets getTabByParams pull
		// the resolved tab into the session group on the service-worker side. We skip tab.* and cdp.targets actions:
		// tab.new/group are forced above, and activate/close/ungroup/list must not group tabs.
		const shouldJoinGroup = (action.startsWith("page.") || action === "cdp.call") && sessionTitle !== undefined && params.sessionGroupTitle === undefined;
		if (shouldJoinGroup) {
			wireParams = { ...wireParams, sessionGroupTitle: sessionTitle, joinSessionGroup: true };
		}
		// Older companions ignore background for tab creation and activate tabs for screenshots.
		// Dedicated wire actions make them fail closed, with no probe/action race or extra round trip.
		// These are internal protocol aliases, not new tools or /chrome commands.
		const wireAction = background && (action === "tab.new" || action === "page.screenshot")
			? `${action}.background`
			: action;
		try {
			return await bridge.send(wireAction, wireParams, timeoutMs, signal);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (wireAction !== action && message.includes(`Unknown action: ${wireAction}`)) {
				throw new Error("Hard background requires an updated Chrome companion extension. Reload Pi Chrome Connector at chrome://extensions, then retry.");
			}
			throw error;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		await bridge.start();
		// Reestablish in-memory state after a /reload restored chromeAuthorizedUntil from globalThis.
		if (chromeControlAuthorized()) {
			activateChromeTools();
			chromeToolsUsable = true;
			if (typeof chromeAuthorizedUntil === "number") scheduleAuthExpiry(ctx, chromeAuthorizedUntil);
			else if (chromeAuthorizedUntil === "indefinite") startCountdownTicker(ctx);
		} else {
			deactivateChromeTools();
			chromeToolsUsable = false;
		}
		updateChromeStatus(ctx);
	});

	// Render authorization log entries in the transcript. Custom entries never reach the model.
	pi.registerEntryRenderer?.<ChromeToolChangeEntry>(CHROME_TOOL_CHANGE_ENTRY, (entry, _options, theme) => {
		const content = entry.data?.content ?? "Chrome authorization changed.";
		return new Text(theme.fg("dim", `[pi-chrome] ${content}`), 1, 0);
	});

	pi.on("session_shutdown", async (event) => {
		clearAuthExpiryTimer();
		clearCountdownInterval();
		// /reload continues the same session. On exit, give Chrome a bounded opportunity to
		// close this session's created tabs and ungroup adopted tabs before stopping the broker.
		if (event?.reason !== "reload") await cleanupAutomationTargetBestEffort();
		bridge.stop();
		if (globalState[PI_CHROME_GLOBAL_KEY]?.token === instanceToken) {
			delete globalState[PI_CHROME_GLOBAL_KEY];
		}
	});

	// Contribute the primer as a named prompt section instead of returning `systemPrompt`.
	// Returning `systemPrompt` forces a whole-prompt override, which makes pi collapse every system
	// message into a new leading prompt each run (busting the provider prompt cache and disabling
	// pi's append-only section/tool deltas for all extensions). Mutating `systemPromptOptions.sections`
	// lets pi diff the section and append a small system-message delta when it appears/disappears.
	pi.on("before_agent_start", (event) => {
		const active = chromeToolsRegistered && chromeControlAuthorized();
		const sections = (event as { systemPromptOptions?: { sections?: Record<string, string> } }).systemPromptOptions?.sections;
		if (sections) {
			if (active) sections[CHROME_PRIMER_SECTION] = CHROME_PRIMER;
			else delete sections[CHROME_PRIMER_SECTION];
			return undefined;
		}
		// Legacy pi without structured prompt sections: append the primer to the rendered prompt.
		if (!active) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n<${CHROME_PRIMER_SECTION}>\n${CHROME_PRIMER}\n</${CHROME_PRIMER_SECTION}>` };
	});

	const CHROME_PRIMER_SECTION = "chrome-profile-bridge";
	const CHROME_PRIMER = `Chrome control is available through the chrome_* tools via a companion Chrome extension installed in the user's normal Chrome profile. Tools target the existing signed-in profile: no remote-debug port, no throwaway profile.

Tab/window isolation (important):
- pi-chrome owns a dedicated automation window/tab. When a chrome_* tool runs with no explicit target, it acts on that pi-chrome-owned target — it never reuses or overwrites the user's currently active tab. The dedicated target is created on first use and reused afterward.
- To act on a specific *existing* tab (e.g. one the user asks you to use), pass targetId/urlIncludes/titleIncludes. Without one of those, assume you are working in pi-chrome's own automation target.
- pi-chrome's automation target may be closed automatically when Chrome control is revoked; user tabs/windows are never closed by pi-chrome.

Capability model (important):
- Interactive controls (click/type/fill/key/hover/drag/scroll/tap) use Chrome's real input layer via chrome.debugger / CDP. Events satisfy normal user-activation gates.
- Input bypasses page CSP because it is injected at browser input layer, not page JavaScript. Chrome may show the “Pi Chrome Connector started debugging this browser” banner while attached.
- \`chrome_evaluate\` and \`chrome_snapshot\` run in MAIN world via **CDP \`Runtime.evaluate\`**, which is not subject to the page's Content-Security-Policy. They work even on strict-CSP pages (e.g. github.com, many bank/SaaS apps) that block \`'unsafe-eval'\`. \`chrome_navigate initScript\` likewise injects at document_start via CDP and bypasses CSP. \`chrome_screenshot\`, \`chrome_tab\`, and Chrome input also work under any CSP.
- Input tools return structured details and support \`includeSnapshot=true\` on click/type/fill/key. Use the fresh snapshot to verify state instead of repeating blindly. If the action started a navigation, the snapshot waits (up to 5s) for the new page.
- \`chrome_type\` never replaces: with a uid/selector it appends at the end of the field; without one it types at the current caret. Check its before/after report. Use \`chrome_fill\` to replace a field.
- Chrome ignores real input to hidden pages (inactive tabs, minimized windows, windows behind a macOS full-screen window). Input tools report this instead of silently doing nothing; retry with background:false only when bringing the tab forward is acceptable.
- \`chrome_cdp\` runs any raw CDP method on a tab (emulation, cookies, PDF, accessibility tree, etc.) when no dedicated chrome_* tool fits; \`chrome_cdp_targets\` diagnoses debugger/overlay conflicts.

Usage rules:
1. If a chrome_* tool says Chrome control is locked, ask the user to run \`/chrome authorize\` before retrying.
2. \`chrome_snapshot\` before clicking/typing; pass \`uid\` over \`selector\`.
3. \`includeSnapshot=true\` on click/type/fill/key to verify in one round trip.
4. If \`chrome_evaluate\` returns null when you expected a value, the expression evaluated to null/undefined in the page; surface the value via \`JSON.stringify\` to confirm.
5. \`chrome_navigate\` supports an optional \`initScript\` that runs at document_start in MAIN world for the next navigation (good for seeding localStorage or stubbing Date.now).
6. /chrome background on (default) is a hard policy: per-call \`background=false\` cannot override it, new tabs stay inactive, and \`chrome_tab activate\` is blocked. Ask the user to run /chrome background off when they want foreground/watch mode. With background off, per-call \`background=true\` still avoids explicit focus/tab activation. Screenshots use CDP without activating background tabs; debugger failures never fall back to tab activation. Page scripts, trusted input, native prompts, and Chrome/OS behavior can still affect focus.
7. If you hit a native file-picker or privileged browser prompt gate, tell the user; generic clicks/typing/CSP gates are handled by Chrome input.
8. Run /chrome doctor when in doubt about connectivity or capabilities.`;

	// Shared handlers, dispatched by the unified /chrome command below.
	const doctorHandler = async (ctx: ExtensionContext) => {
			ctx.ui.notify("Checking pi-chrome…", "info");
			const lines: string[] = [
				`pi-chrome v${PI_CHROME_VERSION}`,
				`• Authorization: ${authSummary()}.`,
				`• Background: ${backgroundEnabled ? "on (hard)" : "off (foreground/watch mode)"}.`,
			];
			const status = bridge.status();
			const roleLabel = status.mode === "client" ? "sharing another pi session's connection" : "running the Chrome connection for this machine";
			lines.push(`• This pi session is ${roleLabel}.`);
			let extensionAlive = false;
			let versionMismatch = false;
			try {
				const started = Date.now();
				const version = (await bridge.send("tab.version", {}, 35_000)) as {
					extensionId?: string;
					extensionVersion?: string;
					bridgeUrl?: string;
				};
				const latencyMs = Date.now() - started;
				extensionAlive = true;
				if (version.extensionVersion && version.extensionVersion !== PI_CHROME_VERSION) {
					versionMismatch = true;
					lines.push(
						`✗ The Chrome companion extension is on an old version (${version.extensionVersion}); this pi-chrome is ${PI_CHROME_VERSION}.`,
						`  Every Chrome action will run with the old code until you reload the extension.`,
						`  Fix: open chrome://extensions and click the refresh icon on 'Pi Chrome Connector'.`,
						`  (After this one-time fix, future updates reload automatically.)`,
					);
				} else {
					lines.push(`✓ Chrome is connected (companion extension v${version.extensionVersion ?? "?"}, responded in ${latencyMs}ms).`);
				}
			} catch (error) {
				const message = (error as Error).message;
				lines.push(`✗ Chrome isn't responding: ${message}`);
				if (message.includes("older pi-chrome without multi-session")) {
					lines.push("  Fix: quit and restart the pi session that first opened the Chrome connection (it was on an older pi-chrome).");
				} else {
					lines.push("  Fix: run /chrome onboard to install the Chrome companion extension, then keep that Chrome window open.");
				}
			}

			if (extensionAlive && !versionMismatch) {
				// Sanity-check that pi-chrome can actually run code in the active tab.
				try {
					const value = await bridge.send("page.evaluate", { expression: "1+1", awaitPromise: true, foreground: false }, 10_000);
					if (value === 2) lines.push(`✓ pi-chrome can run code in the active Chrome tab.`);
					else lines.push(`⚠ pi-chrome ran code in the active tab but got an unexpected result (${JSON.stringify(value)}). The current tab may be locked-down (a Chrome internal page or a strict site).`);
				} catch (error) {
					lines.push(`✗ pi-chrome can't run code in the active tab: ${(error as Error).message}`);
				}

				// Surface obvious site-side automation flags so the user knows why a site might block pi.
				try {
					const probe = (await bridge.send("page.probe", { foreground: false }, 10_000)) as Record<string, unknown>;
					if (probe && probe.arithmetic === 2) lines.push(`✓ The active tab is ${hostnameOf(String(probe.location))} and accepts pi-chrome's commands.`);
					if (probe && probe.webdriver) lines.push(`⚠ Your Chrome is reporting itself as automated to websites. Some sites use this signal to block sign-ins or bot checks.`);
				} catch (error) {
					lines.push(`⚠ Couldn't inspect the active tab: ${(error as Error).message}`);
				}

				// Pi's own tab for this session: hidden pages ignore clicks and typing, so say so up front.
				try {
					const own = (await bridge.send("automation.status", { sessionKey: sessionKeyFor(ctx), includeVisibility: true }, 10_000)) as
						| { tabId?: number | null; visibility?: string; hiddenReason?: string }
						| undefined;
					if (own?.tabId === null || own?.tabId === undefined) {
						lines.push(`• Pi hasn't opened its own tab in this session yet.`);
					} else if (own.visibility === "hidden") {
						lines.push(
							`⚠ Pi's tab is hidden because ${own.hiddenReason ?? "its window is not visible"}. Chrome ignores clicks and typing in hidden tabs, so those tools will fail until it's visible.`,
							`  Fix: bring Pi's window forward or uncover it, or run /chrome background off to let Pi bring it forward.`,
						);
					} else if (own.visibility === "visible") {
						lines.push(`✓ Pi's tab is visible, so clicks and typing will reach it.`);
					}
				} catch {
					// Older extensions or a closed tab: nothing useful to add.
				}
			} else if (versionMismatch) {
				lines.push(`… Skipped the remaining checks until you reload the Chrome extension.`);
			}

		ctx.ui.notify(lines.join("\n"), "info");
	};

	// Existing background setting is the hard policy. No args = toggle; no separate lock mode.
	const BACKGROUND_DESC: Record<string, string> = {
		on: "Hard background: pi-chrome will not explicitly focus windows or activate tabs; per-call foreground overrides and tab activation are blocked. Page/Chrome behavior can still affect focus.",
		off: "Foreground/watch mode: Chrome may come forward and switch tabs. Per-call background:true still avoids explicit focus/tab activation.",
	};

	const backgroundHandler = async (ctx: ExtensionContext, args: string) => {
		const arg = (args || "").trim().toLowerCase();
		const currentLabel = backgroundEnabled ? "on" : "off";

		if (arg === "status") {
			ctx.ui.notify(`Run in background is ${currentLabel}. ${BACKGROUND_DESC[currentLabel]}`, "info");
			return;
		}

		if (arg === "on" || arg === "true" || arg === "1") backgroundEnabled = true;
		else if (arg === "off" || arg === "false" || arg === "0") backgroundEnabled = false;
		else if (arg === "toggle" || arg === "") backgroundEnabled = !backgroundEnabled;
		else {
			ctx.ui.notify(`Unknown background setting '${arg}'. Pick one of: on | off | toggle | status.`, "warning");
			return;
		}

		const nextLabel = backgroundEnabled ? "on" : "off";
		ctx.ui.notify(`Run in background → ${nextLabel}. ${BACKGROUND_DESC[nextLabel]}`, "info");
	};

	const authorizeFor = async (ctx: ExtensionContext, label: string, until: number | "indefinite") => {
		const ok = await ctx.ui.confirm(
			"Authorize pi-chrome control?",
			`This Pi session will be allowed to inspect and control your existing Chrome profile for ${label}.\n\nChrome actions use your signed-in browser state and real input. Only approve if you trust the current agent/task.`,
		);
		if (!ok) {
			ctx.ui.notify("Chrome control remains locked.", "info");
			return;
		}
		const wasUsable = chromeToolsUsable;
		chromeAuthorizedUntil = until;
		persistAuth();
		activateChromeTools();
		chromeToolsUsable = true;
		logChromeToolChange(wasUsable ? "reauthorized" : "authorized", { label, authorizedUntil: until });
		scheduleAuthExpiry(ctx, until);
		ctx.ui.notify(`Chrome control authorized for ${label}.`, "info");
		updateChromeStatus(ctx);
	};

	const parseAuthorizeArg = (arg: string): { label: string; until: number | "indefinite" } | undefined => {
		const normalized = arg.trim().toLowerCase() || "15m";
		if (normalized === "indefinite" || normalized === "forever") return { label: "indefinitely", until: "indefinite" };
		const minutes = normalized.endsWith("m") ? Number(normalized.slice(0, -1)) : Number(normalized);
		if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
		return { label: `${minutes} minutes`, until: Date.now() + minutes * 60_000 };
	};

	const authorizeHandler = async (ctx: ExtensionContext, args: string) => {
		const grant = parseAuthorizeArg(args);
		if (!grant) {
			ctx.ui.notify("Unknown authorize duration. Use minutes (15m, 30m, 45) or indefinite.", "warning");
			return;
		}
		return authorizeFor(ctx, grant.label, grant.until);
	};

	const revokeHandler = (ctx: ExtensionContext) => {
		lockChromeControl("revoked");
		ctx.ui.notify("Chrome control locked. Run /chrome authorize to allow chrome_* tools again.", "info");
		updateChromeStatus(ctx);
	};

	const onboardHandler = async (ctx: ExtensionContext) => {
		const extensionPath = browserExtensionPath();
		const proceed = await ctx.ui.confirm(
			"Install the pi-chrome Chrome extension?",
			`This opens Chrome's extensions page and reveals the folder pi-chrome needs you to load.\n\nWhen the windows open, in Chrome:\n  1. Turn on 'Developer mode' (top-right toggle).\n  2. Click 'Load unpacked' and choose the folder that just opened in Finder, or paste this path:\n     ${extensionPath}\n\nPress Enter to continue, or Esc to cancel.`,
		);
		if (!proceed) {
			ctx.ui.notify("Cancelled. You can run /chrome onboard again whenever you're ready.", "info");
			return;
		}
		if (process.platform === "darwin") {
			await pi.exec("open", ["-a", "Google Chrome", "chrome://extensions"], { cwd: workspaceCwd(ctx), timeout: 5_000 }).catch(() => undefined);
			await pi.exec("open", ["-R", extensionPath], { cwd: workspaceCwd(ctx), timeout: 5_000 }).catch(() => undefined);
			await pi.exec("sh", ["-lc", `printf %s ${JSON.stringify(extensionPath)} | pbcopy`], { cwd: workspaceCwd(ctx), timeout: 5_000 }).catch(() => undefined);
		}
		ctx.ui.notify(
			"Chrome and Finder should be open. The extension folder path is on your clipboard. After you click 'Load unpacked' and pick it, run /chrome doctor to confirm everything is connected.",
			"info",
		);
	};

	// Lightweight connection/auth/background header for the bare-/chrome picker. No page probes.
	const statusSummary = async (): Promise<string> => {
		const parts: string[] = [];
		try {
			const version = (await bridge.send("tab.version", {}, 5_000)) as { extensionVersion?: string };
			if (version.extensionVersion && version.extensionVersion !== PI_CHROME_VERSION) {
				parts.push(`⚠ Chrome extension v${version.extensionVersion} (pi-chrome v${PI_CHROME_VERSION}, reload extension)`);
			} else {
				parts.push(`✓ Chrome connected`);
			}
		} catch {
			parts.push(`✗ Chrome not responding`);
		}
		parts.push(`auth: ${authSummary()}`);
		parts.push(`background: ${backgroundEnabled ? "on (hard)" : "off"}`);
		return parts.join(" · ");
	};

	const openAuthorizeMenu = async (ctx: ExtensionContext): Promise<void> => {
		while (true) {
			const choice = await ctx.ui.select("Authorize Chrome control", [
				"15 minutes",
				"30 minutes",
				"Indefinite",
				"Custom minutes",
			]);
			if (!choice) return;
			switch (choice) {
				case "15 minutes": return authorizeHandler(ctx, "15m");
				case "30 minutes": return authorizeHandler(ctx, "30m");
				case "Indefinite": return authorizeHandler(ctx, "indefinite");
				case "Custom minutes": {
					const value = await ctx.ui.input("Authorize for how many minutes?", "45");
					if (!value) continue;
					return authorizeHandler(ctx, value);
				}
			}
		}
	};

	const openBackgroundMenu = async (ctx: ExtensionContext): Promise<void> => {
		const choice = await ctx.ui.select("Background / watch mode", [
			"Use Chrome in background",
			"Use Chrome in foreground",
		]);
		if (!choice) return;
		switch (choice) {
			case "Use Chrome in background": return backgroundHandler(ctx, "on");
			case "Use Chrome in foreground": return backgroundHandler(ctx, "off");
		}
	};

	const openCommandMenu = async (ctx: ExtensionContext): Promise<void> => {
		while (true) {
			ctx.ui.notify("Checking Chrome connection…", "info");
			const choice = await ctx.ui.select(`pi-chrome\n${await statusSummary()}`, [
				"Authorize Chrome control…",
				"Lock Chrome control",
				"Doctor / troubleshoot",
				"Background / watch mode…",
				"Install / onboard extension",
			]);
			if (!choice) return;
			switch (choice) {
				case "Authorize Chrome control…": await openAuthorizeMenu(ctx); continue;
				case "Lock Chrome control": return revokeHandler(ctx);
				case "Doctor / troubleshoot": return doctorHandler(ctx);
				case "Background / watch mode…": await openBackgroundMenu(ctx); continue;
				case "Install / onboard extension": return onboardHandler(ctx);
			}
		}
	};

	pi.registerCommand("chrome", {
		description:
			"All pi-chrome controls in one place.\n  /chrome authorize [15m|30m|<minutes>|indefinite] — allow this Pi session to use chrome_* tools.\n  /chrome revoke   — lock Chrome control.\n  /chrome doctor   — full health check plus authorization and background state.\n  /chrome onboard  — install the Chrome companion extension.\n  /chrome background [on|off|status|toggle] — enforce no explicit focus/tab activation, or allow foreground/watch mode.\nRun with no arguments for an interactive picker that shows current state.",
		getArgumentCompletions: (prefix) => {
			const raw = prefix;
			const trimmedRight = raw.replace(/\s+$/, "");
			const tokens = trimmedRight ? trimmedRight.split(/\s+/) : [];
			const endsWithSpace = raw.length > 0 && raw !== trimmedRight;
			// Path = completed tokens; partial = the token currently being typed (or "" if cursor sits right after a space).
			const partial = endsWithSpace ? "" : (tokens.pop() ?? "");
			const path = tokens.map((t) => t.toLowerCase());
			const partialLower = partial.toLowerCase();

			// Build candidate set with FULL argument-text values so pi-tui's apply-completion
			// (which replaces the entire argument) lands correctly even for nested paths.
			type Item = { fullValue: string; label: string; description: string };
			let candidates: Item[] = [];
			if (path.length === 0) {
				candidates = [
					{ fullValue: "authorize", label: "authorize", description: "Allow this Pi session to use chrome_* tools." },
					{ fullValue: "revoke", label: "revoke", description: "Lock Chrome control for this Pi session." },
					{ fullValue: "doctor", label: "doctor", description: "Full diagnostics: connection, version, page checks, authorization, and background state." },
					{ fullValue: "onboard", label: "onboard", description: "Install the Chrome companion extension (first-time setup)." },
					{ fullValue: "background", label: "background", description: "Enforce hard background or allow foreground/watch mode." },
				];
			} else if (path[0] === "authorize" && path.length === 1) {
				candidates = [
					{ fullValue: "authorize 15m", label: "15m", description: "Authorize Chrome control for 15 minutes." },
					{ fullValue: "authorize 30m", label: "30m", description: "Authorize Chrome control for 30 minutes." },
					{ fullValue: "authorize indefinite", label: "indefinite", description: "Authorize Chrome control until revoked or Pi exits." },
				];
			} else if (path[0] === "background" && path.length === 1) {
				candidates = [
					{ fullValue: "background on", label: "on", description: "Hard background: block explicit focus/tab activation and per-call foreground overrides. (default)" },
					{ fullValue: "background off", label: "off", description: "Bring Chrome to the front so you can watch." },
					{ fullValue: "background toggle", label: "toggle", description: "Flip whichever way it's currently set." },
					{ fullValue: "background status", label: "status", description: "Show the current setting." },
				];
			}
			if (candidates.length === 0) return null;
			const filtered = candidates.filter((c) => c.label.toLowerCase().startsWith(partialLower));
			if (filtered.length === 0) return null;
			return filtered.map((c) => ({ value: c.fullValue, label: c.label, description: c.description }));
		},
		handler: async (args, ctx) => {
			const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
			if (tokens.length === 0) {
				await openCommandMenu(ctx);
				return;
			}
			const [head, ...rest] = tokens;
			const subArgs = rest.join(" ");
			switch (head) {
				case "authorize": return authorizeHandler(ctx, subArgs);
				case "revoke": return revokeHandler(ctx);
				case "doctor": return doctorHandler(ctx);
				case "onboard": return onboardHandler(ctx);
				case "background":
					return backgroundHandler(ctx, subArgs);
				case "settings": {
					// Legacy nested form: /chrome settings background ...
					const [setting, ...settingArgs] = rest;
					if (setting === "background") return backgroundHandler(ctx, settingArgs.join(" "));
					ctx.ui.notify(`'/chrome settings' was removed. Use /chrome background directly.`, "warning");
					return;
				}
				default:
					ctx.ui.notify(`Unknown subcommand '${head}'. Run /chrome for current state and controls, or try: /chrome authorize | revoke | doctor | onboard | background.`, "warning");
			}
		},
	});

	function registerChromeTools(pi: ExtensionAPI): void {
		if (chromeToolsRegistered) return;
		chromeToolsRegistered = true;

	pi.registerTool({
		name: "chrome_launch",
		label: "Chrome Bridge Setup",
		description:
			"Start/check the local bridge used by the companion Chrome extension. This does not launch a separate Chrome profile; install the unpacked Chrome extension in your existing Chrome profile to connect.",
		promptSnippet: "Show instructions for connecting Pi to the user's existing Chrome profile via the companion extension.",
		parameters: Type.Object({
			port: Type.Optional(Type.Number({ description: "Ignored. The bundled Chrome extension polls 127.0.0.1:17318." })),
			url: Type.Optional(Type.String({ description: "Optional URL to open in the existing Chrome profile after the extension is connected." })),
			userDataDir: Type.Optional(Type.String({ description: "Ignored. This bridge intentionally uses the user's existing Chrome profile through the companion extension." })),
			useDefaultProfile: Type.Optional(Type.Boolean({ description: "Ignored; existing-profile access comes from the companion Chrome extension." })),
			headless: Type.Optional(Type.Boolean({ description: "Ignored." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx): Promise<ToolTextResult> {
			const status = await bridge.connectionStatus();
			if (params.url && status.connected === true) {
				const result = await authorizedBridgeSend("tab.new", { url: params.url }, DEFAULT_TIMEOUT_MS, signal);
				return { content: [{ type: "text", text: `Chrome bridge connected; opened ${params.url}` }], details: { status, result } };
			}
			return {
				content: [
					{
						type: "text",
						text:
							`Chrome profile bridge is listening at ${bridge.url}.\n\n` +
							`To connect your existing Chrome profile:\n` +
							`1. Open chrome://extensions in the Chrome profile you normally use.\n` +
							`2. Enable Developer mode.\n` +
							`3. Click “Load unpacked”.\n` +
							`4. Select: ${browserExtensionPath()}\n\n` +
							`Status: ${status.connected === true ? "connected" : "waiting for extension"}.`,
					},
				],
				details: { status, extensionPath: browserExtensionPath() },
			};
		},
	});

	pi.registerTool({
		name: "chrome_tab",
		label: "Chrome Tab",
		description: "List, create, activate, close, group, ungroup, or inspect tabs in the user's existing Chrome profile via the companion extension. New/grouped tabs always use this session's Pi tab group. Background mode keeps new tabs inactive and blocks activate; ask the user to run /chrome background off for foreground/watch mode. activate/close/group/ungroup require a target (targetId/urlIncludes/titleIncludes); with no target they act on this session's pi-chrome automation tab if one exists, and otherwise error rather than touching the user's active tab.",
		promptSnippet: "List/open/activate/close/group existing Chrome tabs through the companion extension.",
		parameters: Type.Object({
			action: StringEnum(tabActionValues),
			url: Type.Optional(Type.String({ description: "URL for action=new." })),
			targetId: Type.Optional(Type.String({ description: "Chrome tab id for activate/close/group/ungroup." })),
			urlIncludes: Type.Optional(Type.String({ description: "Match the target tab by URL substring for activate/close/group/ungroup." })),
			titleIncludes: Type.Optional(Type.String({ description: "Match the target tab by title substring for activate/close/group/ungroup." })),
			group: Type.Optional(Type.Boolean({ description: "Deprecated; ignored. Pi-created tabs always join this session's own tab group." })),
			groupTitle: Type.Optional(Type.String({ description: "Deprecated for action=new/group; ignored so one Pi session uses one tab group ('Pi Session: <name-or-id>')." })),
			groupColor: Type.Optional(Type.String({ description: "Tab group color for action=group/new: grey, blue, red, yellow, green, pink, purple, cyan, or orange. Defaults to blue." })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal, _onUpdate, ctx): Promise<ToolTextResult> {
			const forwarded = { ...params } as typeof params & { groupTitle?: string };
			// Force every Pi-opened/explicitly-grouped tab into this session's own group,
			// named after the session display name (falling back to the session id). There is
			// intentionally no opt-out: one Pi session should create/use one tab group.
			if (params.action === "new" || params.action === "group") {
				forwarded.groupTitle = sessionGroupTitle(ctx);
			}
			const result = await authorizedBridgeSend(`tab.${params.action}`, forwarded, DEFAULT_TIMEOUT_MS, signal);
			if (params.action === "list") {
				const tabs = result as Array<{ id: number; title: string; url: string; active: boolean; windowId: number; group?: { title?: string } | null }>;
				const text = tabs.map((tab) => `${tab.id}\t${tab.active ? "*" : " "}\t${tab.group?.title ? `[${tab.group.title}] ` : ""}${tab.title || "(untitled)"}\t${tab.url}`).join("\n") || "No tabs.";
				return { content: [{ type: "text", text }], details: { tabs } };
			}
			return { content: [{ type: "text", text: safeJson(result) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_snapshot",
		label: "Chrome Snapshot",
		description:
			"Inspect a page in the user's existing Chrome profile. Default output is a concise, agent-friendly observation with structural layout/context, stable uids, visible actions, form fields, page hints, and changes since the previous snapshot. Use mode/query/nearUid to zoom instead of dumping the whole page. Background mode (default) blocks explicit focus/tab activation even with background=false. Ask the user to run /chrome background off for foreground/watch mode.",
		promptSnippet: "Observe the current Chrome page: concise summary, structural layout, visible actions, forms, page map, query matches, and stable uids.",
		parameters: Type.Object({
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS })),
			mode: Type.Optional(StringEnum(snapshotModeValues)),
			query: Type.Optional(Type.String({ description: "Find/rank elements, regions, and text matching this phrase, e.g. 'merge button', 'email error', 'approve PR'." })),
			maxTextChars: Type.Optional(Type.Number({ description: "Max body text chars included in the underlying snapshot. Defaults are smaller for concise modes." })),
			containingText: Type.Optional(Type.String({ description: "Only return elements whose label/text contains this string (case-insensitive). Useful when the page has many controls." })),
			roleFilter: Type.Optional(Type.String({ description: "Only return elements matching this ARIA role or tag name (case-insensitive). e.g. 'button', 'link', 'textbox'." })),
			nearUid: Type.Optional(Type.String({ description: "Sort elements by proximity to this snapshot uid. Useful for finding controls near a known anchor." })),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const snapshot = await authorizedBridgeSend(
				"page.snapshot",
				{ ...params, maxElements: params.maxElements ?? MAX_ELEMENTS },
				DEFAULT_TIMEOUT_MS,
				signal,
			);
			return { content: [{ type: "text", text: formatChromeSnapshot(snapshot) }], details: { snapshot } };
		},
	});

	pi.registerTool({
		name: "chrome_find",
		label: "Chrome Find",
		description:
			"Find elements, page regions, or text on the current Chrome page by query. Returns ranked matches with stable uids and coordinates. This is a focused wrapper around chrome_snapshot({ query }).",
		promptSnippet: "Find matching controls/text/regions in Chrome by natural-language query and return stable uids.",
		parameters: Type.Object({
			query: Type.String({ description: "What to find, e.g. 'merge button', 'email error', 'approve PR', 'search box'." }),
			mode: Type.Optional(StringEnum(snapshotModeValues)),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const snapshot = await authorizedBridgeSend(
				"page.snapshot",
				{ ...params, mode: params.mode || "auto", maxElements: params.maxElements ?? MAX_ELEMENTS },
				DEFAULT_TIMEOUT_MS,
				signal,
			);
			return { content: [{ type: "text", text: formatChromeSnapshot(snapshot) }], details: { snapshot } };
		},
	});

	pi.registerTool({
		name: "chrome_inspect",
		label: "Chrome Inspect Element",
		description:
			"Inspect one snapshot uid or selector deeply: nearby text, nearby actions, form context, ancestors, and suggested click target. Use after chrome_snapshot/chrome_find when you need context around one element.",
		promptSnippet: "Inspect a Chrome snapshot uid deeply for nearby text, form context, and suggested actions.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot/chrome_find." })),
			selector: Type.Optional(Type.String({ description: "CSS selector if uid is unavailable." })),
			scrollIntoView: Type.Optional(Type.Boolean({ description: "If true, scroll the target into view before inspecting. Default false to avoid changing page state." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			try {
				const inspect = await authorizedBridgeSend("page.inspect", params, DEFAULT_TIMEOUT_MS, signal);
				return { content: [{ type: "text", text: formatChromeInspect(inspect) }], details: { inspect } };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!/Unknown action: page\.inspect/i.test(message)) throw error;
				// Compatibility fallback for a loaded Chrome extension service worker that has not
				// been reloaded since chrome_inspect was added. It is less rich than page.inspect,
				// but still gives useful nearby candidates instead of failing the workflow.
				const snapshot = await authorizedBridgeSend(
					"page.snapshot",
					{
						...params,
						mode: "interactive",
						maxElements: MAX_ELEMENTS,
						nearUid: params.uid,
						query: params.selector,
					},
					DEFAULT_TIMEOUT_MS,
					signal,
				);
				const text = `chrome_inspect fallback: loaded Chrome extension does not yet support page.inspect; reload it at chrome://extensions for deep inspect.\n\n${formatChromeSnapshot(snapshot)}`;
				return { content: [{ type: "text", text }], details: { snapshot, fallback: "page.snapshot" } };
			}
		},
	});

	pi.registerTool({
		name: "chrome_navigate",
		label: "Chrome Navigate",
		description:
			"Navigate a Chrome tab to a URL via the companion extension. With no target, navigation goes to pi-chrome's own dedicated automation window/tab — it never replaces the user's active tab. Pass targetId/urlIncludes/titleIncludes only to act on a specific existing tab. Background mode (default) blocks explicit focus/tab activation even with background=false; /chrome background off allows foreground/watch mode. Optionally waits for load completion.",
		promptSnippet: "Navigate a Chrome tab in the user's existing profile.",
		parameters: Type.Object({
			url: Type.String(),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			waitUntilLoad: Type.Optional(Type.Boolean({ default: true })),
			timeoutMs: Type.Optional(Type.Number({ default: 15_000 })),
			initScript: Type.Optional(Type.String({ description: "Optional JavaScript source to run in MAIN world at document_start of the next navigation. Useful for seeding localStorage, stubbing Date.now(), or defining navigator.webdriver=undefined. Requires the companion extension's webNavigation permission." })),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.navigate", params, (params.timeoutMs ?? 15_000) + 2_000, signal);
			return { content: [{ type: "text", text: `Navigated to ${params.url}${params.initScript ? " (with initScript)" : ""}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_evaluate",
		label: "Chrome Evaluate",
		description:
			"Evaluate JavaScript in an existing Chrome tab through the companion extension. Runs in the page context and returns JSON-serializable values when possible. Background mode (default) blocks explicit focus/tab activation even with background=false; /chrome background off allows foreground/watch mode.",
		promptSnippet: "Evaluate JavaScript in the active Chrome tab through the companion extension.",
		parameters: Type.Object({
			expression: Type.String(),
			awaitPromise: Type.Optional(Type.Boolean({ default: true })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const value = await authorizedBridgeSend("page.evaluate", params, DEFAULT_TIMEOUT_MS, signal);
			const text = value === undefined
				? "undefined"
				: typeof value === "string"
					? value
					: safeJson(value) ?? "undefined";
			return { content: [{ type: "text", text: truncateText(text) }], details: { value: value as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_click",
		label: "Chrome Click",
		description:
			"Click a snapshot uid, CSS selector, or viewport coordinate using Chrome's real input layer. Pass includeSnapshot=true to return a fresh snapshot after the click.",
		promptSnippet: "Click page elements in Chrome by snapshot uid, selector, or viewport coordinate.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot. Prefer uid over selector after taking a snapshot." })),
			selector: Type.Optional(Type.String({ description: "CSS selector to click. Prefer uid from chrome_snapshot when available." })),
			x: Type.Optional(Type.Number({ description: "Viewport x coordinate if uid/selector is omitted." })),
			y: Type.Optional(Type.Number({ description: "Viewport y coordinate if uid/selector is omitted." })),
			domFallback: Type.Optional(Type.Boolean({ description: "If true (default), fall back to DOM-dispatched click if Chrome's CDP input path is blocked (extension overlay, debugger failure, or a hidden tab that ignores trusted input)." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after the click." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = await authorizedBridgeSend("page.click", params, DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const target = params.uid ?? params.selector ?? `${params.x},${params.y}`;
			const text = summary ? `Clicked ${target} — ${summary}` : `Clicked ${target}`;
			return { content: [{ type: "text", text: formatIncludedSnapshotText(raw, text) }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_type",
		label: "Chrome Type",
		description:
			"Type using Chrome's real input. With a snapshot uid or CSS selector, chrome_type clicks the field and moves the caret to the end, so text is appended to existing content; without one it types at the current caret of the focused element. It does NOT replace existing text. Use chrome_fill (or replace=true) to replace a field's value. Contenteditables use one native text insertion; other fields use key events. Set perCharacter=true for editors needing individual keydown events. The result reports the field value before/after and insertedAt (empty|caret-end|caret-middle|replaced-selection|replaced-all), with a warning when text was spliced into existing content. Pass includeSnapshot=true to verify after typing; if the action starts a navigation, the snapshot waits (up to 5s) for it to load.",
		promptSnippet: "Type text in Chrome; a uid/selector target appends at the end (does not replace existing text; use chrome_fill or replace=true).",
		parameters: Type.Object({
			text: Type.String(),
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot." })),
			selector: Type.Optional(Type.String({ description: "CSS selector to focus before typing." })),
			replace: Type.Optional(Type.Boolean({ default: false, description: "If true, select all of the focused field's contents and delete them before typing (real key events). Reports replaced:true." })),
			perCharacter: Type.Optional(Type.Boolean({ default: false, description: "Send individual key events even in contenteditables. Default: one native text insertion for contenteditables; key events for other fields." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after typing." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			pressEnter: Type.Optional(Type.Boolean()),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = await authorizedBridgeSend("page.type", params, DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const into = params.uid || params.selector ? ` into ${params.uid ?? params.selector}` : "";
			const base = `Typed ${params.text.length} character(s)${into}${params.replace ? " (replacing existing contents)" : ""}.`;
			const lines = [summary ? `${base} (${summary})` : base, ...describeTypeEvidence(result, params.text.length, params.pressEnter === true)];
			return { content: [{ type: "text", text: formatIncludedSnapshotText(raw, lines.join("\n")) }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_fill",
		label: "Chrome Fill",
		description:
			"Replace the whole value of a text input, textarea, or contenteditable using Chrome click/select/delete/type input. Unlike chrome_type, existing contents are cleared first. Contenteditables use one native text insertion; perCharacter=true retains individual keydown events. Accepts a snapshot uid or CSS selector. Pass includeSnapshot=true to verify after filling.",
		promptSnippet: "Fill a Chrome form field by snapshot uid or selector, optionally returning a fresh snapshot.",
		parameters: Type.Object({
			text: Type.String(),
			uid: Type.Optional(Type.String({ description: "Stable element uid from chrome_snapshot." })),
			selector: Type.Optional(Type.String({ description: "CSS selector to fill if uid is omitted." })),
			perCharacter: Type.Optional(Type.Boolean({ default: false, description: "Send individual key events even in contenteditables. Default: one native text insertion for contenteditables; key events for other fields." })),
			submit: Type.Optional(Type.Boolean({ description: "If true, press Enter after filling." })),
			domFallback: Type.Optional(Type.Boolean({ description: "If true (default), fall back to DOM value-setting if Chrome's CDP input path is blocked (extension overlay, debugger failure, or a hidden tab that ignores trusted input)." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after filling." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = await authorizedBridgeSend("page.fill", params, DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const into = params.uid || params.selector ? ` into ${params.uid ?? params.selector}` : "";
			const base = `Filled ${params.text.length} character(s)${into}.`;
			const text = summary ? `${base} (${summary})` : base;
			return { content: [{ type: "text", text: formatIncludedSnapshotText(raw, text) }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_key",
		label: "Chrome Key",
		description:
			"Send a keyboard key to an existing Chrome tab (Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, or one character). Background mode (default) blocks explicit focus/tab activation even with background=false; /chrome background off allows foreground/watch mode. Pass includeSnapshot=true to verify after the keypress.",
		promptSnippet: "Press keys in Chrome through the companion extension.",
		parameters: Type.Object({
			key: Type.String(),
			modifiers: Type.Optional(Type.Object({
				shiftKey: Type.Optional(Type.Boolean()),
				ctrlKey: Type.Optional(Type.Boolean()),
				altKey: Type.Optional(Type.Boolean()),
				metaKey: Type.Optional(Type.Boolean()),
			}, { description: "Modifier keys to hold while pressing the key. Shift alone types the shifted US-layout character (a → A, 1 → !); Ctrl/Meta/Alt chords do not insert literal text." })),
			includeSnapshot: Type.Optional(Type.Boolean({ description: "If true, include a fresh chrome_snapshot result after the keypress." })),
			maxElements: Type.Optional(Type.Number({ default: MAX_ELEMENTS, description: "Max elements in the included snapshot." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const raw = await authorizedBridgeSend("page.key", params, DEFAULT_TIMEOUT_MS, signal);
			const result = (params.includeSnapshot ? (raw as { result: unknown }).result : raw) as Json;
			const summary = summarizeActionResult(result);
			const base = `Pressed ${params.key}.`;
			const text = summary ? `${base} (${summary})` : base;
			return { content: [{ type: "text", text: formatIncludedSnapshotText(raw, text) }], details: { result: raw as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_wait_for",
		label: "Chrome Wait For",
		description: "Poll an existing Chrome tab until a selector exists or a JavaScript expression returns truthy.",
		promptSnippet: "Wait for page state in Chrome before further automation.",
		parameters: Type.Object({
			kind: StringEnum(waitForValues),
			value: Type.String({ description: "CSS selector when kind=selector; JavaScript expression when kind=expression." }),
			timeoutMs: Type.Optional(Type.Number({ default: 10_000 })),
			intervalMs: Type.Optional(Type.Number({ default: 250 })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.waitFor", params, (params.timeoutMs ?? 10_000) + 2_000, signal);
			return { content: [{ type: "text", text: `Observed ${params.kind}: ${params.value}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_list_console_messages",
		label: "Chrome Console Messages",
		description:
			"List console messages captured in the page by the companion extension. Capture starts after any chrome_snapshot, chrome_evaluate, chrome_list_console_messages, or chrome_list_network_requests call installs page instrumentation.",
		promptSnippet: "List captured console messages from the active Chrome page.",
		parameters: Type.Object({
			clear: Type.Optional(Type.Boolean({ description: "Clear the captured console log after reading." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.console.list", params, DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: truncateText(safeJson(result)) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_list_network_requests",
		label: "Chrome Network Requests",
		description:
			"List fetch/XMLHttpRequest activity captured in the page by the companion extension. Capture starts after instrumentation is installed by snapshot/evaluate/network/console tools; browser document/static asset requests are not captured. Use includePreservedRequests=true to keep requests from earlier same-tab navigations that were captured before navigation.",
		promptSnippet: "List captured XHR/fetch requests from the active Chrome page before doing DOM-heavy debugging.",
		parameters: Type.Object({
			includePreservedRequests: Type.Optional(Type.Boolean({ description: "Include captured requests from earlier locations in the same tab/session." })),
			clear: Type.Optional(Type.Boolean({ description: "Clear the captured request log after reading." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.network.list", params, DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: truncateText(safeJson(result)) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_get_network_request",
		label: "Chrome Network Request",
		description: "Retrieve one captured fetch/XMLHttpRequest entry, including response body when available, by requestId from chrome_list_network_requests.",
		promptSnippet: "Fetch captured request details and response body by requestId.",
		parameters: Type.Object({
			requestId: Type.String({ description: "Request id returned by chrome_list_network_requests." }),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.network.get", params, DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: truncateText(safeJson(result)) }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_screenshot",
		label: "Chrome Screenshot",
		description:
			"Capture a screenshot of a Chrome tab via CDP and save it to disk without activating background tabs. Requires debugger access; failures never fall back to activating a tab. Background mode (default) ignores background=false; /chrome background off allows foreground/watch mode.",
		promptSnippet: "Capture Chrome screenshots and save them under .pi/chrome-screenshots by default.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Output path. Defaults to .pi/chrome-screenshots/<timestamp>.<format>." })),
			format: Type.Optional(StringEnum(imageFormatValues)),
			quality: Type.Optional(Type.Number({ minimum: 0, maximum: 100, description: "JPEG quality 0-100." })),
			fullPage: Type.Optional(Type.Boolean({ description: "Capture full-page tiles plus a JSON manifest. Temporarily scrolls the target page; does not activate background tabs." })),
			retentionDays: Type.Optional(Type.Number({ minimum: 0, description: "Default-folder captures older than this many days are pruned (the newest 20 are always kept). Default 7; 0 disables pruning. Explicit paths are never pruned." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
			host: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, signal, _onUpdate, ctx: ExtensionContext): Promise<ToolTextResult> {
			const format = params.format ?? "png";
			const cwd = workspaceCwd(ctx);
			const screenshotDir = join(cwd, ".pi", "chrome-screenshots");
			const defaultPath = join(screenshotDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.${format}`);
			const outputPath = params.path ? resolve(cwd, params.path) : defaultPath;
			const prune = () => (params.path ? Promise.resolve(0) : pruneScreenshotDir(screenshotDir, params.retentionDays));
			const result = (await authorizedBridgeSend("page.screenshot", params, params.fullPage ? 120_000 : DEFAULT_TIMEOUT_MS, signal)) as {
				dataUrl?: string;
				method?: string;
				tab?: unknown;
				fullPage?: boolean;
				dimensions?: { width: number; height: number; viewportHeight: number; dpr: number };
				tiles?: Array<{ y: number; dataUrl: string }>;
			};
			await mkdir(dirname(outputPath), { recursive: true });
			if (result.fullPage && result.tiles && result.dimensions) {
				// Stitch via PNG if format is png; otherwise we fall back to writing tile files and a
				// manifest. We avoid pulling in an image library by writing each tile next to the main
				// path with a -tileN suffix and a stitched.json manifest.
				const { width, height, viewportHeight, dpr } = result.dimensions;
				const manifest: Array<{ path: string; y: number }> = [];
				for (let i = 0; i < result.tiles.length; i++) {
					const tile = result.tiles[i];
					const tilePath = outputPath.replace(/(\.[^.]+)$/, `-tile${i}$1`);
					const base64 = tile.dataUrl.replace(/^data:image\/(?:png|jpeg);base64,/, "");
					await writeFile(tilePath, Buffer.from(base64, "base64"));
					manifest.push({ path: tilePath, y: tile.y });
				}
				await writeFile(outputPath + ".json", JSON.stringify({ width, height, viewportHeight, dpr, tiles: manifest }, null, 2));
				await prune();
				return {
					content: [{ type: "text", text: `Saved ${result.tiles.length} full-page tile(s) for ${width}×${height}px page. Manifest: ${outputPath}.json` }],
					details: { manifest: outputPath + ".json", tiles: manifest, dimensions: result.dimensions, tab: result.tab, method: result.method } as unknown as Record<string, unknown>,
				};
			}
			if (!result.dataUrl) throw new Error("Screenshot returned no dataUrl");
			const base64 = result.dataUrl.replace(/^data:image\/(?:png|jpeg);base64,/, "");
			await writeFile(outputPath, Buffer.from(base64, "base64"));
			await prune();
			return { content: [{ type: "text", text: `Saved Chrome screenshot to ${outputPath}` }], details: { path: outputPath, format, tab: result.tab, method: result.method } };
		},
	});

	pi.registerTool({
		name: "chrome_hover",
		label: "Chrome Hover",
		description: "Hover over an element by uid, selector, or x/y using Chrome pointer movement.",
		promptSnippet: "Hover a Chrome element to trigger :hover / mouseover handlers.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.hover", params, DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: `Hovered ${params.uid ?? params.selector ?? `${params.x},${params.y}`}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_drag",
		label: "Chrome Drag",
		description: "Drag from one uid/selector/point to another using Chrome pointer input.",
		promptSnippet: "Drag a Chrome element from one point to another.",
		parameters: Type.Object({
			fromUid: Type.Optional(Type.String()),
			fromSelector: Type.Optional(Type.String()),
			fromX: Type.Optional(Type.Number()),
			fromY: Type.Optional(Type.Number()),
			toUid: Type.Optional(Type.String()),
			toSelector: Type.Optional(Type.String()),
			toX: Type.Optional(Type.Number()),
			toY: Type.Optional(Type.Number()),
			steps: Type.Optional(Type.Number({ default: 12 })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.drag", params, DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: `Dragged from ${params.fromUid ?? params.fromSelector} to ${params.toUid ?? params.toSelector}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_tap",
		label: "Chrome Tap (Touch)",
		description:
			"Dispatch a real touchstart/touchend tap through Chrome's input layer. Use for sites that gate on TouchEvent rather than MouseEvent (mobile-first PWAs, swipe carousels). Chrome may show its debugging banner while attached.",
		promptSnippet: "Tap (real touch) a Chrome element by snapshot uid, selector, or coordinate.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.tap", params, DEFAULT_TIMEOUT_MS, signal);
			const target = params.uid ?? params.selector ?? `${params.x},${params.y}`;
			return { content: [{ type: "text", text: `Tapped ${target} (touch)` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_scroll",
		label: "Chrome Scroll",
		description: "Scroll the page or a specific scrollable element by dispatching real wheel events with momentum-shaped deltas, then applying the scroll. Positive deltaY scrolls down. Pass uid/selector to scroll within a container, otherwise the document scrolls.",
		promptSnippet: "Scroll a Chrome page or container via wheel events (not raw scrollTop).",
		parameters: Type.Object({
			uid: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			deltaY: Type.Optional(Type.Number({ description: "Pixels to scroll vertically. Positive = down." })),
			deltaX: Type.Optional(Type.Number({ description: "Pixels to scroll horizontally. Positive = right." })),
			steps: Type.Optional(Type.Number({ description: "Number of wheel events to dispatch. Defaults to ceil(|deltaY|/100)." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const result = await authorizedBridgeSend("page.scroll", params, DEFAULT_TIMEOUT_MS, signal);
			return { content: [{ type: "text", text: `Scrolled dy=${params.deltaY ?? 0} dx=${params.deltaX ?? 0}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_upload_file",
		label: "Chrome Upload File",
		description: "Attach local files using Chrome DevTools file-input control without opening a native file picker. Target the <input type=file>, a label/wrapper containing one, or an upload button that opens the picker (the chooser is intercepted). Selectors also search same-origin iframes. Works with React/Vue/Angular controlled inputs.",
		promptSnippet: "Attach local files to a Chrome <input type=file> without opening the native file picker.",
		parameters: Type.Object({
			uid: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			paths: Type.Array(Type.String(), { description: "Local absolute file paths to upload." }),
			domFallback: Type.Optional(Type.Boolean({ description: "Upload buttons need a click to open the (intercepted) file chooser. If true (default) and the tab is hidden, use a page-level element.click() with a user gesture instead of trusted input. Set false to require trusted input." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx): Promise<ToolTextResult> {
			const cwd = workspaceCwd(ctx);
			const paths = params.paths.map((p) => resolve(cwd, p));
			const result = (await authorizedBridgeSend("page.upload", { ...params, paths }, DEFAULT_TIMEOUT_MS, signal)) as { mode?: string; trigger?: string; inFrame?: boolean } | undefined;
			const via = result?.mode === "file-chooser"
				? ` via intercepted file chooser (${result.trigger === "activation-click" ? "page-level click because the tab is hidden" : "trusted click"})`
				: "";
			const frame = result?.inFrame ? " inside an iframe" : "";
			return { content: [{ type: "text", text: `Uploaded ${paths.length} file(s) to ${params.uid ?? params.selector}${frame}${via}` }], details: { result: result as Json } };
		},
	});

	pi.registerTool({
		name: "chrome_cdp",
		label: "Chrome CDP Call",
		description:
			"Low-level escape hatch: run one Chrome DevTools Protocol (CDP) method against a tab (no target = this session's automation tab), e.g. Emulation.setDeviceMetricsOverride, Network.getCookies, DOM.getDocument, Page.printToPDF, Accessibility.getFullAXTree. Put CDP fields inside params. Nothing is filtered against a safe list: destructive methods run as given. Prefer dedicated chrome_* tools when they cover the task. Background mode blocks Page.bringToFront and Target.activateTarget, but other methods can still change what the user sees. Screenshot/binary payloads and results over 256 KiB are summarised instead of returned in full. Domain events are not streamed back; only the method's direct result is returned.",
		promptSnippet: "Run a raw Chrome DevTools Protocol method against a Chrome tab (low-level escape hatch).",
		parameters: Type.Object({
			method: Type.String({ description: "CDP method name, e.g. \"Runtime.evaluate\" or \"Emulation.setDeviceMetricsOverride\"." }),
			params: Type.Optional(Type.Object({}, { additionalProperties: true, description: "CDP parameter object for the method." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Deadline for the CDP command in milliseconds. Default 5000, max 120000. On timeout the debugger session is detached and the next call re-attaches." })),
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
			background: Type.Optional(Type.Boolean({ description: BACKGROUND_PARAM_DESCRIPTION })),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			// Raw CDP fields passed at the top level would reach Chrome as params:{} and fail with an
			// opaque "Invalid parameters". Point the caller at params instead.
			const knownKeys = new Set(["method", "params", "timeoutMs", "targetId", "urlIncludes", "titleIncludes", "background", "foreground", "host", "port"]);
			const unknownKeys = Object.keys(params).filter((key) => !knownKeys.has(key));
			if (unknownKeys.length > 0) {
				throw new Error(`chrome_cdp received unknown top-level parameter(s): ${unknownKeys.join(", ")}. Put CDP fields inside "params", e.g. { method: "Runtime.evaluate", params: { expression: "1+1" } }.`);
			}
			// Keep the bridge deadline above the worker's (CDP deadline + 5s grace) so the precise
			// "CDP <method> timed out" error wins.
			const requested = Number(params.timeoutMs);
			const bridgeTimeoutMs = Number.isFinite(requested) && requested > 0
				? Math.max(DEFAULT_TIMEOUT_MS, Math.min(Math.floor(requested), 120_000) + 10_000)
				: DEFAULT_TIMEOUT_MS;
			const value = await authorizedBridgeSend("cdp.call", params, bridgeTimeoutMs, signal);
			return formatCdpResult(params.method, value);
		},
	});

	pi.registerTool({
		name: "chrome_cdp_targets",
		label: "Chrome CDP Targets",
		description:
			"List Chrome DevTools Protocol targets attached to a tab (type, url, attached, extensionId). Use it to diagnose chrome_* / chrome_cdp failures such as \"Detached while handling command\": password-manager/autofill overlays and DevTools front-ends show up here. Targets on other tabs are only counted. Does not attach the debugger or create an automation tab; with no target it reports this session's automation tab if one exists.",
		promptSnippet: "List CDP targets (including foreign extension overlays) attached to a Chrome tab.",
		parameters: Type.Object({
			targetId: Type.Optional(Type.String()),
			urlIncludes: Type.Optional(Type.String()),
			titleIncludes: Type.Optional(Type.String()),
		}),
		async execute(_id, params, signal): Promise<ToolTextResult> {
			const value = await authorizedBridgeSend("cdp.targets", params, DEFAULT_TIMEOUT_MS, signal);
			const result = value as { tab?: { id?: number; title?: string; url?: string } | null; targets?: Array<{ type?: string; attached?: boolean; url?: string; extensionId?: string }>; otherTabTargetCount?: number } | undefined;
			const targets = result?.targets ?? [];
			const text = [
				result?.tab ? `Tab ${result.tab.id}: ${result.tab.title || "(untitled)"} \u2014 ${result.tab.url ?? ""}` : "No resolved tab (pass targetId/urlIncludes/titleIncludes, or run chrome_navigate first).",
				`${targets.length} CDP target(s) on this tab${result?.otherTabTargetCount ? ` (${result.otherTabTargetCount} on other tabs, not listed)` : ""}:`,
				...targets.map((t) => `- ${t.type ?? "?"}\t${t.attached ? "attached" : "detached"}\t${t.extensionId ? `ext=${t.extensionId}\t` : ""}${t.url ?? ""}`),
			].join("\n");
			return { content: [{ type: "text", text: truncateText(text) }], details: { value: (value ?? null) as Json } };
		},
	});
	}

}
