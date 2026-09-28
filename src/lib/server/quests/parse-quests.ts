/**
 * parse-quests.ts — Quests.md → kanban payload parsing (pure, testable).
 *
 * Extracted from scripts/sync-quests.ts (2026-09-19) so the logic can live
 * under the server vitest project (the repo's test convention) while the
 * script stays a thin CLI wrapper.
 *
 * ── Parsing convention (rewritten 2026-09-25, the "md half" of the
 *    `quests-board-convention` loop) ───────────────────────────────────────
 *
 * The Quests file backs a SINGLE board named "Quests" whose COLUMNS are
 * statuses. So a `##` section is a *status*, not a board:
 *
 *   #           = file title (ignored — the board is always "Quests")
 *   ##          = STATUS SECTION → a column of the one board
 *                 canonical: Open · Doing · Done · Not doing
 *                 legacy aliases still accepted so an un-renamed file parses:
 *                   "✨ New" → Open, "🏁 Complete" → Done
 *                 a section that is neither (e.g. "Comments") carries no
 *                 column and its cards are NOT pushed to the board — it is a
 *                 side channel, preserved but not board content.
 *   ###-######  = cards / sub-cards (recursive nesting under the last `###`)
 *
 * Before this rewrite a `##` section was a *board name* ("Quests: ✨ New"),
 * which is exactly why the old importer produced one board per section and
 * the duplicate boards had to be retired by hand. The section is a status.
 *
 * Special patterns (retained):
 *   - ✅ / 🔄 / 📅  = legacy status markers on headings (still stripped from
 *     titles; the SECTION now owns a card's column, so the marker is decorative)
 *   - Lines starting with "+" after a heading = description
 */

import { readFileSync } from "node:fs";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface QuestCard {
	id: string;
	title: string;
	description: string;
	status: "done" | "in-progress" | "planned" | "info";
	level: number; // heading depth (3+)
	children: QuestCard[];
	section: string; // the `##` section this card was declared under
}

export interface QuestSection {
	name: string; // raw section title, e.g. "Open" or "✨ New"
	column: string | null; // canonical column, or null for a non-status section
	cards: QuestCard[];
}

export interface QuestData {
	meta: { created: string; updated: string };
	title: string; // the `#` file title
	sections: QuestSection[];
}

export interface KanbanPayload {
	name: string;
	description: string;
	columns: string[];
	cards: { title: string; description: string; column: string }[];
}

/** The one board this file describes. */
export const QUESTS_BOARD_NAME = "Quests";
/** Canonical columns, in display order. */
export const QUESTS_COLUMNS = ["Open", "Doing", "Done", "Not doing"] as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

export function parseStatus(title: string): QuestCard["status"] {
	if (title.includes("✅")) return "done";
	if (title.includes("🔄")) return "in-progress";
	if (title.includes("📅")) return "planned";
	return "info";
}

export function stripStatus(title: string): string {
	// The `u` flag is load-bearing: without it, `[✅🔄📅]` is a set of UTF-16 code
	// units, and the astral markers (🔄 U+1F504, 📅 U+1F4C5) match only their high
	// surrogate half — leaving a lone low surrogate in the stripped title.
	return title.replace(/^[✅🔄📅]\s*/u, "").trim();
}

export function boardColumnForStatus(status: QuestCard["status"]): string {
	switch (status) {
		case "done":
			return "Done";
		case "in-progress":
			return "Doing";
		case "planned":
			return "Open";
		case "info":
			return "Open";
	}
}

/**
 * sectionToColumn — map a `##` section title to a board column.
 *
 * Case-insensitive, emoji-tolerant. Returns `null` for a section that is not a
 * status (e.g. "Comments") — such a section's cards stay in the file and are
 * not pushed to the board.
 */
export function sectionToColumn(name: string): string | null {
	const key = stripStatus(name).toLowerCase().trim();
	const map: Record<string, string> = {
		// canonical
		open: "Open",
		doing: "Doing",
		done: "Done",
		"not doing": "Not doing",
		// legacy aliases (pre-2026-09-25 file shape)
		"✨ new": "Open",
		"🏁 complete": "Done",
		"in progress": "Doing",
		"to do": "Open",
	};
	return map[key] ?? null;
}

/**
 * clip — surrogate-safe truncation.
 *
 * `String.prototype.slice` counts UTF-16 code units, so a blind slice can
 * split a surrogate pair (e.g. 🔄 = U+1F504) and leave a lone surrogate —
 * invalid UTF-8 that mangles on write. Never cut between a high and low
 * surrogate; back off one unit instead.
 *
 * (Found 2026-09-19: the importer's sub-item summary used a blind
 * `.slice(0, 80)` on card descriptions that routinely begin with ⚠️/🔄/📅.)
 */
export function clip(text: string, max = 80): string {
	if (text.length <= max) return text;
	let end = max;
	const code = text.charCodeAt(end - 1);
	// High surrogate at the cut boundary → drop it so we don't orphan a pair.
	if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	return text.slice(0, end);
}

// ─── Parsing ────────────────────────────────────────────────────────────────

function parseDescription(
	lines: string[],
	startIdx: number,
): { description: string; endIdx: number } {
	const descLines: string[] = [];
	let i = startIdx;
	while (i < lines.length) {
		const line = lines[i].trim();
		if (line === "" || line.startsWith("#")) break;
		if (line.startsWith("+")) {
			descLines.push(line.slice(1).trim());
		} else if (!line.startsWith("-") && !line.startsWith("|")) {
			descLines.push(line);
		}
		i++;
	}
	return { description: descLines.join("\n"), endIdx: i };
}

export function parseQuestsContent(content: string): QuestData {
	const lines = content.split("\n");

	// Parse frontmatter (only at start of file)
	const meta: QuestData["meta"] = { created: "", updated: "" };
	if (lines[0]?.trim() === "---") {
		const fmEnd = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
		if (fmEnd > 0) {
			const fmLines = lines.slice(1, fmEnd);
			for (const l of fmLines) {
				const [k, ...rest] = l.split(":");
				const v = rest.join(":").trim();
				if (k.trim() === "created") meta.created = v;
				if (k.trim() === "updated") meta.updated = v;
			}
			lines.splice(0, fmEnd + 1); // remove frontmatter
		}
	}

	// Remove any remaining horizontal rule markers (---, ***) that could be mistaken for headings
	const cleanedLines = lines.filter(
		l => !/^---$/.test(l.trim()) && !/^\*\*\*$/.test(l.trim()),
	);

	const sections: QuestSection[] = [];
	let title = "";
	let currentSection: QuestSection | null = null;

	for (let i = 0; i < cleanedLines.length; i++) {
		const line = cleanedLines[i];
		const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
		if (!headingMatch) continue;

		const [_, hashes, rawTitle] = headingMatch;
		const level = hashes.length;
		const cleanTitle = stripStatus(rawTitle.trim());
		const { description, endIdx } = parseDescription(cleanedLines, i + 1);
		i = endIdx - 1; // skip description lines

		if (level === 1) {
			// File title — the board is always "Quests"; keep the title for the
			// board description. A `#` never becomes a section.
			if (!title) title = cleanTitle;
			currentSection = null;
			continue;
		}

		if (level === 2) {
			currentSection = {
				name: rawTitle.trim(),
				column: sectionToColumn(rawTitle),
				cards: [],
			};
			sections.push(currentSection);
			continue;
		}

		// level >= 3 → a card. A card before any `##` opens an implicit "Open"
		// section so a heading-less fragment still parses (and says so).
		if (!currentSection) {
			currentSection = { name: "Open", column: "Open", cards: [] };
			sections.push(currentSection);
		}

		const card: QuestCard = {
			id: slugify(cleanTitle),
			title: cleanTitle,
			description,
			status: parseStatus(rawTitle),
			level,
			children: [],
			section: currentSection.name,
		};
		if (level === 3) {
			currentSection.cards.push(card);
		} else if (currentSection.cards.length > 0) {
			const parent = currentSection.cards[currentSection.cards.length - 1];
			parent.children.push(card);
		} else {
			currentSection.cards.push(card);
		}
	}

	return { meta, title: title || QUESTS_BOARD_NAME, sections };
}

export function parseQuestsFile(filePath: string): QuestData {
	return parseQuestsContent(readFileSync(filePath, "utf-8"));
}

// ─── Kanban payloads ────────────────────────────────────────────────────────

/**
 * questsToKanbanPayloads — collapse the file into a SINGLE "Quests" board.
 *
 * Sections carry the column; a card's own ✅/🔄/📅 marker no longer chooses a
 * column (the board owns status, and on import the section IS the status).
 * Non-status sections (column === null) are skipped — their text stays in the
 * file, untouched.
 */
export function questsToKanbanPayloads(data: QuestData): KanbanPayload[] {
	const cards: KanbanPayload["cards"] = [];

	for (const section of data.sections) {
		if (!section.column) continue; // e.g. "Comments" — not board content
		for (const c of section.cards) {
			cards.push({
				title: c.title,
				description:
					c.description +
					(c.children.length > 0 ?
						"\n\n**Sub-items:**\n" +
						c.children
							.map(ch => `- ${ch.title}: ${clip(ch.description)}`)
							.join("\n")
					:	""),
				column: section.column,
			});
		}
	}

	return [
		{
			name: QUESTS_BOARD_NAME,
			description: `From Quests.md — ${data.title}`,
			columns: [...QUESTS_COLUMNS],
			cards,
		},
	];
}
