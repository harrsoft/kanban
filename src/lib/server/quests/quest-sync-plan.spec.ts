import { describe, it, expect } from "vitest";
import {
	planQuestSync,
	type BoardCard,
	type MdQuest,
} from "./quest-sync-plan";
import { withQuestKey, readQuestKey, stripQuestKeys } from "./quest-key";

const md = (id: string, column: string, body: string): MdQuest => ({
	id,
	column,
	body,
});
const card = (
	id: string,
	column: string,
	body: string,
	archived = false,
): BoardCard => ({ id, column, body, archived });

describe("quest-key", () => {
	it("round-trips and is idempotent", () => {
		const once = withQuestKey("Title\nBody", "abc");
		expect(readQuestKey(once)).toBe("abc");
		expect(withQuestKey(once, "abc")).toBe(once);
	});
	it("rekeys without stacking", () => {
		const rekeyed = withQuestKey(withQuestKey("Body", "old"), "new");
		expect(readQuestKey(rekeyed)).toBe("new");
		expect(rekeyed.match(/quest-id/g)?.length).toBe(1);
	});
	it("reads a key-less body as null, never a guess", () => {
		expect(readQuestKey("just prose")).toBeNull();
		expect(stripQuestKeys("just prose")).toBe("just prose");
	});
});

describe("planQuestSync", () => {
	it("creates a quest the board does not hold", () => {
		const plan = planQuestSync([md("a", "Open", "A\nprose")], []);
		expect(plan.create.map(c => c.id)).toEqual(["a"]);
		expect(readQuestKey(plan.create[0].body)).toBe("a");
	});

	it("is a no-op when the board already mirrors the md", () => {
		const q = md("a", "Open", "A\nprose");
		const plan = planQuestSync([q], [card("c1", "Open", withQuestKey("A\nprose", "a"))]);
		expect(plan.unchanged).toEqual(["a"]);
		expect(plan.create).toHaveLength(0);
		expect(plan.updateBody).toHaveLength(0);
		expect(plan.conflicts).toHaveLength(0);
	});

	it("leaves a key-less card alone and reports it — the md never adopts it", () => {
		// A key-less card has no identity, so "matches the md" cannot be established;
		// the sync reports it and creates the quest instead of guessing.
		const plan = planQuestSync([md("a", "Open", "A\nprose")], [card("c1", "Open", "A\nprose")]);
		expect(plan.updateBody).toHaveLength(0);
		expect(plan.unrecognised.map(u => u.cardId)).toEqual(["c1"]);
		expect(plan.create.map(c => c.id)).toEqual(["a"]);
	});

	it("repairs stale key placement on a card that carries the right key", () => {
		// Shipped/imported cards hold the body in description; the key line may sit
		// anywhere. Same text + same key => no write.
		const shipped = withQuestKey("A\nprose", "a");
		const plan = planQuestSync([md("a", "Open", "A\nprose")], [card("c1", "Open", shipped)]);
		expect(plan.updateBody).toHaveLength(0);
		expect(plan.unchanged).toEqual(["a"]);
	});

	it("REFUSES a board edit — the rule that could not fail before", () => {
		// same quest id, board text changed by a human
		const plan = planQuestSync(
			[md("a", "Open", "A\nprose")],
			[card("c1", "Open", withQuestKey("A\nedited on the board", "a"))],
		);
		expect(plan.conflicts.map(c => c.id)).toEqual(["a"]);
		expect(plan.updateBody).toHaveLength(0);
	});

	it("steers status from board to md, never moves the card", () => {
		const plan = planQuestSync(
			[md("a", "Open", "A\nprose")],
			[card("c1", "Done", withQuestKey("A\nprose", "a"))],
		);
		expect(plan.steerMdStatus).toEqual([
			{ id: "a", boardColumn: "Done", mdColumn: "Open" },
		]);
		expect(plan.create).toHaveLength(0);
		expect(plan.updateBody).toHaveLength(0);
	});

	it("archives a keyed card whose quest left the md — reversible, not deleted", () => {
		const plan = planQuestSync([], [card("c1", "Open", withQuestKey("Gone", "gone"))]);
		expect(plan.archive.map(a => a.id)).toEqual(["gone"]);
	});

	it("reports a key-less card as unrecognised, never adopts it by title", () => {
		const plan = planQuestSync([md("a", "Open", "A")], [card("c1", "Open", "A")]);
		expect(plan.unrecognised.map(u => u.cardId)).toEqual(["c1"]);
		// and it still creates the md's quest rather than assuming the orphan is it
		expect(plan.create.map(c => c.id)).toEqual(["a"]);
	});

	it("names a duplicate live card instead of merging two quests", () => {
		const plan = planQuestSync(
			[md("a", "Open", "A")],
			[card("c1", "Open", withQuestKey("A", "a")), card("c2", "Open", withQuestKey("A", "a"))],
		);
		expect(plan.conflicts).toHaveLength(1);
		expect(plan.conflicts[0].why).toContain("duplicate");
	});

	it("a quest listed in the md whose only card is archived is re-created", () => {
		const plan = planQuestSync(
			[md("a", "Open", "A")],
			[card("c1", "Open", withQuestKey("A", "a"), true)],
		);
		// archived rows are not live matches: the quest is re-created (visible)
		// rather than silently left archived
		expect(plan.create.map(c => c.id)).toEqual(["a"]);
	});
});
