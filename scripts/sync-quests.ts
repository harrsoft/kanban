#!/usr/bin/env bun
/**
 * sync-quests.ts — Quests.md → Kanban Sync Tool (MVP)
 *
 * Reads agent-sharing/Quests.md (Lavra's quest list) via the pure parser in
 * src/lib/server/quests/parse-quests.ts and pushes the SINGLE "Quests" board
 * to the kanban HTTP API. `##` sections are statuses/columns (Open·Doing·Done·
 * Not doing); a non-status section (e.g. "Comments") is not board content.
 *
 * Usage:
 *   bun run scripts/sync-quests.ts                      # parse & print JSON
 *   bun run scripts/sync-quests.ts --apply               # create via kanban API
 *   bun run scripts/sync-quests.ts --apply --dry-run     # show what would be created
 *   bun run scripts/sync-quests.ts --apply --force       # create even if dedup can't be established
 *
 * Fixes (2026-09-19):
 *   - default source path was stale (`harrsoft-shared/Quests.md` → `agent-sharing/Quests.md`),
 *     so the tool could never find its input;
 *   - dedup read failures were silently swallowed (the old fallback catch simply
 *     skipped dedup), so a transient API error silently created duplicate boards.
 *     Now the read must
 *     succeed or the run refuses unless `--force` is passed explicitly.
 *
 * NOT YET: a true upsert. This tool is create-only; a real upsert (update existing
 * cards by title) needs a card-update endpoint on the API, which does not exist yet.
 * Board-level dedup is the safeguard in the meantime. Open loop: quests-importer-upsert.
 *
 * 2026-09-25: the md half of `quests-board-convention` landed — the parser now maps
 * `##` sections to COLUMNS of one board (was: one board per section, the bug that
 * produced the duplicate boards) and `agent-sharing/Quests.md` was renamed to match
 * (`## ✨ New`→`## Open`, `## 🏁 Complete`→`## Done`, + empty Doing/Not doing).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	parseQuestsFile,
	questsToKanbanPayloads,
	type QuestData,
} from "../src/lib/server/quests/parse-quests";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const WORKSPACE_ROOT = resolve(REPO_ROOT, "..");

// Candidate source locations, in order. The canonical file moved to
// agent-sharing/ on 2026-08-31; the old harrsoft-shared/ path is kept last
// only as a fallback for anyone still on the pre-move layout.
const QUESTS_PATH_CANDIDATES = [
	resolve(WORKSPACE_ROOT, "agent-sharing", "Quests.md"),
	resolve(WORKSPACE_ROOT, "harrsoft-shared", "Quests.md"),
];
const CREDENTIAL_PATH = resolve(process.env.HOME || "/home/alpha", ".openclaw", "credentials", "kanban-agent.sh");

const KANBAN_BASE = process.env.KANBAN_BASE || "http://localhost:5173";

// ─── Credentials ─────────────────────────────────────────────────────────────

function loadCredentials(): void {
	if (process.env.KANBAN_API_KEY) return;
	try {
		if (existsSync(CREDENTIAL_PATH)) {
			const content = readFileSync(CREDENTIAL_PATH, "utf-8");
			for (const line of content.split("\n")) {
				const match = line.trim().match(/^([A-Z_]+)="(.*)"$/);
				if (match) process.env[match[1]] = match[2];
			}
		}
	} catch {
		// Silent — resolveApiKey() below names the missing credential.
	}
}

function resolveProjectId(): string {
	if (process.env.KANBAN_PROJECT_ID) return process.env.KANBAN_PROJECT_ID;
	if (process.env.PROJECT_ID) return process.env.PROJECT_ID;
	return "ccfnvx9jlkfnwmax9un58fda";
}

function resolveApiKey(): string {
	if (process.env.KANBAN_API_KEY) return process.env.KANBAN_API_KEY;
	if (process.env.API_KEY) return process.env.API_KEY;
	console.error("⚠ KANBAN_API_KEY not set. Source: source ~/.openclaw/credentials/kanban-agent.sh");
	return "";
}

function resolveQuestsPath(): string {
	for (const p of QUESTS_PATH_CANDIDATES) {
		if (existsSync(p)) return p;
	}
	console.error("✗ Quests.md not found. Looked in:");
	for (const p of QUESTS_PATH_CANDIDATES) console.error(`    ${p}`);
	process.exit(1);
}

// ─── Dedup (fail-loud) ───────────────────────────────────────────────────────

interface ExistingBoardsResult {
	ok: boolean;
	names: Set<string>;
	reason?: string;
}

async function fetchExistingBoardNames(): Promise<ExistingBoardsResult> {
	const names = new Set<string>();
	try {
		const res = await fetch(`${KANBAN_BASE}/api/kanban/boards`, {
			headers: { Authorization: `Bearer ${resolveApiKey()}` },
		});
		if (!res.ok) {
			return { ok: false, names, reason: `boards endpoint returned HTTP ${res.status}` };
		}
		const body = await res.json();
		// The endpoint may wrap the list (e.g. { boards: [...] }) or return the array.
		const list = Array.isArray(body) ? body : Array.isArray(body?.boards) ? body.boards : null;
		if (!list) {
			return { ok: false, names, reason: "boards endpoint returned an unrecognized shape" };
		}
		for (const b of list) if (b?.name) names.add(b.name);
		return { ok: true, names };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, names, reason: msg };
	}
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
	loadCredentials();

	const args = process.argv.slice(2);
	const apply = args.includes("--apply");
	const dryRun = args.includes("--dry-run");
	const force = args.includes("--force");

	const questsPath = resolveQuestsPath();
	console.error("📖 Parsing:", questsPath);
	const data: QuestData = parseQuestsFile(questsPath);
	console.error(`  → 1 board "Quests", ${data.sections.length} sections (${data.sections.filter((s) => s.column).map((s) => `${s.name}→${s.column}`).join(", ")}), ${data.sections.reduce((s, sec) => s + sec.cards.length, 0)} cards`);

	if (!apply) {
		console.log(JSON.stringify(data, null, 2));
		console.error("\nTip: Use --apply to create boards in kanban, or --dry-run to preview API calls.");
		return;
	}

	const projectId = resolveProjectId();
	const payloads = questsToKanbanPayloads(data);

	// Establish existing board names. If we cannot, refuse rather than risk duplicates.
	const existing = await fetchExistingBoardNames();
	if (!existing.ok && !force) {
		console.error(
			`✗ Could not establish existing boards (${existing.reason}); refusing to create to avoid duplicates.\n  Re-run with --force to create anyway.`
		);
		process.exit(1);
	}
	if (!existing.ok && force) {
		console.error(`⚠ Dedup unavailable (${existing.reason}); proceeding because --force was passed.`);
	}

	for (const p of payloads) {
		if (!force && existing.names.has(p.name)) {
			console.error(`  ∼ Skipped: "${p.name}" already exists (use --force to re-create)`);
			continue;
		}

		if (dryRun) {
			console.log(`[DRY RUN] Would create board "${p.name}" in project ${projectId} with ${p.cards.length} cards`);
			continue;
		}

		console.error(`Creating board: ${p.name}...`);
		try {
			const res = await fetch(`${KANBAN_BASE}/api/kanban/boards`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${resolveApiKey()}`,
				},
				body: JSON.stringify({
					projectId,
					name: p.name,
					description: p.description,
					columns: p.columns,
					cards: p.cards.map((c) => ({ title: c.title, description: c.description, column: c.column })),
				}),
			});
			if (!res.ok) {
				const text = await res.text();
				console.error(`  ✗ ${res.status}: ${text}`);
			} else {
				const result = await res.json();
				console.error(`  ✓ Board created: ${result.board?.name ?? "unknown"} (id: ${result.board?.id ?? "unknown"})`);
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`  ✗ Failed: ${msg}`);
		}
	}
}

main().catch((err: unknown) => {
	const msg = err instanceof Error ? err.message : String(err);
	console.error("Fatal:", msg);
	process.exit(1);
});
