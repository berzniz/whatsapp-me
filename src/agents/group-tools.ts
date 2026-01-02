import { z } from "zod";
import { tool } from "@openai/agents";
import type { MessageHistoryFetcher } from "./message-history-fetcher.js";

/**
 * Tools for the Group Summary Agent to interact with WhatsApp groups
 */

/**
 * Create tool: List all allowed groups
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

/**
 * Create tool: Read messages from a specific group
 */
export function createReadGroupMessagesTool(
	messageHistoryFetcher: MessageHistoryFetcher | null,
) {
	return tool({
		name: "read_group_messages",
		description:
			"Read recent messages from a specific WhatsApp group. Provide either the group name or group ID. Optionally specify how many messages to fetch (default: 50, max: 100).",
		parameters: z.object({
			groupName: z
				.string()
				.optional()
				.describe("The name of the group to read messages from"),
			groupId: z
				.string()
				.optional()
				.describe("The WhatsApp group ID (e.g., '1234567890@g.us')"),
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.default(50)
				.describe("Maximum number of messages to fetch (1-100, default: 50)"),
		}),
		execute: async (args: {
			groupName?: string;
			groupId?: string;
			limit?: number;
		}) => {
			if (!messageHistoryFetcher) {
				return {
					success: false,
					error: "Message history fetcher not available",
					messages: [],
				};
			}

			try {
				let groupId = args.groupId || undefined;

				// If groupName is provided but groupId is not, try to find it
				if (!groupId && args.groupName) {
					const foundId = messageHistoryFetcher.findGroupIdByName(
						args.groupName,
					);
					if (!foundId) {
						return {
							success: false,
							error: `Group "${args.groupName}" not found. Available groups: ${messageHistoryFetcher
								.getAllowedGroups()
								.map((g) => g.name)
								.join(", ")}`,
							messages: [],
						};
					}
					groupId = foundId;
				}

				if (!groupId) {
					return {
						success: false,
						error: "Either groupName or groupId must be provided",
						messages: [],
					};
				}

				const limit = args.limit || 50;
				const history = await messageHistoryFetcher.fetchMessageHistory(
					groupId,
					limit,
				);

				// Get group name for response
				const groups = messageHistoryFetcher.getAllowedGroups();
				const group = groups.find((g) => g.id === groupId);
				const groupName = group?.name || groupId;

				return {
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
