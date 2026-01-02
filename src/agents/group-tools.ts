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
			"Read recent messages from a specific WhatsApp group. This tool MUST be called when asked to summarize a group. Provide either the group name (e.g., 'טל') or group ID. The tool will fetch message history from the group's stored messages. Always call this tool before providing any summary.",
		parameters: z.object({
			groupName: z
				.string()
				.optional()
				.describe(
					"The name of the group to read messages from (e.g., 'טל' for group named 'טל'). Extract this from the user's request.",
				),
			groupId: z
				.string()
				.optional()
				.describe(
					"The WhatsApp group ID (e.g., '1234567890@g.us'). Use this if you know the exact ID.",
				),
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
				let groupId = args.groupId || undefined;

				// If groupName is provided but groupId is not, try to find it
				if (!groupId && args.groupName) {
					console.log(
						`[read_group_messages] Looking for group by name: "${args.groupName}"`,
					);
					const foundId = messageHistoryFetcher.findGroupIdByName(
						args.groupName,
					);
					if (!foundId) {
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
						`[read_group_messages] Found group ID: ${foundId} for name "${args.groupName}"`,
					);
					groupId = foundId;
				}

				if (!groupId) {
					console.error(
						`[read_group_messages] No groupId provided and couldn't find by name`,
					);
					return {
						success: false,
						error: "Either groupName or groupId must be provided",
						messages: [],
					};
				}

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
