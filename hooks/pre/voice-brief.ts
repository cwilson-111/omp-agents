/**
 * Speak a short briefing after each finished reply, not the whole reply.
 *
 * WHY NOT THE BUILT-IN `speech.enabled`
 * It reads the assistant's output aloud verbatim as it streams: paths, code,
 * tables and all. This hook replaces it: when the main session's reply is
 * final, it asks the session's own model, in a side turn that is never added
 * to history, for the one to three sentences the user actually needs (the
 * outcome, anything they must do or decide, a risk that changes that), then
 * plays them with omp's local Kokoro voice. Keep `speech.enabled` false, or
 * both will talk.
 *
 * WHY THE SESSION MODEL AND NOT A LOCAL ONE
 * Measured against Ollama's llama3.2 and llama3 on a real reply: llama3.2
 * kept the shell command and padded with "No problem."; llama3 returned
 * nothing. The side turn also sees the whole conversation, so it knows what
 * the user already knows. It reuses the session's prompt cache (tools are
 * left in place on purpose), so its cost is mostly cache reads.
 *
 * Speaking stops the moment you send anything new.
 *
 * CONFIG  ~/.omp/agent/voice-brief.json  { "enabled": true }  (absent = on)
 * Toggle with /voice on | off. Voice and speed follow `speech.voice` and
 * `speech.speed`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";

const CONFIG = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"), "voice-brief.json");

const PROMPT = `Voice briefing. Your last reply is on the user's screen; they will only hear what you write now, read aloud by text-to-speech.

Tell them only what they need to know, in this order and only if present:
1. The outcome or the answer.
2. Anything they must do or decide, including any question you asked them.
3. A problem or risk that changes what they should do.

Leave out how you did it, reasons, background, file paths, code, commands, setting names, numbers that don't matter, and anything they already know.

Speak as yourself, to "you", in plain conversational English: no markdown, symbols or lists. One to three short sentences; one if the reply was simple. Add nothing that was not in the reply. Write only the words to be spoken.`;

function isEnabled(): boolean {
	if (!existsSync(CONFIG)) return true;
	try {
		return JSON.parse(readFileSync(CONFIG, "utf8")).enabled !== false;
	} catch {
		return true;
	}
}

/** Text-to-speech reads markup literally; keep only words and punctuation. */
function toSpeech(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/[`*_#>|~]/g, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

export default function voiceBrief(pi: ExtensionAPI): void {
	// Bumped on every stop, so a briefing that finishes after the user moved on is dropped.
	let generation = 0;
	let pending: AbortController | undefined;
	let player: ChildProcess | undefined;

	const stop = () => {
		generation++;
		pending?.abort();
		pending = undefined;
		player?.kill();
		player = undefined;
	};

	pi.on("input", () => stop());
	pi.on("agent_start", () => stop());
	pi.on("session_shutdown", () => stop());

	pi.on("agent_end", (event, ctx) => {
		if (ctx.agent.kind !== "main" || ctx.mode !== "tui" || !ctx.runEphemeralTurn || !isEnabled()) return;
		// Not the final word yet: a continuation, a background job's result or queued input will follow.
		if (event.willContinue || event.awaitingAsyncWork || ctx.hasPendingMessages()) return;
		const last = [...event.messages].reverse().find(m => m.role === "assistant");
		if (!last || last.stopReason === "aborted" || last.stopReason === "error") return;
		if (!last.content.some(part => part.type === "text" && part.text.trim())) return;

		stop();
		const mine = generation;
		const abort = new AbortController();
		pending = abort;
		const voice = String(lookup("speech.voice")?.get(pi.pi.settings) ?? "af_heart");
		const speed = String(lookup("speech.speed")?.get(pi.pi.settings) ?? 1);

		// Not awaited: agent_end is a notification, and the briefing must not hold up the session.
		void (async () => {
			try {
				const { replyText } = await ctx.runEphemeralTurn!({ promptText: PROMPT, maxTokens: 1024, signal: abort.signal });
				const text = toSpeech(replyText);
				if (mine !== generation || !text) return;
				pending = undefined;
				const child = spawn(process.execPath, ["say", "--voice", voice, "--speed", speed, text], { stdio: "ignore" });
				player = child;
				child.on("exit", () => {
					if (player === child) player = undefined;
				});
			} catch (err) {
				if (mine === generation) ctx.ui.notify(`Voice briefing failed: ${(err as Error).message}`, "warning");
			}
		})();
	});

	pi.registerCommand("voice", {
		description: "Spoken briefings after each reply: /voice on | off",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg !== "on" && arg !== "off") {
				ctx.ui.notify(`Voice briefings are ${isEnabled() ? "on" : "off"}. Use /voice on or /voice off.`, "info");
				return;
			}
			writeFileSync(CONFIG, `${JSON.stringify({ enabled: arg === "on" }, null, 2)}\n`);
			if (arg === "off") stop();
			ctx.ui.notify(`Voice briefings ${arg}.`, "info");
		},
	});
}
