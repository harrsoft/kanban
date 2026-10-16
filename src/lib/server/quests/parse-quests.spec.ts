import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuestCard } from "./parse-quests";
import {
	slugify,
	parseStatus,
	stripStatus,
	clip,
	boardColumnForStatus,
	sectionToColumn,
	parseQuestsContent,
	parseQuestsFile,
	questsToKanbanPayloads,
	parseQuestIdMarker,
	questIdMarker,
	resolveQuestIds,
} from "./parse-quests";

function mkCard(
	id: string,
	title: string,
	idSource: QuestCard["idSource"],
): QuestCard {
	return {
		id,
		idSource,
		title,
		description: "",
		status: "info",
		level: 3,
		children: [],
		section: "Open",
	};
}

// The post-2026-09-25 shape: `##` = a status/column of the single "Quests" board.
const SAMPLE = `---
created: 2026-01-01
updated: 2026-08-31
---

# 🚀 Quests 🛸

## Open

### 🧠 Cognitive enhancements
+ Quests about thinking.

#### 🥱 Rest
Ongoing rest work.

### 🌐 Magnova
Overview line.

## Doing

### 🔄 Deep dive
A running quest.

## Done

### ✅ Finish TNG
Description line one.
+ plus-prefixed description

## Comments

🐐→🐺: a side channel, not board content.
`;

describe("parse-quests helpers", () => {
	it("slugify lowercases and dashes", () => {
		expect(slugify("Hello, World! 2026")).toBe("hello-world-2026");
	});

	it("parseStatus maps the three markers", () => {
		expect(parseStatus("✅ done")).toBe("done");
		expect(parseStatus("🔄 wip")).toBe("in-progress");
		expect(parseStatus("📅 planned")).toBe("planned");
		expect(parseStatus("plain")).toBe("info");
	});

	it("stripStatus removes a leading marker only", () => {
		expect(stripStatus("✅ Finish TNG")).toBe("Finish TNG");
		expect(stripStatus("Finish ✅ TNG")).toBe("Finish ✅ TNG");
	});

	it("boardColumnForStatus maps to the canonical columns", () => {
		expect(boardColumnForStatus("done")).toBe("Done");
		expect(boardColumnForStatus("in-progress")).toBe("Doing");
		expect(boardColumnForStatus("planned")).toBe("Open");
		expect(boardColumnForStatus("info")).toBe("Open");
	});
});

describe("sectionToColumn", () => {
	it("maps canonical sections, case-insensitively", () => {
		expect(sectionToColumn("Open")).toBe("Open");
		expect(sectionToColumn("doing")).toBe("Doing");
		expect(sectionToColumn("DONE")).toBe("Done");
		expect(sectionToColumn("Not doing")).toBe("Not doing");
	});

	it("accepts the legacy emoji sections", () => {
		expect(sectionToColumn("✨ New")).toBe("Open");
		expect(sectionToColumn("🏁 Complete")).toBe("Done");
	});

	it("returns null for a non-status section", () => {
		expect(sectionToColumn("Comments")).toBeNull();
		expect(sectionToColumn("Notes to self")).toBeNull();
	});
});

describe("clip — surrogate-safe truncation", () => {
	it("returns the string unchanged when short enough", () => {
		expect(clip("abcdef", 10)).toBe("abcdef");
	});

	it("truncates normally mid-ASCII", () => {
		expect(clip("abcdef", 3)).toBe("abc");
	});

	it("never orphans a surrogate pair at the boundary", () => {
		// 79 'x' + a 2-unit astral emoji (U+1F504) = 81 units; a blind slice(0,80)
		// would keep the high surrogate alone.
		const s = "x".repeat(79) + "🔄";
		const out = clip(s, 80);
		expect(out.length).toBe(79);
		// No lone surrogate anywhere in the output.
		for (let i = 0; i < out.length; i++) {
			const c = out.charCodeAt(i);
			if (c >= 0xd800 && c <= 0xdbff) {
				const n = out.charCodeAt(i + 1);
				expect(n >= 0xdc00 && n <= 0xdfff).toBe(true);
			}
		}
	});
});

describe("parseQuestsContent", () => {
	it("parses frontmatter, the title, sections and cards", () => {
		const data = parseQuestsContent(SAMPLE);
		expect(data.meta.created).toBe("2026-01-01");
		expect(data.meta.updated).toBe("2026-08-31");
		expect(data.title).toBe("🚀 Quests 🛸");
		expect(data.sections.map(s => s.name)).toEqual([
			"Open",
			"Doing",
			"Done",
			"Comments",
		]);
		expect(data.sections.map(s => s.column)).toEqual([
			"Open",
			"Doing",
			"Done",
			null,
		]);
	});

	it("carries each card's column from its section, and strips legacy markers", () => {
		const data = parseQuestsContent(SAMPLE);
		const open = data.sections[0];
		expect(open.cards.map(c => c.title)).toEqual([
			"🧠 Cognitive enhancements",
			"🌐 Magnova",
		]);
		expect(open.cards[0].section).toBe("Open");
		const doing = data.sections[1];
		expect(doing.cards[0].title).toBe("Deep dive");
		expect(doing.cards[0].status).toBe("in-progress");
		const done = data.sections[2];
		expect(done.cards[0].title).toBe("Finish TNG");
		expect(done.cards[0].status).toBe("done");
		// "+" lines become description; bare lines too.
		expect(done.cards[0].description).toContain("Description line one.");
		expect(done.cards[0].description).toContain("plus-prefixed description");
	});

	it("nests level-4 cards under the most recent level-3 card", () => {
		const data = parseQuestsContent(SAMPLE);
		const open = data.sections[0];
		expect(open.cards[0].children.map(c => c.title)).toEqual(["🥱 Rest"]);
	});

	it("accepts the legacy emoji sections", () => {
		const data = parseQuestsContent(
			"# D\n## ✨ New\n### a\n## 🏁 Complete\n### b\n",
		);
		expect(data.sections.map(s => s.column)).toEqual(["Open", "Done"]);
	});

	it("opens an implicit Open section for a card before any `##`", () => {
		const data = parseQuestsContent("# D\n### orphan\n");
		expect(data.sections).toHaveLength(1);
		expect(data.sections[0].column).toBe("Open");
		expect(data.sections[0].cards[0].title).toBe("orphan");
	});
});

describe("questsToKanbanPayloads", () => {
	it("produces ONE board named Quests with the canonical columns", () => {
		const payloads = questsToKanbanPayloads(parseQuestsContent(SAMPLE));
		expect(payloads).toHaveLength(1);
		expect(payloads[0].name).toBe("Quests");
		expect(payloads[0].columns).toEqual(["Open", "Doing", "Done", "Not doing"]);
	});

	it("places each card in its section's column and skips non-status sections", () => {
		const payloads = questsToKanbanPayloads(parseQuestsContent(SAMPLE));
		const byTitle = Object.fromEntries(
			payloads[0].cards.map(c => [c.title, c.column]),
		);
		expect(byTitle["🧠 Cognitive enhancements"]).toBe("Open");
		expect(byTitle["🌐 Magnova"]).toBe("Open");
		expect(byTitle["Deep dive"]).toBe("Doing");
		expect(byTitle["Finish TNG"]).toBe("Done");
		// the Comments section contributes no cards
		expect(payloads[0].cards).toHaveLength(4);
	});

	it("renders sub-items and clips them surrogate-safely", () => {
		const long = "⚠️ " + "y".repeat(200);
		const data = parseQuestsContent(`# D\n## Open\n### P\n#### c\n${long}\n`);
		const payloads = questsToKanbanPayloads(data);
		const desc = payloads[0].cards[0].description;
		expect(desc).toContain("**Sub-items:**");
		expect(desc).toContain("- c:");
		// No lone surrogate in the rendered description.
		for (let i = 0; i < desc.length; i++) {
			const c = desc.charCodeAt(i);
			if (c >= 0xd800 && c <= 0xdbff) {
				const n = desc.charCodeAt(i + 1);
				expect(n >= 0xdc00 && n <= 0xdfff).toBe(true);
			}
		}
	});
});

describe("parseQuestsFile", () => {
	it("reads and parses from disk", () => {
		const dir = mkdtempSync(join(tmpdir(), "quests-"));
		const p = join(dir, "Quests.md");
		writeFileSync(p, "# Quests\n## Open\n### Card\n");
		const data = parseQuestsFile(p);
		expect(data.sections[0].cards[0].title).toBe("Card");
	});
});

describe("quest-id marker (the sync's stable key)", () => {
	it("parses a marker line, tolerating spacing", () => {
		expect(
			parseQuestIdMarker("<!-- quest-id: cognitive-enhancements -->"),
		).toBe("cognitive-enhancements");
		expect(parseQuestIdMarker("<!--quest-id:abc.def_1-->")).toBe("abc.def_1");
		expect(parseQuestIdMarker("<!-- quest-id: with spaces -->")).toBeNull();
		expect(parseQuestIdMarker("just prose")).toBeNull();
	});

	it("round-trips through questIdMarker", () => {
		expect(parseQuestIdMarker(questIdMarker("mag"))).toBe("mag");
	});

	it("reads the marker off a card instead of leaking it into the description", () => {
		const data = parseQuestsContent(
			"# Quests\n## Open\n### 🧠 Cognitive enhancements\n<!-- quest-id: cog -->\n+ Quests about thinking.\n",
		);
		const card = data.sections[0].cards[0];
		expect(card.id).toBe("cog");
		expect(card.idSource).toBe("marker");
		expect(card.description).toBe("Quests about thinking.");
		expect(card.description).not.toContain("quest-id");
	});

	it("falls back to a slug id and says so when no marker is present", () => {
		const data = parseQuestsContent(
			"# Quests\n## Open\n### 🌐 Magnova\nOverview.\n",
		);
		const card = data.sections[0].cards[0];
		expect(card.id).toBe("magnova");
		expect(card.idSource).toBe("slug");
	});

	it("disambiguates two cards that would otherwise share a slug id", () => {
		const data = parseQuestsContent(
			"# Quests\n## Open\n### Trust\nA\n### Trust\nB\n",
		);
		const cards = data.sections[0].cards;
		expect(cards[0].id).toBe("trust");
		expect(cards[1].id).toBe("trust-2");
	});

	it("disambiguates a duplicated explicit marker by suffixing the later one", () => {
		const data = parseQuestsContent(
			"# Q\n## Open\n### A\n<!-- quest-id: dup -->\nx\n### B\n<!-- quest-id: dup -->\ny\n",
		);
		const cards = data.sections[0].cards;
		expect(cards[0].id).toBe("dup");
		expect(cards[1].id).toBe("dup-2");
	});

	it("scopes uniqueness per section, not globally", () => {
		const data = parseQuestsContent(
			"# Q\n## Open\n### Trust\nx\n## Done\n### Trust\ny\n",
		);
		const [open, done] = data.sections;
		expect(open.cards[0].id).toBe("trust");
		expect(done.cards[0].id).toBe("trust");
	});

	it("carries the id (and only the id) into the kanban payload", () => {
		const data = parseQuestsContent(
			"# Q\n## Open\n### 🧠 cog\n<!-- quest-id: cog -->\nbody\n",
		);
		const payload = questsToKanbanPayloads(data)[0];
		expect(payload.cards[0].id).toBe("cog");
	});

	it("resolveQuestIds keeps an existing marker id verbatim", () => {
		const data = parseQuestsContent(
			"# Q\n## Open\n### Renamed heading\n<!-- quest-id: original -->\nx\n",
		);
		expect(data.sections[0].cards[0].id).toBe("original");
	});

	it("resolveQuestIds operates on a hand-built section (pure contract)", () => {
		const section = {
			name: "Open",
			column: "Open" as string | null,
			cards: [
				mkCard("a", "Same Title", "slug"),
				mkCard("b", "Same Title", "slug"),
			],
		};
		resolveQuestIds(section);
		expect(section.cards.map(c => c.id)).toEqual([
			"same-title",
			"same-title-2",
		]);
	});
});
