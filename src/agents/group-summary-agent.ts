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
			name: "Group Summary Sub-Agent",
			instructions: `You are a helpful assistant that can read and summarize messages from WhatsApp groups.

AVAILABLE GROUPS:
${allowedGroupsList}

ALLOWED_CHAT_NAMES: ${this.config.allowedChatNames.join(", ") || "None configured"}

CRITICAL: You MUST use the read_group_messages tool to fetch message history BEFORE answering any questions. Never say you don't have access - always call the tool first.

You have access to the following tools:
1. list_allowed_groups - List all groups you can access
2. read_group_messages - Read messages from a specific group by name or ID. Returns:
   - messages: Array of messages with text, sender, and timestamp
   - count: Total number of messages fetched
   - formatted: Formatted message history string
   - groupName: Name of the group

CAPABILITIES:
You can answer questions such as:
- "Who said what?" / "מי אמר מה?" - Use the sender field from each message to identify who said what
- "How many messages are in the history?" / "כמה הודעות יש בהיסטוריה?" - Use the count field from the tool response
- "Summarize the last messages" / "סכם את ההודעות האחרונות" - Use the messages array or formatted string to create a summary
- "What was discussed?" / "על מה דיברו?" - Analyze the message content to identify topics
- Any other questions about the group's message history

WORKFLOW:
1. IMMEDIATELY call the read_group_messages tool with the group name mentioned in the request
2. If the group name is "טל" or similar, use that name in the tool call
3. After receiving the tool response:
   - For "who said what" questions: List each message with its sender
   - For "how many messages" questions: Report the count from the tool response
   - For summary questions: Analyze the messages array or formatted string and provide a concise summary
   - For other questions: Use the message data to answer accurately

IMPORTANT RULES:
- ALWAYS call read_group_messages tool FIRST when asked about a group
- Use the group name from the user's request (e.g., "טל" for group "טל")
- The tool returns messages with sender, text, and timestamp - use all this information
- If the tool returns messages, use them to answer the question accurately
- If the tool returns an error, explain what happened but still try to help
- Never say you don't have access without trying the tool first
- Be specific: when asked "who said what", list the actual senders and their messages

Keep responses concise and helpful. Match the language of the user's question (Hebrew if asked in Hebrew, English if asked in English).`,
			tools: [listGroupsTool, readMessagesTool],
		});
	}

	/**
	 * Get the underlying Agent instance for use in handoffs
	 */
	public getAgent(): Agent {
		return this.agent;
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

