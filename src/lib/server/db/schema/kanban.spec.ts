/**
 * Unit tests for the kanban DB schema (boards, columns, cards).
 *
 * Tests check table/column structure via drizzle-orm/pg-core metadata.
 * These are structural tests — they do not require a database connection.
 */

import { describe, it, expect } from "vitest";
import { boards, columns, cards } from "./kanban";

describe("boards table", () => {
	it("is defined", () => {
		expect(boards).toBeDefined();
	});

	it("has id, projectId, and name columns", () => {
		expect(boards.id).toBeDefined();
		expect(boards.projectId).toBeDefined();
		expect(boards.name).toBeDefined();
	});

	it("has createdAt, updatedAt, deletedAt timestamps", () => {
		expect(boards.createdAt).toBeDefined();
		expect(boards.updatedAt).toBeDefined();
		expect(boards.deletedAt).toBeDefined();
	});

	it("name column exists and has columnType text", () => {
		expect(boards.name).toBeDefined();
		// Verify it's a Drizzle column by checking columnType property
		expect((boards.name as any).columnType).toBe("PgText");
	});

	it("projectId column exists and has columnType text", () => {
		expect(boards.projectId).toBeDefined();
		expect((boards.projectId as any).columnType).toBe("PgText");
	});

	it("has a nullable parentCardId for recursive (nested) boards", () => {
		expect(boards.parentCardId).toBeDefined();
		expect((boards.parentCardId as any).columnType).toBe("PgText");
		// Top-level boards have no parent; nested boards point at the spawning card.
		expect((boards.parentCardId as any).notNull).toBeFalsy();
	});
});

describe("columns table", () => {
	it("is defined", () => {
		expect(columns).toBeDefined();
	});

	it("has id, boardId, name, and order columns", () => {
		expect(columns.id).toBeDefined();
		expect(columns.boardId).toBeDefined();
		expect(columns.name).toBeDefined();
		expect(columns.order).toBeDefined();
	});

	it("order column has columnType number", () => {
		expect(columns.order).toBeDefined();
		expect((columns.order as any).columnType).toBe("PgInteger");
	});

	it("boardId column exists", () => {
		expect(columns.boardId).toBeDefined();
	});

	it("has createdAt, updatedAt, deletedAt timestamps", () => {
		expect(columns.createdAt).toBeDefined();
		expect(columns.updatedAt).toBeDefined();
		expect(columns.deletedAt).toBeDefined();
	});
});

describe("cards table", () => {
	it("is defined", () => {
		expect(cards).toBeDefined();
	});

	it("has id, columnId, content, order, and dueDate columns", () => {
		expect(cards.id).toBeDefined();
		expect(cards.columnId).toBeDefined();
		expect(cards.content).toBeDefined();
		expect(cards.order).toBeDefined();
		expect(cards.dueDate).toBeDefined();
	});

	it("content column has columnType text", () => {
		expect(cards.content).toBeDefined();
		expect((cards.content as any).columnType).toBe("PgText");
	});

	it("order column has columnType number", () => {
		expect(cards.order).toBeDefined();
		expect((cards.order as any).columnType).toBe("PgInteger");
	});

	it("dueDate column has columnType bigint (unix timestamp)", () => {
		expect(cards.dueDate).toBeDefined();
		const columnType = (cards.dueDate as any).columnType;
		// Bun's Drizzle uses PgBigInt53, Node may use PgBigInt
		expect(["PgBigInt", "PgBigInt53"]).toContain(columnType);
	});

	it("columnId column exists", () => {
		expect(cards.columnId).toBeDefined();
	});

	it("content column exists", () => {
		expect(cards.content).toBeDefined();
	});
});
