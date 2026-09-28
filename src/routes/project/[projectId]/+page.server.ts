import { error } from "@sveltejs/kit";
import db from "$db";
import { projects, boards, columns, cards } from "$db/schema";
import { eq, sql, asc, and, isNull } from "drizzle-orm";
import { BoardId, ProjectId } from "$types/ids";
import type { PageServerLoad, Actions } from "./$types";

export const load: PageServerLoad = async ({ params, locals }) => {
	const session = locals.session;
	if (!session) {
		error(401, "Must be logged in");
	}

	const projectId = params.projectId;

	// Fetch non-archived boards for this project with column & card counts, plus last activity
	const projectBoards = await db
		.select({
			id: boards.id,
			name: boards.name,
			description: boards.description,
			createdAt: boards.createdAt,
			columnCount: sql<number>`count(distinct ${columns.id})`,
			cardCount: sql<number>`count(distinct ${cards.id})`,
			lastActivity: sql<number | null>`greatest(
				${boards.updatedAt},
				coalesce(max(${columns.updatedAt}), 0),
				coalesce(max(${cards.updatedAt}), 0)
			)`,
		})
		.from(boards)
		.leftJoin(columns, eq(columns.boardId, boards.id))
		.leftJoin(cards, eq(cards.columnId, columns.id))
		.where(
			and(
				eq(boards.projectId, projectId),
				eq(boards.archived, false),
				isNull(boards.parentCardId), // nested boards are reached through their spawning card, not the top-level list
			),
		)
		.groupBy(
			boards.id,
			boards.name,
			boards.description,
			boards.createdAt,
			boards.updatedAt,
		)
		.orderBy(asc(boards.createdAt));

	// Fetch archived board count for this project
	const archivedResult = await db
		.select({ count: sql<number>`count(*)` })
		.from(boards)
		.where(and(eq(boards.projectId, projectId), eq(boards.archived, true)));

	return {
		boards: projectBoards,
		archivedBoardCount: archivedResult[0]?.count ?? 0,
	};
};

export const actions: Actions = {
	updateProject: async ({ request, params }) => {
		const data = await request.formData();
		const name = ((data.get("name") as string) || "").trim();

		if (!name) return { error: "Project name is required" };

		await db
			.update(projects)
			.set({
				name,
				updatedAt: Math.floor(Date.now() / 1000),
			})
			.where(eq(projects.id, params.projectId as ProjectId));

		return { success: true };
	},

	createBoard: async ({ request, params }) => {
		const data = await request.formData();
		const name = ((data.get("name") as string) || "").trim();
		const description = ((data.get("description") as string) || "").trim();

		if (!name) return { error: "Board name is required" };

		await db.insert(boards).values({
			name,
			projectId: params.projectId,
			description: description || null,
		});

		return { success: true };
	},

	deleteBoard: async ({ request }) => {
		const data = await request.formData();
		const boardId = data.get("boardId") as BoardId;

		if (!boardId) return { error: "Board ID is required" };

		await db.delete(boards).where(eq(boards.id, boardId));

		return { success: true };
	},
};
