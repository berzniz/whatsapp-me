import type { WASocketType } from "../whatsapp-client/types.js";
import type { WhatsAppConfig } from "../whatsapp-client/config.js";
import type { GroupManager } from "../whatsapp-client/group-manager.js";
import type { OpenAIService } from "../openai-service.js";
import type { MessageStore } from "../message-store.js";

export interface MessageHistoryItem {
	text: string;
	sender: string;
	timestamp: Date;
}

/**
 * Service to fetch message history from WhatsApp groups
 */
export class MessageHistoryFetcher {
	private socket: WASocketType | null;
	private config: WhatsAppConfig;
	private groupManager: GroupManager;
	private openaiService: OpenAIService | null;
	private messageStore: MessageStore | null;

	constructor(
		socket: WASocketType | null,
		config: WhatsAppConfig,
		groupManager: GroupManager,
		openaiService?: OpenAIService | null,
		messageStore?: MessageStore | null,
	) {
		this.socket = socket;
		this.config = config;
		this.groupManager = groupManager;
		this.openaiService = openaiService || null;
		this.messageStore = messageStore || null;
	}

	public setSocket(socket: WASocketType | null): void {
		this.socket = socket;
	}

	/**
	 * Check if a group name matches ALLOWED_CHAT_NAMES
	 */
	private isGroupAllowed(groupName: string): boolean {
		if (this.config.allowedChatNames.length === 0) {
			return false; // Don't fetch from all groups, only allowed ones
		}
		return this.config.allowedChatNames.some((name) =>
			this.config.containsWholeWord(groupName, name),
		);
	}

	/**
	 * Fetch recent messages from a group
	 * @param groupId - The WhatsApp group ID
	 * @param limit - Maximum number of messages to fetch (default: 50)
	 * @returns Array of message history items
	 */
	public async fetchMessageHistory(
		groupId: string,
		limit: number = 50,
	): Promise<MessageHistoryItem[]> {
		if (!this.socket) {
			console.warn("Socket not available for fetching message history");
			return [];
		}

		try {
			// Get group metadata to check if it's allowed
			const metadata = this.groupManager.getCachedMetadata(groupId);
			if (!metadata) {
				console.warn(`Group metadata not found for ${groupId}`);
				return [];
			}

			const groupName = metadata.subject || "";
			if (!this.isGroupAllowed(groupName)) {
				console.log(
					`Group "${groupName}" (${groupId}) is not in ALLOWED_CHAT_NAMES, skipping message fetch`,
				);
				return [];
			}

			console.log(
				`Fetching up to ${limit} messages from group "${groupName}" (${groupId})`,
			);

			// Try to fetch messages from WhatsApp using socket
			// Baileys loads messages through the socket's message loading capabilities
			// For now, we'll use stored message history from MessageStore
			// In the future, we can enhance this to fetch directly from WhatsApp

			// Use MessageStore as primary source (persistent disk storage)
			if (this.messageStore) {
				const storedMessages = this.messageStore.getMessages(groupId, limit);
				console.log(
					`MessageHistoryFetcher: Found ${storedMessages.length} stored messages for group "${groupName}" (${groupId})`,
				);
				if (storedMessages.length > 0) {
					console.log(
						`Using persistent message store (${storedMessages.length} messages) for group "${groupName}"`,
					);
					// Convert stored messages to MessageHistoryItem format
					return storedMessages.map((msg) => ({
						text: msg.text,
						sender: msg.sender,
						timestamp: new Date(msg.timestamp),
					}));
				}
			}

			// Fallback to OpenAIService stored history (for backward compatibility)
			if (this.openaiService) {
				const storedHistory = this.openaiService.getMessageHistory(groupId);
				console.log(
					`MessageHistoryFetcher: Checking OpenAIService history for group "${groupName}" (${groupId}): ${storedHistory.length} messages`,
				);
				if (storedHistory.length > 0) {
					console.log(
						`Using OpenAIService stored history (${storedHistory.length} messages) for group "${groupName}"`,
					);
					// Convert stored history strings to MessageHistoryItem format
					return storedHistory.map((text, index) => ({
						text,
						sender: "Unknown", // Stored history doesn't include sender info
						timestamp: new Date(
							Date.now() - (storedHistory.length - index) * 60000,
						), // Approximate timestamps
					}));
				}
			}

			// If no stored history, return empty array
			console.log(
				`MessageHistoryFetcher: No message history found for group "${groupName}" (${groupId})`,
			);
			return [];

			// TODO: Future enhancement - fetch messages directly from WhatsApp using Baileys
			// The code below would process messages fetched from WhatsApp
			// For now, we rely on stored message history from OpenAIService
			/*
			const historyItems: MessageHistoryItem[] = [];

			for (const message of messages) {
				if (!message.message) continue;

				const messageType = getContentType(message.message);
				if (
					messageType !== "conversation" &&
					messageType !== "extendedTextMessage"
				) {
					continue; // Only process text messages
				}

				// Extract message text
				let text = "";
				if (messageType === "conversation") {
					text = message.message.conversation || "";
				} else if (messageType === "extendedTextMessage") {
					text = message.message.extendedTextMessage?.text || "";
				}

				if (!text.trim()) continue;

				// Skip bot responses
				if (text.startsWith("🤖")) continue;

				// Extract sender
				const sender = message.key.participant
					? message.key.participant.split("@")[0]
					: "Unknown";

				// Extract timestamp
				const messageTimestamp = message.messageTimestamp;
				const timestamp =
					messageTimestamp && typeof messageTimestamp === "number"
						? new Date(messageTimestamp * 1000)
						: new Date();

				historyItems.push({
					text,
					sender,
					timestamp,
				});
			}

			console.log(
				`Fetched ${historyItems.length} messages from group "${groupName}"`,
			);

			return historyItems;
			*/
		} catch (error) {
			console.error(
				`Error fetching message history from group ${groupId}:`,
				error,
			);
			return [];
		}
	}

	/**
	 * Get list of allowed group IDs and names
	 */
	public getAllowedGroups(): Array<{ id: string; name: string }> {
		return this.groupManager.getAllowedCachedGroups();
	}

	/**
	 * Find a group ID by name
	 */
	public findGroupIdByName(groupName: string): string | null {
		return this.groupManager.findGroupIdByName(groupName);
	}

	/**
	 * Format message history as text for agent consumption
	 */
	public formatMessageHistory(history: MessageHistoryItem[]): string {
		if (history.length === 0) {
			return "No messages found.";
		}

		return history
			.map((msg, index) => {
				const timeStr = msg.timestamp.toLocaleString();
				return `[${index + 1}] ${timeStr} - ${msg.sender}: ${msg.text}`;
			})
			.join("\n");
	}
}
