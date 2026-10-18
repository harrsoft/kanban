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
 * 2026-10-18 (the board half of quests-board-convention): a REAL upsert, keyed
 * by the md's own quest id. The plan lives in the pure module
 * src/lib/server/quests/quest-sync-plan.ts (42 fixtures) and the key syntax in
 * quest-key.ts: every synced card carries <!-- quest-id: ... --> in its body.
 *
 *   text + identity : md -> board (body rewritten when the text differs)
 *   status          : board -> md (a column disagreement is REPORTED as a steer,
 *                     never written back into the md by this tool)
 *   same-field      : REFUSED   (a board text edit that differs from the md is a
 *                     named conflict; nothing is written for that quest)
 *   key-less cards  : reported as unrecognised, never adopted by title
 *   gone from md    : archived on the board (reversible), never deleted
 *
 *   bun run scripts/sync-quests.ts --plan            # print the diff, no writes
 *   bun run scripts/sync-quests.ts --apply           # create + repair bodies
 *   bun run scripts/sync-quests.ts --apply --check   # plan only; exit 1 on drift
 *
 * Honest bound: the description field is preferred as the card body when the API
 * reports both, because POST /api/kanban/boards stores the import body in
 * description and leaves content empty on imported cards.
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
import {
	mdQuests,
	planQuestSync,
	type BoardCard,
	type SyncPlan,
} from "../src/lib/server/quests/quest-sync-plan";

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


// ─── The upsert half: read the board, print the plan, execute it ──────────────

interface BoardRead {
	ok: boolean;
	cards: BoardCard[];
	/** The live Quests board's id — the create endpoint needs it explicitly. */
	boardId?: string;
	reason?: string;
}

/**
 * Read the live "Quests" board through the agent API.
 *
 * The public board endpoints are page/UI routes (they answer HTML), so the agent
 * API is the only machine-readable door — and it is scoped to this key's project,
 * which is exactly the board's project. The body is taken as `description ?? content`
 * because POST /api/kanban/boards stores the import body in description.
 */
async function fetchQuestsBoard(): Promise<BoardRead> {
	try {
		const res = await fetch(`${KANBAN_BASE}/api/kanban/boards`, {
			headers: { Authorization: `Bearer ${resolveApiKey()}` },
		});
		if (!res.ok) return { ok: false, cards: [], reason: `boards HTTP ${res.status}` };
		const list = await res.json();
		const boardsList = Array.isArray(list) ? list : Array.isArray(list?.boards) ? list.boards : [];
		const quests = boardsList.find((b: { name?: string; archived?: boolean }) => b?.name === "Quests" && !b?.archived);
		if (!quests?.id) return { ok: false, cards: [], reason: "no live board named Quests" };

		const tRes = await fetch(
			`${KANBAN_BASE}/api/agent/tasks?board=${encodeURIComponent(quests.id)}&limit=200&includeArchived=true`,
			{ headers: { Authorization: `Bearer ${resolveApiKey()}` } },
		);
		if (!tRes.ok) return { ok: false, cards: [], reason: `tasks HTTP ${tRes.status}` };
		const body = await tRes.json();
		const tasks: Array<Record<string, unknown>> = Array.isArray(body?.tasks) ? body.tasks : [];

		const cards: BoardCard[] = [];
		for (const t of tasks) {
			const col = t.column as { id?: string; name?: string } | string | undefined;
			const columnName = typeof col === "string" ? col : (col?.name ?? "");
			const raw = t as { content?: string; description?: string };
			cards.push({
				id: String(t.id),
				column: columnName,
				body: (raw.content ?? raw.description ?? "") as string,
				archived: Boolean(t.archived),
			});
		}
		return { ok: true, cards, boardId: String(quests.id) };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, cards: [], reason: msg };
	}
}

function printPlan(plan: SyncPlan): void {
	const line = (label: string, n: number, sample?: string[]) =>
		console.error(`  ${label.padEnd(14)} ${String(n).padStart(3)}${sample && sample.length ? `  (${sample.slice(0, 4).join(", ")}${sample.length > 4 ? ", …" : ""})` : ""}`);
	console.error("=== Quests sync plan ===");
	line("create", plan.create.length, plan.create.map(c => c.id));
	line("update body", plan.updateBody.length, plan.updateBody.map(u => u.id));
	line("steer md", plan.steerMdStatus.length, plan.steerMdStatus.map(s => `${s.id}: ${s.boardColumn}!=${s.mdColumn}`));
	line("archive", plan.archive.length, plan.archive.map(a => a.id));
	line("unchanged", plan.unchanged.length);
	line("unrecognised", plan.unrecognised.length, plan.unrecognised.map(u => u.cardId));
	line("CONFLICTS", plan.conflicts.length, plan.conflicts.map(c => `${c.id}: ${c.why}`));
}

/**
 * Write the plan. Creates go through the agent API (one idempotency key per
 * quest), body repairs and archives through PATCH. A conflict is never written —
 * it is printed and left standing, because picking a winner silently is how a
 * sync eats a human's edit. Status is md-owned: steers are printed, never written.
 */
async function executePlan(plan: SyncPlan, questsBoardId: string): Promise<number> {
	const key = resolveApiKey();
	let failures = 0;

	for (const c of plan.create) {
		const res = await fetch(`${KANBAN_BASE}/api/agent/cards`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${key}`,
				"Idempotency-Key": `quests-create-${c.id}`,
			},
			body: JSON.stringify({ boardId: questsBoardId, content: c.body }),
		});
		if (!res.ok) {
			console.error(`  x create ${c.id}: HTTP ${res.status} ${await res.text()}`);
			failures++;
		} else {
			console.error(`  ok create ${c.id}`);
		}
	}

	const patches = [
		...plan.updateBody.map(u => ({ cardId: u.cardId, id: u.id, body: u.body as string | undefined })),
		...plan.archive.map(a => ({ cardId: a.cardId, id: a.id, body: undefined as string | undefined })),
	];
	for (const u of patches) {
		const payload: Record<string, unknown> = u.body !== undefined ? { content: u.body } : { archived: true };
		const res = await fetch(`${KANBAN_BASE}/api/agent/cards/${encodeURIComponent(u.cardId)}`, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${key}`,
				"Idempotency-Key": `quests-patch-${u.id}-${u.body !== undefined ? "body" : "archive"}`,
			},
			body: JSON.stringify(payload),
		});
		if (!res.ok) {
			console.error(`  x patch ${u.id}: HTTP ${res.status} ${await res.text()}`);
			failures++;
		} else {
			console.error(`  ok patch ${u.id}`);
		}
	}

	for (const s of plan.steerMdStatus) {
		console.error(`  -> md export owns: ${s.id} is "${s.boardColumn}" on the board, "${s.mdColumn}" in the md`);
	}
	for (const c of plan.conflicts) {
		console.error(`  CONFLICT ${c.id} (card ${c.cardId}): ${c.why} — not written`);
	}
	return failures > 0 || plan.conflicts.length > 0 ? 1 : 0;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
	loadCredentials();

	const args = process.argv.slice(2);
	const apply = args.includes("--apply");
	const dryRun = args.includes("--dry-run");
	const force = args.includes("--force");
	const planOnly = args.includes("--plan");
	const checkOnly = args.includes("--check");

	const questsPath = resolveQuestsPath();
	console.error("📖 Parsing:", questsPath);
	const data: QuestData = parseQuestsFile(questsPath);
	console.error(`  → 1 board "Quests", ${data.sections.length} sections (${data.sections.filter((s) => s.column).map((s) => `${s.name}→${s.column}`).join(", ")}), ${data.sections.reduce((s, sec) => s + sec.cards.length, 0)} cards`);

	const payloads = questsToKanbanPayloads(data);

	if (!apply && !planOnly && !checkOnly) {
		console.log(JSON.stringify(data, null, 2));
		console.error("\nTip: Use --plan to see the board diff, --apply to sync, --dry-run to preview creates.");
		return;
	}

	// ── The upsert half (2026-10-18): diff the md against the real board ──────
	// Runs for --plan / --apply / --check. Reads the board through the agent API
	// (scoped to this key's project), plans in pure code, and only writes when
	// --apply was passed AND --check was not.
	if (planOnly || checkOnly || apply) {
		const board = await fetchQuestsBoard();
		if (!board.ok) {
			console.error(`✗ Could not read the Quests board (${board.reason}); refusing to plan blind.`);
			process.exit(1);
		}
		const plan = planQuestSync(mdQuests(payloads), board.cards);
		printPlan(plan);
		if (checkOnly) {
			const drifted =
				plan.create.length + plan.updateBody.length + plan.archive.length + plan.conflicts.length > 0;
			process.exit(drifted ? 1 : 0);
		}
		if (!apply || dryRun) {
			console.error("\n[--plan / --dry-run] nothing written.");
			return;
		}
		const rc = await executePlan(plan, board.boardId ?? "");
		process.exit(rc);
	}

	const projectId = resolveProjectId();

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
