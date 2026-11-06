/**
 * Stop work before the budget runs out, leaving a handoff behind.
 *
 * WHY A HOOK AND NOT AN AGENT
 * A task agent is a prompt. It has no scheduler, cannot wake itself, cannot
 * see the account's quota, and would spend the very budget it was asked to
 * watch. A hook runs in-process on real events and can *block tool calls*,
 * which is the only mechanism here that can actually halt work.
 *
 * WHAT "USAGE" MEANS HERE
 * Nothing local reports the provider's remaining quota; a provider
 * `rate_limit_error` only shows up after the fact. So this measures spend in
 * a rolling window against a budget YOU set — a proxy for the quota, not the
 * quota itself. Set the window to match your plan's reset period.
 *
 * Spend is read from the live session logs under ~/.omp/agent/sessions,
 * where every assistant message carries `usage.cost.total` and a millisecond
 * `timestamp`. NOT from ~/.omp/stats.db: that is a cache `omp stats` syncs
 * from these same logs, and it lags them — measured here, its newest row was
 * from 21:42 while the session log already held requests from 06:34 the next
 * morning. A budget read from it would miss exactly the spend it exists to
 * catch. Subagent sessions are included, because the quota is per account,
 * not per conversation.
 *
 * CONFIG  ~/.omp/agent/usage-budget.json  (all fields optional)
 *   {
 *     "windowHours": 5,      // rolling window, match your plan's reset
 *     "budgetUsd": 25,       // spend ceiling for that window
 *     "warnAt": 0.80,        // fraction -> one nudge to start wrapping up
 *     "stopAt": 0.99,        // fraction -> write the handoff, then halt
 *     "handoffPath": "HANDOFF.md"   // relative to the session cwd
 *   }
 * Absent or unparseable config disables the hook entirely: failing open is
 * correct for something whose failure mode is "refuses to let you work".
 */

import { closeSync, openSync, readdirSync, readFileSync, readSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Config = {
	windowHours: number;
	budgetUsd: number;
	warnAt: number;
	stopAt: number;
	handoffPath: string;
};

type ToolCallEvent = {
	toolName: string;
	input?: Record<string, unknown>;
};

type HookAPI = {
	on(event: "turn_end", handler: () => Promise<void> | void): void;
	on(
		event: "tool_call",
		handler: (
			event: ToolCallEvent,
		) => Promise<{ block?: boolean; reason?: string } | undefined> | undefined,
	): void;
	sendMessage?(message: { customType: string; display: string; content: string }): Promise<void>;
	appendEntry?(entry: Record<string, unknown>): void;
	registerCommand?(command: {
		name: string;
		description: string;
		handler: () => Promise<string>;
	}): void;
	logger?: { debug?(message: string): void };
};

const DEFAULTS: Config = {
	windowHours: 5,
	budgetUsd: 25,
	warnAt: 0.8,
	stopAt: 0.99,
	handoffPath: "HANDOFF.md",
};

const SESSIONS_DIR = join(homedir(), ".omp", "agent", "sessions");
const CONFIG_PATH = join(homedir(), ".omp", "agent", "usage-budget.json");

/** Tools still permitted once stopped: just enough to write the handoff. */
const HANDOFF_TOOLS: Record<string, true> = {
	read: true,
	write: true,
	edit: true,
	todo: true,
	glob: true,
	grep: true,
};

const HANDOFF_TOOL_LIST = Object.keys(HANDOFF_TOOLS).join(", ");

function loadConfig(): Config | null {
	try {
		statSync(CONFIG_PATH);
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		return null; // fail open; see header
	}
	if (!parsed || typeof parsed !== "object") return null;

	const raw = parsed as Partial<Record<keyof Config, unknown>>;
	const config: Config = {
		windowHours: typeof raw.windowHours === "number" ? raw.windowHours : DEFAULTS.windowHours,
		budgetUsd: typeof raw.budgetUsd === "number" ? raw.budgetUsd : DEFAULTS.budgetUsd,
		warnAt: typeof raw.warnAt === "number" ? raw.warnAt : DEFAULTS.warnAt,
		stopAt: typeof raw.stopAt === "number" ? raw.stopAt : DEFAULTS.stopAt,
		handoffPath: typeof raw.handoffPath === "string" ? raw.handoffPath : DEFAULTS.handoffPath,
	};
	if (!(config.budgetUsd > 0) || !(config.windowHours > 0)) return null;
	return config;
}

/**
 * Rolling-window spend, read incrementally from the session logs.
 *
 * This runs on every turn, and a single long session log here is several
 * megabytes, so re-reading everything each time is not an option. Instead it
 * keeps a byte cursor per file and only ever reads what was appended since the
 * last call. Files untouched since the window opened are skipped on an mtime
 * check without being opened at all.
 *
 * The cursor only advances to the last complete line: the log is being
 * written while it is read, and a half-written JSON line parsed now would be
 * dropped and never counted. A file that has shrunk below its cursor was
 * rewritten, so it is re-read from the start.
 */
class SpendLedger {
	private readonly cursors = new Map<string, number>();
	private entries: { at: number; cost: number }[] = [];

	read(windowHours: number): { spent: number; resetAt: Date | null } {
		const windowMs = windowHours * 3600_000;
		const since = Date.now() - windowMs;

		for (const file of this.logFiles(SESSIONS_DIR, since)) {
			this.ingest(file);
		}

		this.entries = this.entries.filter((entry) => entry.at >= since);
		let spent = 0;
		let oldest = Number.POSITIVE_INFINITY;
		for (const entry of this.entries) {
			spent += entry.cost;
			if (entry.at < oldest) oldest = entry.at;
		}
		return {
			spent,
			resetAt: Number.isFinite(oldest) ? new Date(oldest + windowMs) : null,
		};
	}

	/** Every .jsonl under `dir` modified since `since`, subagent logs included. */
	private logFiles(dir: string, since: number): string[] {
		const found: string[] = [];
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return found;
		}
		for (const name of names) {
			const path = join(dir, name);
			let stat: Stats;
			try {
				stat = statSync(path);
			} catch {
				continue; // removed between readdir and stat
			}
			if (stat.isDirectory()) {
				found.push(...this.logFiles(path, since));
			} else if (name.endsWith(".jsonl") && stat.mtimeMs >= since) {
				found.push(path);
			}
		}
		return found;
	}

	private ingest(file: string): void {
		let size: number;
		try {
			size = statSync(file).size;
		} catch {
			return;
		}
		let cursor = this.cursors.get(file) ?? 0;
		if (size < cursor) cursor = 0;
		if (size === cursor) return;

		const length = size - cursor;
		const buffer = Buffer.alloc(length);
		let fd: number | null = null;
		try {
			fd = openSync(file, "r");
			readSync(fd, buffer, 0, length, cursor);
		} catch {
			return;
		} finally {
			if (fd !== null) closeSync(fd);
		}

		const lastNewline = buffer.lastIndexOf(0x0a);
		if (lastNewline < 0) return; // no complete line yet; retry next turn
		this.cursors.set(file, cursor + lastNewline + 1);

		for (const line of buffer.toString("utf8", 0, lastNewline).split("\n")) {
			if (!line.includes('"usage"')) continue; // cheap reject before JSON.parse
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (!parsed || typeof parsed !== "object" || !("message" in parsed)) continue;
			const message = parsed.message;
			if (!message || typeof message !== "object") continue;
			if (!("timestamp" in message) || !("usage" in message)) continue;
			const { timestamp, usage } = message;
			if (typeof timestamp !== "number" || !usage || typeof usage !== "object") continue;
			if (!("cost" in usage) || !usage.cost || typeof usage.cost !== "object") continue;
			if (!("total" in usage.cost) || typeof usage.cost.total !== "number") continue;
			this.entries.push({ at: timestamp, cost: usage.cost.total });
		}
	}
}

export default function hook(pi: HookAPI): void {
	const config = loadConfig();
	if (!config) {
		pi.logger?.debug?.(`usage-budget: no usable ${CONFIG_PATH}; hook inactive`);
		return;
	}

	// One ledger for the life of the session, so its byte cursors persist
	// across turns and each turn reads only what was appended since the last.
	const ledger = new SpendLedger();
	let warned = false;
	let stopping = false;
	let handoffWritten = false;

	pi.registerCommand?.({
		name: "budget",
		description: "Spend in the current rolling window against the configured budget",
		handler: async () => {
			const { spent, resetAt } = ledger.read(config.windowHours);
			return (
				`$${spent.toFixed(2)} of $${config.budgetUsd.toFixed(2)} ` +
				`(${((spent / config.budgetUsd) * 100).toFixed(1)}%) in the last ${config.windowHours}h. ` +
				`Warn ${(config.warnAt * 100).toFixed(0)}%, stop ${(config.stopAt * 100).toFixed(0)}%.` +
				(resetAt ? ` Oldest spend ages out ${resetAt.toLocaleString()}.` : "")
			);
		},
	});

	pi.on("turn_end", async () => {
		const { spent, resetAt } = ledger.read(config.windowHours);
		const fraction = spent / config.budgetUsd;

		if (!stopping && fraction >= config.stopAt) {
			stopping = true;
			await pi.sendMessage?.({
				customType: "usage-budget-stop",
				display: `Budget ${(fraction * 100).toFixed(1)}% — stopping after handoff`,
				content:
					`BUDGET REACHED: $${spent.toFixed(2)} of $${config.budgetUsd.toFixed(2)} ` +
					`(${(fraction * 100).toFixed(1)}%) in the last ${config.windowHours} hours.\n\n` +
					`Do exactly this and nothing else:\n` +
					`1. Write or refresh ${config.handoffPath} so a fresh session can resume without ` +
					`re-deriving anything. It must state: what was being worked on and why, what is ` +
					`DONE with the evidence that proved it, what is IN PROGRESS and the exact next ` +
					`action, anything deliberately not done, and every file touched.\n` +
					`2. Then stop and report. Do not start new work.\n\n` +
					`Every tool except ${HANDOFF_TOOL_LIST} is now blocked, and those are blocked too ` +
					`once the handoff is written.` +
					(resetAt ? `\n\nRoom reappears around ${resetAt.toLocaleString()}.` : ""),
			});
			return;
		}

		if (!warned && !stopping && fraction >= config.warnAt) {
			warned = true;
			await pi.sendMessage?.({
				customType: "usage-budget-warn",
				display: `Budget ${(fraction * 100).toFixed(1)}%`,
				content:
					`Budget notice: $${spent.toFixed(2)} of $${config.budgetUsd.toFixed(2)} ` +
					`(${(fraction * 100).toFixed(1)}%) in the last ${config.windowHours} hours. ` +
					`Work halts at ${(config.stopAt * 100).toFixed(0)}%. Prefer finishing and verifying ` +
					`what is already started over opening new fronts, and keep ${config.handoffPath} current.`,
			});
		}
	});

	pi.on("tool_call", async (event: ToolCallEvent) => {
		if (!stopping) return undefined;

		if (handoffWritten) {
			return { block: true, reason: "Usage budget reached; the handoff is written. Stop here." };
		}

		if (!HANDOFF_TOOLS[event.toolName]) {
			return {
				block: true,
				reason:
					`Usage budget reached. Only ${HANDOFF_TOOL_LIST} are permitted, ` +
					`and only to write ${config.handoffPath}.`,
			};
		}

		// Writing the handoff is the last permitted act.
		if (event.toolName === "write" || event.toolName === "edit") {
			const path = event.input?.path;
			const body = event.input?.input;
			const target = typeof path === "string" ? path : typeof body === "string" ? body : "";
			if (!target.includes(config.handoffPath)) {
				return {
					block: true,
					reason: `Usage budget reached. The only write permitted is ${config.handoffPath}.`,
				};
			}
			handoffWritten = true;
			pi.appendEntry?.({
				type: "usage-budget",
				handoff: config.handoffPath,
				at: new Date().toISOString(),
			});
		}
		return undefined;
	});
}
