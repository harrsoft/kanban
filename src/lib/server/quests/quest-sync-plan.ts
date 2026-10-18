/**
 * quest-sync-plan.ts — the pure half of the Quests board sync (2026-10-18).
 *
 * Input: what the md says (canonical cards with ids, column, body) and what the
 * board currently holds (id, column, body-as-content, archived). Output: the
 * exact set of creates / moves / body-updates / archives needed to make the board
 * true to the md — computed without a network call, so every rule is testable.
 *
 * ── The convention, made operational (the `quests-board-convention` loop) ──
 *
 *   text + identity : md → board   (a body that differs is written; the id rides
 *                                   the body as `<!-- quest-id: id -->`)
 *   status          : board → md   (a card's column is NOT moved by the sync; a
 *                                   status change is reported as a steer for the
 *                                   md export, never silently overwritten)
 *   same-field      : REFUSED      (see `conflicts`)
 *   key-less cards  : reported, never adopted
 *
 * ── Same-field conflict, defined ──────────────────────────────────────────
 *
 * The sync stores the whole md body (title + description + key) in the card's
 * content, so "the text" cannot be split into title-vs-body fields without a
 * second write mechanism. The conflict the convention cares about is the one that
 * loses a human's work: a card whose text is *neither* the md's body nor the md
 * body with only its key line changed (i.e. someone edited the text on the
 * board), while the md also changed. Identical fingerprints are a no-op; a
 * fingerprint equal to the md body with keys stripped is a key-only difference
 * (the sync's own drift) and is repaired. Anything else is refused, loudly, with
 * the id — because picking a winner silently is how a sync eats an edit.
 */

import type { KanbanPayload } from "./parse-quests";
import {
	readQuestKey,
	bodyFingerprint,
	stripQuestKeys,
	withQuestKey,
} from "./quest-key";

/** A card as the board reports it (agent API shape, normalised). */
export interface BoardCard {
	id: string;
	column: string;
	/** The board's stored text (agent API `content`; may fall back to description). */
	body: string;
	archived: boolean;
}

/** One quest the md declares, flattened to the card it should produce. */
export interface MdQuest {
	id: string;
	column: string;
	body: string;
}

export interface SyncPlan {
	create: Array<{ id: string; column: string; body: string }>;
	updateBody: Array<{ cardId: string; id: string; body: string }>;
	/** Status drift: the board's column disagrees with the md's. md export owns it. */
	steerMdStatus: Array<{ id: string; boardColumn: string; mdColumn: string }>;
	archive: Array<{ cardId: string; id: string; reason: string }>;
	unchanged: string[];
	/** Cards with no recognisable key — reported, never touched. */
	unrecognised: Array<{ cardId: string; column: string; preview: string }>;
	conflicts: Array<{ cardId: string; id: string; why: string }>;
}

/** Case/space-insensitive column comparison (the board owns display casing). */
function sameColumn(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Normalise the md's board payload into the flat card list the plan works on. */
export function mdQuests(payloads: KanbanPayload[]): MdQuest[] {
	const out: MdQuest[] = [];
	for (const p of payloads) {
		for (const c of p.cards) {
			out.push({
				id: c.id,
				column: c.column,
				body: `${c.title}\n${c.description}`.trim(),
			});
		}
	}
	return out;
}

/**
 * planQuestSync — compute the diff. Pure: no fetch, no fs.
 *
 * `adoptKeyless` is deliberately absent: a card without a key is never matched by
 * title. The one way to adopt one is a human writing the key line into it.
 */
export function planQuestSync(
	md: MdQuest[],
	board: BoardCard[],
): SyncPlan {
	const plan: SyncPlan = {
		create: [],
		updateBody: [],
		steerMdStatus: [],
		archive: [],
		unchanged: [],
		unrecognised: [],
		conflicts: [],
	};

	const byKey = new Map<string, BoardCard>();
	for (const card of board) {
		const key = readQuestKey(card.body);
		if (!key) {
			if (!card.archived) {
				plan.unrecognised.push({
					cardId: card.id,
					column: card.column,
					preview: stripQuestKeys(card.body).slice(0, 60),
				});
			}
			continue;
		}
		// Two live cards claiming one quest is the merge failure the marker exists
		// to prevent; name it rather than pick one.
		const prior = byKey.get(key);
		if (prior && !prior.archived && !card.archived) {
			plan.conflicts.push({
				cardId: card.id,
				id: key,
				why: `duplicate live card for quest "${key}" (also ${prior.id})`,
			});
			continue;
		}
		if (!prior) byKey.set(key, card);
		else if (prior.archived && !card.archived) byKey.set(key, card);
	}

	const mdIds = new Set<string>();
	for (const quest of md) {
		mdIds.add(quest.id);
		const wanted = withQuestKey(quest.body, quest.id);
		const match = byKey.get(quest.id);
		const existing = match && !match.archived ? match : undefined;
		if (!existing) {
			plan.create.push({ id: quest.id, column: quest.column, body: wanted });
			continue;
		}
		// Compare KEY-STRIPPED text on both sides. (The first cut of this rule
		// compared two fingerprints that both already had the key stripped, so
		// "the board matches the md" was always true and no conflict could ever
		// be raised — a rule that cannot fail. The fixtures pin that it can.)
		const boardText = bodyFingerprint(existing.body);
		const mdText = bodyFingerprint(quest.body);
		if (boardText !== mdText) {
			plan.conflicts.push({
				cardId: existing.id,
				id: quest.id,
				why: "board text differs from the md body (an edit on the board)",
			});
			continue;
		}
		// Board owns status; the sync owns text. If the board body carries no key,
		// the repair and the edit look identical in text, so there is no edit to
		// refuse — write the key back. If it carries THIS key and the text still
		// differs after stripping, the board was edited and the conflict above
		// already fired. Either way the only write here is the key's restoration.
		if (existing.body !== wanted) {
			plan.updateBody.push({ cardId: existing.id, id: quest.id, body: wanted });
		} else {
			plan.unchanged.push(quest.id);
		}
		if (!sameColumn(existing.column, quest.column)) {
			plan.steerMdStatus.push({
				id: quest.id,
				boardColumn: existing.column,
				mdColumn: quest.column,
			});
		}
	}

	// A keyed card whose quest is gone from the md: archive it (reversible), never
	// delete — the board is export-only and an archive can be read back.
	for (const [key, card] of byKey) {
		if (!mdIds.has(key) && !card.archived) {
			plan.archive.push({
				cardId: card.id,
				id: key,
				reason: "quest no longer in Quests.md",
			});
		}
	}

	return plan;
}
