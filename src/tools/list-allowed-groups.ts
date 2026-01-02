import { z } from "zod";
import { tool } from "@openai/agents";
import type { MessageHistoryFetcher } from "../agents/message-history-fetcher.js";

/**
 * Tool: List all allowed groups
 * Returns all WhatsApp groups that the bot is allowed to access
 */
export function createListAllowedGroupsTool(
	messageHistoryFetcher: MessageHistoryFetcher | null,
) {
	return tool({
		name: "list_allowed_groups",
		description:
			"List all WhatsApp groups that the bot is allowed to access. Returns group names and IDs.",
		parameters: z.object({}),
		execute: async () => {
			if (!messageHistoryFetcher) {
				return {
					success: false,
					error: "Message history fetcher not available",
					groups: [],
				};
			}

			try {
				const groups = messageHistoryFetcher.getAllowedGroups();
				return {
					success: true,
					groups: groups.map((g) => ({
						id: g.id,
						name: g.name,
					})),
					count: groups.length,
				};
			} catch (error) {
				console.error("Error listing allowed groups:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
					groups: [],
				};
			}
		},
	});
}
