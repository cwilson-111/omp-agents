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
 * VOICE EFFECTS
 * `/voice ultron` renders the briefing to a WAV (`omp say --out`) and plays
 * it through ffplay with an ffmpeg filter chain: pitched well down, with a
 * faint flange and a short metallic echo, in Kokoro's deep `am_fenrir`
 * voice. Needs ffmpeg's `ffplay` on PATH; without it the plain
 * voice plays and a warning says why. `/voice plain` goes back.
 *
 * SPEED  `"speed": 1.25` plays briefings faster (pitch kept, ffmpeg
 * `atempo`, 0.5–2); needs ffplay too. `omp say` itself has no speed flag.
 *
 * CONFIG  ~/.omp/agent/voice-brief.json
 *   { "enabled": true, "voice": "bm_george", "speed": 1.25, "effect": "ultron" }
 * Every field optional; absent file = on, plain, normal speed, `speech.voice`.
 * /voice on | off | ultron | plain.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

/** ffmpeg audio filter chains, by effect name, with the Kokoro voice each is tuned for. */
const EFFECTS: Record<string, { filter: string; voice: string }> = {
	ultron: {
		voice: "am_fenrir",
		filter: [
			// Deep: down about 7 semitones, sped back up to roughly the original pace
			// (Kokoro renders 24 kHz).
			"asetrate=24000*0.66",
			"aresample=24000",
			"atempo=1.2",
			// A hint of metal, not a vocoder: a faint flange and one short echo.
			"flanger=delay=1:depth=1:regen=25:width=40:speed=0.2",
			"aecho=0.8:0.4:14:0.18",
			"lowshelf=g=8:f=110",
			"highshelf=g=-3:f=6000",
			"volume=1.8",
			"alimiter=limit=0.95",
		].join(","),
	},
};

type Config = { enabled?: boolean; effect?: string; voice?: string; speed?: number };

function readConfig(): Config {
	if (!existsSync(CONFIG)) return {};
	try {
		return JSON.parse(readFileSync(CONFIG, "utf8")) as Config;
	} catch {
		return {};
	}
}

function writeConfig(change: Config): Config {
	const next = { ...readConfig(), ...change };
	writeFileSync(CONFIG, `${JSON.stringify(next, null, 2)}\n`);
	return next;
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

let ffplayFound: boolean | undefined;
function hasFfplay(): boolean {
	ffplayFound ??= spawnSync("ffplay", ["-version"], { stdio: "ignore" }).status === 0;
	return ffplayFound;
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

	/** Run one step of playback as the current player; resolves with its exit code. */
	const run = (command: string, args: string[]): Promise<number | null> => {
		const { promise, resolve } = Promise.withResolvers<number | null>();
		const child = spawn(command, args, { stdio: "ignore" });
		player = child;
		child.on("error", () => resolve(null));
		child.on("exit", code => {
			if (player === child) player = undefined;
			resolve(code);
		});
		return promise;
	};

	const speak = async (text: string, mine: number, warn: (message: string) => void) => {
		const config = readConfig();
		const effect = config.effect ? EFFECTS[config.effect] : undefined;
		const speed = typeof config.speed === "number" && config.speed !== 1 ? Math.min(Math.max(config.speed, 0.5), 2) : undefined;
		const filter = [effect?.filter, speed && `atempo=${speed}`].filter(Boolean).join(",");
		const voice = config.voice ?? effect?.voice ?? String(lookup("speech.voice")?.get(pi.pi.settings) ?? "af_heart");
		if (filter && hasFfplay()) {
			const wav = join(tmpdir(), `omp-voice-brief-${process.pid}.wav`);
			if ((await run(process.execPath, ["say", "--voice", voice, "--out", wav, text])) !== 0) return;
			if (mine !== generation) return;
			await run("ffplay", ["-nodisp", "-autoexit", "-loglevel", "error", "-af", filter, wav]);
			return;
		}
		if (filter) warn("Voice effects and speed need ffplay (ffmpeg) on PATH; playing the plain voice.");
		await run(process.execPath, ["say", "--voice", voice, text]);
	};

	pi.on("input", () => stop());
	pi.on("agent_start", () => stop());
	pi.on("session_shutdown", () => stop());

	pi.on("agent_end", (event, ctx) => {
		if (ctx.agent.kind !== "main" || ctx.mode !== "tui" || !ctx.runEphemeralTurn) return;
		if (readConfig().enabled === false) return;
		// Not the final word yet: a continuation, a background job's result or queued input will follow.
		if (event.willContinue || event.awaitingAsyncWork || ctx.hasPendingMessages()) return;
		const last = [...event.messages].reverse().find(m => m.role === "assistant");
		if (!last || last.stopReason === "aborted" || last.stopReason === "error") return;
		if (!last.content.some(part => part.type === "text" && part.text.trim())) return;

		stop();
		const mine = generation;
		const abort = new AbortController();
		pending = abort;

		// Not awaited: agent_end is a notification, and the briefing must not hold up the session.
		void (async () => {
			try {
				const { replyText } = await ctx.runEphemeralTurn!({ promptText: PROMPT, maxTokens: 1024, signal: abort.signal });
				const text = toSpeech(replyText);
				if (mine !== generation || !text) return;
				pending = undefined;
				await speak(text, mine, message => ctx.ui.notify(message, "warning"));
			} catch (err) {
				if (mine === generation) ctx.ui.notify(`Voice briefing failed: ${(err as Error).message}`, "warning");
			}
		})();
	});

	pi.registerCommand("voice", {
		description: "Spoken briefings after each reply: /voice on | off | ultron | plain",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				writeConfig({ enabled: arg === "on" });
				if (arg === "off") stop();
				ctx.ui.notify(`Voice briefings ${arg}.`, "info");
				return;
			}
			if (arg === "plain") {
				writeConfig({ effect: undefined, voice: undefined });
				ctx.ui.notify("Voice briefings: plain voice.", "info");
				return;
			}
			if (EFFECTS[arg]) {
				writeConfig({ enabled: true, effect: arg, voice: undefined });
				ctx.ui.notify(
					hasFfplay() ? `Voice briefings: ${arg}.` : `Voice briefings: ${arg}, but ffplay (ffmpeg) is not on PATH, so the plain voice will play.`,
					"info",
				);
				return;
			}
			const config = readConfig();
			ctx.ui.notify(
				`Voice briefings are ${config.enabled === false ? "off" : "on"} (${config.effect ?? "plain"}). Use /voice on | off | ${Object.keys(EFFECTS).join(" | ")} | plain.`,
				"info",
			);
		},
	});
}
