/**
 * quest-key.ts — how a Quests.md card and a board card are recognised as the
 * same quest (2026-10-18, the board half of `quests-board-convention`).
 *
 * The md owns the quest's id (`<!-- quest-id: … -->`, else a slug of the title).
 * The board's `cards` table has no id column for it, so the sync needs a key it
 * can read back out of a card — and the one field an agent can write is
 * `content` (≤500 chars), not a metadata field.
 *
 * ── Why the key is an HTML comment at the end of the body ──────────────────
 *
 *   1. `sync-quests.ts --apply` creates cards through `POST /api/kanban/boards`,
 *      which stores content as `description ?? content` in the cards row. So on
 *      imported cards the *description* field holds the body; a key written into
 *      the content field would be empty. The trailing comment rides the body
 *      instead, so it lands wherever the body lands.
 *   2. An HTML comment does not render in the kanban UI's markdown, exactly as
 *      the md-side marker does not render on GitHub. A human sees the quest;
 *      the sync sees the key.
 *   3. Using the md's own marker syntax (rather than a new scheme) means one
 *      syntax to learn and one to grep.
 *
 * Honest bound: the key identifies the card *the sync wrote*. It survives a card
 * being moved between columns (status is board-owned) but not a human editing the
 * key line away — and a key-less card is reported as unrecognised, never silently
 * adopted as a quest by title match.
 */

/** Same syntax as `QUEST_ID_RE` in parse-quests.ts — one marker, one meaning. */
export const QUEST_KEY_RE = /<!--\s*quest-id:\s*([A-Za-z0-9._-]+)\s*-->/g;

export function questKeyLine(id: string): string {
	return `<!-- quest-id: ${id} -->`;
}

/** Remove every quest-key line from a body, leaving the prose intact. */
export function stripQuestKeys(body: string): string {
	return body
		.replace(QUEST_KEY_RE, "")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd();
}

/** Append the key to a card body (idempotent: re-running cannot stack keys). */
export function withQuestKey(body: string, id: string): string {
	return `${stripQuestKeys(body)}\n\n${questKeyLine(id)}`.trim();
}

/** The key a card carries, or null. A key-less card is unrecognised, not guessed. */
export function readQuestKey(body: string): string | null {
	QUEST_KEY_RE.lastIndex = 0;
	const m = QUEST_KEY_RE.exec(body);
	QUEST_KEY_RE.lastIndex = 0;
	return m ? m[1] : null;
}

/** Collapse a body to a comparable form (whitespace-insensitive, key-stripped). */
export function bodyFingerprint(body: string): string {
	return stripQuestKeys(body).replace(/\s+/g, " ").trim();
}
