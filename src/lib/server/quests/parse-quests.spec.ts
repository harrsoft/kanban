import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
} from "./parse-quests";

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
