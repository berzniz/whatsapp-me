import { z } from "zod";
import { tool } from "@openai/agents";
import type { MessageHistoryFetcher } from "../agents/message-history-fetcher.js";

/**
 * Tool: Read messages from all available groups
 * Can read messages from all available groups in the history
 */
export function createReadMessagesTool(
	messageHistoryFetcher: MessageHistoryFetcher | null,
) {
	return tool({
		name: "read_messages",
		description:
			"Read recent messages from all available WhatsApp groups. This tool fetches messages from all groups that the bot has access to. Returns messages organized by group with group names, IDs, and message arrays. Use this when you need to see what's happening across all groups or when the user asks about messages from multiple groups.",
		parameters: z.object({
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.default(50)
				.describe(
					"Maximum number of messages to fetch per group (1-100, default: 50).",
				),
		}),
		execute: async (args: { limit: number }) => {
			console.log(`[read_messages] Tool called with args:`, args);

			if (!messageHistoryFetcher) {
				console.error(`[read_messages] Message history fetcher not available`);
				return {
					success: false,
					error: "Message history fetcher not available",
					groups: [],
				};
			}

			try {
				const limit = args.limit || 50;
				const groups = messageHistoryFetcher.getAllowedGroups();

				console.log(
					`[read_messages] Fetching messages from ${groups.length} groups`,
				);

				const results = await Promise.all(
					groups.map(async (group) => {
						try {
							const history = await messageHistoryFetcher.fetchMessageHistory(
								group.id,
								limit,
							);

							return {
								groupId: group.id,
								groupName: group.name,
								messages: history.map((msg) => ({
									text: msg.text,
									sender: msg.sender,
									timestamp: msg.timestamp.toISOString(),
								})),
								count: history.length,
								formatted: messageHistoryFetcher.formatMessageHistory(history),
							};
						} catch (error) {
							console.error(
								`[read_messages] Error fetching messages from group ${group.name}:`,
								error,
							);
							return {
								groupId: group.id,
								groupName: group.name,
								messages: [],
								count: 0,
								formatted: "Error fetching messages",
								error: error instanceof Error ? error.message : "Unknown error",
							};
						}
					}),
				);

				const totalMessages = results.reduce(
					(sum, group) => sum + group.count,
					0,
				);

				console.log(
					`[read_messages] Fetched ${totalMessages} total messages from ${groups.length} groups`,
				);

				return {
					success: true,
					groups: results,
					totalGroups: groups.length,
					totalMessages,
				};
			} catch (error) {
				console.error("Error reading messages from all groups:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
					groups: [],
				};
			}
		},
	});
}

