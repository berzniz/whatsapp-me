import { z } from "zod";
import { tool } from "@openai/agents";
import type { MessageHistoryFetcher } from "../agents/message-history-fetcher.js";

/**
 * Tool: Read messages from a specific group
 * Can read messages from any available group in the history
 */
export function createReadGroupMessagesTool(
	messageHistoryFetcher: MessageHistoryFetcher | null,
) {
	return tool({
		name: "read_group_messages",
		description:
			"Read recent messages from a specific WhatsApp group. This tool can read messages from any available group in the history. Provide the group name to fetch messages. Returns: messages array (with text, sender, timestamp), count (total messages), formatted string, and groupName. Use this data to answer questions like 'who said what?', 'how many messages?', or to summarize conversations.",
		parameters: z.object({
			groupName: z
				.string()
				.describe(
					"The name of the group to read messages from (e.g., 'אופירה נבון הסעות'). Extract this from the user's request.",
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.default(50)
				.describe(
					"Maximum number of messages to fetch (1-100, default: 50). Use a higher limit if asked about many messages.",
				),
		}),
		execute: async (args: { groupName: string; limit: number }) => {
			console.log(`[read_group_messages] Tool called with args:`, args);

			if (!messageHistoryFetcher) {
				console.error(
					`[read_group_messages] Message history fetcher not available`,
				);
				return {
					success: false,
					error: "Message history fetcher not available",
					messages: [],
				};
			}

			try {
				// Find group ID by name
				console.log(
					`[read_group_messages] Looking for group by name: "${args.groupName}"`,
				);
				const groupId = messageHistoryFetcher.findGroupIdByName(args.groupName);
				if (!groupId) {
					const availableGroups = messageHistoryFetcher.getAllowedGroups();
					console.log(
						`[read_group_messages] Group not found. Available groups:`,
						availableGroups.map((g) => g.name),
					);
					return {
						success: false,
						error: `Group "${args.groupName}" not found. Available groups: ${availableGroups
							.map((g) => g.name)
							.join(", ")}`,
						messages: [],
					};
				}
				console.log(
					`[read_group_messages] Found group ID: ${groupId} for name "${args.groupName}"`,
				);

				const limit = args.limit || 50;
				console.log(
					`[read_group_messages] Fetching ${limit} messages from group ${groupId}`,
				);
				const history = await messageHistoryFetcher.fetchMessageHistory(
					groupId,
					limit,
				);

				console.log(
					`[read_group_messages] Fetched ${history.length} messages from group ${groupId}`,
				);

				// Get group name for response
				const groups = messageHistoryFetcher.getAllowedGroups();
				const group = groups.find((g) => g.id === groupId);
				const groupName = group?.name || groupId;

				const result = {
					success: true,
					groupId,
					groupName,
					messages: history.map((msg) => ({
						text: msg.text,
						sender: msg.sender,
						timestamp: msg.timestamp.toISOString(),
					})),
					count: history.length,
					formatted: messageHistoryFetcher.formatMessageHistory(history),
				};

				console.log(
					`[read_group_messages] Returning result with ${result.count} messages`,
				);
				return result;
			} catch (error) {
				console.error("Error reading group messages:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
					messages: [],
				};
			}
		},
	});
}

