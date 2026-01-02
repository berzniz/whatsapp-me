import { Agent, run } from "@openai/agents";
import type { Session } from "@openai/agents";
import type { WhatsAppAdapter } from "./whatsapp-adapter.js";
import type { MessageHistoryFetcher } from "./message-history-fetcher.js";
import type { WhatsAppConfig } from "../whatsapp-client/config.js";
import type { GroupManager } from "../whatsapp-client/group-manager.js";
import {
	createListAllowedGroupsTool,
	createReadGroupMessagesTool,
} from "./group-tools.js";

/**
 * Agent specialized in reading and summarizing messages from ALLOWED_CHAT_NAMES groups
 */
export class GroupSummaryAgent {
	private agent: Agent;
	private whatsappAdapter: WhatsAppAdapter | null;
	private messageHistoryFetcher: MessageHistoryFetcher | null;
	private config: WhatsAppConfig;
	private groupManager: GroupManager;

	constructor(
		whatsappAdapter: WhatsAppAdapter | null,
		messageHistoryFetcher: MessageHistoryFetcher | null,
		config: WhatsAppConfig,
		groupManager: GroupManager,
	) {
		this.whatsappAdapter = whatsappAdapter;
		this.messageHistoryFetcher = messageHistoryFetcher;
		this.config = config;
		this.groupManager = groupManager;

		// Get list of allowed groups for the instructions
		const allowedGroups = this.messageHistoryFetcher
			? this.messageHistoryFetcher.getAllowedGroups()
			: [];
		const allowedGroupsList =
			allowedGroups.length > 0
				? allowedGroups.map((g) => `- ${g.name}`).join("\n")
				: this.config.allowedChatNames.length > 0
					? this.config.allowedChatNames.map((n) => `- ${n}`).join("\n")
					: "No groups configured";

		// Create tool functions bound to this instance
		const listGroupsTool = createListAllowedGroupsTool(
			this.messageHistoryFetcher,
		);
		const readMessagesTool = createReadGroupMessagesTool(
			this.messageHistoryFetcher,
		);

		this.agent = new Agent({
			name: "Group Summary Agent",
			instructions: `You are a helpful assistant that can read and summarize messages from WhatsApp groups.

AVAILABLE GROUPS:
${allowedGroupsList}

ALLOWED_CHAT_NAMES: ${this.config.allowedChatNames.join(", ") || "None configured"}

You have access to the following tools:
1. list_allowed_groups - List all groups you can access
2. read_group_messages - Read messages from a specific group by name or ID

When asked about a group or to summarize messages from a group:
1. Use the read_group_messages tool to fetch message history
2. Use the list_allowed_groups tool if the user asks what groups are available
3. Provide concise summaries of recent conversations
4. Answer specific questions about what was discussed
5. Identify key topics, decisions, or important information

Always use the tools to get the most up-to-date information. If message history is not available, let the user know.

Keep responses concise and helpful. Match the language of the user's question (Hebrew if asked in Hebrew, English if asked in English).`,
			tools: [listGroupsTool, readMessagesTool],
		});
	}

	/**
	 * Process a message and get a response about group messages
	 */
	public async processMessage(
		message: string,
		session: Session,
		context?: {
			chatId?: string;
			sendResponse?: boolean;
			groupName?: string;
			groupId?: string;
		},
	): Promise<string | null> {
		try {
			let prompt = message;
			let groupHistory = "";

			// Add information about available groups to the prompt
			const availableGroups = this.messageHistoryFetcher
				? this.messageHistoryFetcher.getAllowedGroups()
				: [];
			
			console.log(
				`GroupSummaryAgent: Available groups: ${availableGroups.length}`,
			);
			if (availableGroups.length > 0) {
				console.log(
					`GroupSummaryAgent: Groups: ${availableGroups.map((g) => g.name).join(", ")}`,
				);
				const groupsList = availableGroups
					.map((g) => `- ${g.name}`)
					.join("\n");
				prompt = `${message}\n\nAvailable groups you can access:\n${groupsList}`;
			} else {
				console.warn(
					`GroupSummaryAgent: No allowed groups found. ALLOWED_CHAT_NAMES: ${this.config.allowedChatNames.join(", ")}`,
				);
				if (this.config.allowedChatNames.length > 0) {
					prompt = `${message}\n\nNote: Groups are configured (${this.config.allowedChatNames.join(", ")}) but not yet cached. They will be available after the bot syncs with WhatsApp.`;
				}
			}

			// If a specific group is mentioned or requested, fetch its history
			if (context?.groupId && this.messageHistoryFetcher) {
				const history = await this.messageHistoryFetcher.fetchMessageHistory(
					context.groupId,
					50, // Fetch last 50 messages
				);

				if (history.length > 0) {
					groupHistory = `\n\nMessage history from group "${context.groupName || context.groupId}":\n${this.messageHistoryFetcher.formatMessageHistory(history)}`;
					prompt = `${prompt}${groupHistory}`;
				} else {
					prompt = `${prompt}\n\nNote: No recent message history available for this group.`;
				}
			} else {
				// Try to find groups mentioned in the message
				const mentionedGroups = this.findMentionedGroups(message);
				if (mentionedGroups.length > 0 && this.messageHistoryFetcher) {
					// Find group IDs for mentioned groups
					for (const group of mentionedGroups) {
						// Try to find group ID by name
						const groupId =
							group.id || this.messageHistoryFetcher.findGroupIdByName(group.name);
						
						if (groupId) {
							const history = await this.messageHistoryFetcher.fetchMessageHistory(
								groupId,
								50,
							);

							if (history.length > 0) {
								groupHistory = `\n\nMessage history from group "${group.name}":\n${this.messageHistoryFetcher.formatMessageHistory(history)}`;
								prompt = `${prompt}${groupHistory}`;
								break; // Use first group with history
							} else {
								console.log(
									`No message history found for group "${group.name}" (${groupId})`,
								);
							}
						} else {
							console.log(
								`Could not find group ID for "${group.name}" - group may not be cached yet`,
							);
						}
					}
				}
			}

			// Run the agent with the session
			const result = await run(this.agent, prompt, {
				session,
			});

			// Extract the response text
			const responseText = result.finalOutput?.toString() || "";
			const trimmedResponse = responseText.trim() || null;

			// Send response back if configured
			if (
				trimmedResponse &&
				context?.sendResponse &&
				context.chatId &&
				this.whatsappAdapter
			) {
				try {
					const responseWithEmoji = `🤖 ${trimmedResponse}`;
					await this.whatsappAdapter.sendMessageToGroup(
						context.chatId,
						responseWithEmoji,
					);
					console.log(`Sent group summary response to group ${context.chatId}`);
				} catch (error) {
					console.error("Error sending group summary response:", error);
				}
			}

			return trimmedResponse;
		} catch (error) {
			console.error("Error processing message with GroupSummaryAgent:", error);
			return null;
		}
	}

	/**
	 * Find groups mentioned in the message by matching against ALLOWED_CHAT_NAMES
	 * Returns groups that match the allowed chat names
	 */
	private findMentionedGroups(message: string): Array<{ id: string; name: string }> {
		const mentionedGroups: Array<{ id: string; name: string }> = [];

		if (this.config.allowedChatNames.length === 0) {
			return mentionedGroups;
		}

		// Check if any allowed group name is mentioned in the message
		for (const allowedName of this.config.allowedChatNames) {
			if (
				message.toLowerCase().includes(allowedName.toLowerCase()) ||
				this.config.containsWholeWord(message, allowedName)
			) {
				// Try to find the group ID from cached metadata
				// We need to search through cached groups to find matches
				// For now, we'll return the name and let the caller provide groupId
				mentionedGroups.push({
					id: "", // Will be filled by caller if available
					name: allowedName,
				});
			}
		}

		return mentionedGroups;
	}

}

