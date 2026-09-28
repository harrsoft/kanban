import * as t from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { projects } from "./projects";
import { users } from "./users";
import { id, timestamps, unix } from "./util";
import {
	BoardId,
	CardAssigneeId,
	CardCommentId,
	CardId,
	ColumnId,
	LabelId,
	CardLabelId,
	ProjectId,
	UserId,
} from "../../../types"; // drizzle-kit can't handle path aliases

export const boards = t.pgTable("boards", {
	id: id().primaryKey().$type<BoardId>(),
	projectId: t
		.text("project_id")
		.notNull()
		.references(() => projects.id)
		.$type<ProjectId>(),
	name: t.text("name").notNull(),
	description: t.text("description"),
	archived: t.boolean("archived").notNull().default(false),
	// Recursive boards: a board may hang off the *card that spawned it* — a quest
	// or project that opens into its own workspace. A board with a parent is a
	// nested board, hidden from the top-level boards lists; depth is arbitrary and
	// bounded by the sync (depth cap + cycle check), not by the schema. `set null`
	// so deleting the spawning card detaches the sub-board rather than destroying it.
	parentCardId: t
		.text("parent_card_id")
		// Explicit return type breaks the inference cycle boards -> cards -> columns -> boards.
		.references((): t.AnyPgColumn => cards.id, { onDelete: "set null" })
		.$type<CardId>(),
	...timestamps,
});

export const columns = t.pgTable("columns", {
	id: id().primaryKey().$type<ColumnId>(),
	boardId: t
		.text("board_id")
		.notNull()
		.references(() => boards.id, { onDelete: "cascade" })
		.$type<BoardId>(),
	name: t.text("name").notNull(),
	order: t.integer("order").notNull().default(0),
	color: t.text("color").notNull().default("#6366f1"),
	...timestamps,
});

export const cards = t.pgTable("cards", {
	id: id().primaryKey().$type<CardId>(),
	columnId: t
		.text("column_id")
		.notNull()
		.references(() => columns.id, { onDelete: "cascade" })
		.$type<ColumnId>(),
	content: t.text("content").notNull(),
	description: t.text("description"),
	priority: t.text("priority").notNull().default("medium"),
	order: t.integer("order").notNull().default(0),
	dueDate: unix("due_date"),
	archived: t.boolean("archived").notNull().default(false),
	...timestamps,
});

// Relations
export const boardsRelations = relations(boards, ({ one, many }) => ({
	project: one(projects, {
		fields: [boards.projectId],
		references: [projects.id],
	}),
	columns: many(columns),
}));

export const columnsRelations = relations(columns, ({ one, many }) => ({
	board: one(boards, {
		fields: [columns.boardId],
		references: [boards.id],
	}),
	cards: many(cards),
}));

export const cardAssignees = t.pgTable("card_assignees", {
	id: id().primaryKey().$type<CardAssigneeId>(),
	cardId: t
		.text("card_id")
		.notNull()
		.references(() => cards.id, { onDelete: "cascade" })
		.$type<CardId>(),
	userId: t
		.text("user_id")
		.notNull()
		.references(() => users.id)
		.$type<UserId>(),
	...timestamps,
});

export const cardAssigneesRelations = relations(cardAssignees, ({ one }) => ({
	card: one(cards, {
		fields: [cardAssignees.cardId],
		references: [cards.id],
	}),
	user: one(users, {
		fields: [cardAssignees.userId],
		references: [users.id],
	}),
}));

export const cardComments = t.pgTable("card_comments", {
	id: id().primaryKey().$type<CardCommentId>(),
	cardId: t
		.text("card_id")
		.notNull()
		.references(() => cards.id, { onDelete: "cascade" })
		.$type<CardId>(),
	authorId: t
		.text("author_id")
		.notNull()
		.references(() => users.id)
		.$type<UserId>(),
	content: t.text("content").notNull(),
	...timestamps,
});

export const cardCommentsRelations = relations(cardComments, ({ one }) => ({
	card: one(cards, {
		fields: [cardComments.cardId],
		references: [cards.id],
	}),
	author: one(users, {
		fields: [cardComments.authorId],
		references: [users.id],
	}),
}));

export const cardsRelations = relations(cards, ({ one, many }) => ({
	column: one(columns, {
		fields: [cards.columnId],
		references: [columns.id],
	}),
	assignees: many(cardAssignees),
	labels: many(cardLabels),
	comments: many(cardComments),
}));

// Card labels/tags
export const labels = t.pgTable("labels", {
	id: id().primaryKey().$type<LabelId>(),
	boardId: t
		.text("board_id")
		.notNull()
		.references(() => boards.id, { onDelete: "cascade" })
		.$type<BoardId>(),
	name: t.text("name").notNull(),
	color: t.text("color").notNull().default("#6366f1"), // default indigo
	...timestamps,
});

export const labelsRelations = relations(labels, ({ one, many }) => ({
	board: one(boards, {
		fields: [labels.boardId],
		references: [boards.id],
	}),
	cardAssignments: many(cardLabels),
}));

export const cardLabels = t.pgTable("card_labels", {
	id: id().primaryKey().$type<CardLabelId>(),
	cardId: t
		.text("card_id")
		.notNull()
		.references(() => cards.id, { onDelete: "cascade" })
		.$type<CardId>(),
	labelId: t
		.text("label_id")
		.notNull()
		.references(() => labels.id, { onDelete: "cascade" })
		.$type<LabelId>(),
	...timestamps,
});

export const cardLabelsRelations = relations(cardLabels, ({ one }) => ({
	card: one(cards, {
		fields: [cardLabels.cardId],
		references: [cards.id],
	}),
	label: one(labels, {
		fields: [cardLabels.labelId],
		references: [labels.id],
	}),
}));
