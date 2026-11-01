#!/usr/bin/env node
/** curt-openclaw CLI: OpenClaw session transcripts -> .curt files. */

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { curtFilename } from "curt-format";
import {
	GENERATOR,
	convertDir,
	resolveCurtWritePath,
	serializeValidated,
} from "./openclaw.js";

interface Options {
	outDir?: string;
	stdout: boolean;
	sample?: number;
	session?: string;
}

function usage(): never {
	console.error(`curt-openclaw — OpenClaw session transcripts -> .curt files

Usage:
  curt-openclaw <sessionsDir>
  curt-openclaw <agentDir>              # uses <agentDir>/sessions
  curt-openclaw <sessionsDir> -o ./out
  curt-openclaw <sessionsDir> --sample 5
  curt-openclaw <sessionsDir> --session <sessionId>
  curt-openclaw <sessionsDir> --stdout > one.curt

Input is an OpenClaw file-store sessions directory (or its agent parent):
sessions.json plus <sessionId>.jsonl transcripts. Only sessions.json and
*.jsonl transcripts are read — never openclaw.json or auth files.
*.trajectory.jsonl runtime logs are not transcripts and are never converted.

Options:
  -o, --out <dir>       Output directory (default: alongside the sessions dir)
  --session <id>        Convert only the session whose sessionId, sessionKey,
                        or transcript file stem matches (others are skipped)
  --sample <n>          Convert only the first n transcripts
  --stdout              Print .curt bodies to stdout instead of writing files
  -h, --help            Show this help`);
	process.exit(2);
}

function parseArgs(argv: string[]): { input: string; options: Options } {
	const options: Options = { stdout: false };
	let input: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-h" || a === "--help") usage();
		if (a === "--stdout") {
			options.stdout = true;
		} else if (a === "-o" || a === "--out") {
			const v = argv[++i];
			if (!v) usage();
			options.outDir = v;
		} else if (a === "--session") {
			const v = argv[++i];
			if (!v) usage();
			options.session = v;
		} else if (a === "--sample") {
			const v = argv[++i];
			const n = v ? Number(v) : NaN;
			if (!Number.isInteger(n) || n < 1) usage();
			options.sample = n;
		} else if (a.startsWith("-")) {
			console.error(`Unknown option: ${a}`);
			usage();
		} else if (input === undefined) {
			input = a;
		} else {
			console.error(`Unexpected extra argument: ${a}`);
			usage();
		}
	}
	if (input === undefined) usage();
	return { input, options };
}

/** Accept a sessions dir or its agent parent dir. */
function sessionsDirOf(input: string): string {
	const abs = resolve(input);
	if (basename(abs) === "sessions") return abs;
	const candidate = join(abs, "sessions");
	try {
		if (statSync(candidate).isDirectory()) return candidate;
	} catch {
		// fall through
	}
	return abs;
}

function main(): number {
	const { input, options } = parseArgs(process.argv.slice(2));
	const dir = sessionsDirOf(input);

	const { items, converted, skipped, totals } = convertDir(dir, options);

	let roundtripFailures = 0;
	let collisions = 0;
	for (const { result } of items) {
		const body = serializeValidated(result.conversation);
		if (!body) {
			roundtripFailures++;
			console.error(`round-trip validation failed for ${result.conversation.id}; not written`);
			continue;
		}
		if (options.stdout) {
			console.log(body);
		} else {
			const outDir = resolve(options.outDir ?? dir);
			mkdirSync(outDir, { recursive: true });
			const file = join(outDir, curtFilename(result.conversation));
			const target = resolveCurtWritePath(file, body);
			if (target.collided) {
				collisions++;
				console.error(`filename collision for ${result.conversation.id}; wrote ${target.path} instead`);
			}
			writeFileSync(target.path, body);
			console.log(target.path);
		}
	}

	console.error(
		`${GENERATOR}: ${converted} converted, ${skipped} skipped, ${roundtripFailures} round-trip failures` +
			(collisions > 0 ? `, ${collisions} filename collisions (suffixed)` : "") +
			` (messages: ${totals.roles.user} user / ${totals.roles.assistant} assistant / ${totals.roles.tool} tool; ` +
			`${totals.skippedBranches} branch entries, ${totals.malformedLines} malformed lines, ` +
			`${totals.unknownLines} unknown lines, ${totals.unmatchedToolCalls} unmatched toolCalls, ` +
			`${totals.unmatchedToolResults} unmatched toolResults, ${totals.emptyDropped} empty dropped, ` +
			`${totals.redactedFields} identifier fields dropped)`,
	);
	// Per-file problems are counted, never fatal.
	return 0;
}

process.exitCode = main();
