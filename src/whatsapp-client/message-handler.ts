import {
	getContentType,
	isJidGroup,
	jidNormalizedUser,
	type WAMessage,
} from "@whiskeysockets/baileys";
import type { WASocketType } from "./types.js";
import type { OpenAIService } from "../openai-service.js";
import type { EventDeduplicationService } from "../event-deduplication.js";
import type { GroupManager } from "./group-manager.js";
import type { MessageSender } from "./message-sender.js";
import type { WhatsAppConfig } from "./config.js";
import type { ChatInfo } from "./types.js";
import type { MessageStore } from "../message-store.js";

export class MessageHandler {
	private socket: WASocketType | null;
	private openaiService: OpenAIService;
	private groupManager: GroupManager;
	private config: WhatsAppConfig;
	private messageStore: MessageStore | null;

	constructor(
		socket: WASocketType | null,
		openaiService: OpenAIService,
		_eventDeduplicationService: EventDeduplicationService,
		groupManager: GroupManager,
		_messageSender: MessageSender,
		config: WhatsAppConfig,
		messageStore?: MessageStore | null,
	) {
		this.socket = socket;
		this.openaiService = openaiService;
		this.groupManager = groupManager;
		this.config = config;
		this.messageStore = messageStore || null;
	}

	public setSocket(socket: WASocketType | null): void {
		this.socket = socket;
	}

	public async handleIncomingMessage(message: WAMessage): Promise<void> {
		try {
			// Skip if message has no content
			if (!message.message) {
				console.log(
					`Skipping message with no content from ${message.key.remoteJid}`,
				);
				return;
			}

			const messageType = getContentType(message.message);
			if (
				!messageType ||
				(messageType !== "conversation" &&
					messageType !== "extendedTextMessage")
			) {
				return; // Only process text messages for now
			}

			// Extract message text
			let messageText = "";
			if (messageType === "conversation") {
				messageText = message.message.conversation || "";
			} else if (messageType === "extendedTextMessage") {
				messageText = message.message.extendedTextMessage?.text || "";
			}

			if (!messageText.trim()) return;

			// Skip messages that are event summaries to avoid loops
			if (
				messageText.includes("Event Summary:") ||
				messageText.includes("Event details")
			) {
				return;
			}

			const chatId = message.key.remoteJid;
			if (!chatId) return;
			const isGroup = isJidGroup(chatId) ?? false;
			const timestamp = new Date().toLocaleTimeString();

			// Get chat and contact information
			const chatInfo = await this.getChatInfo(chatId, message, isGroup);

			// Skip bot responses (messages starting with robot emoji) to avoid loops
			if (messageText.startsWith("🤖")) {
				return;
			}

			// Log the message
			console.log(`\n--------------------------------`);
			console.log(
				`[${timestamp}] ${isGroup ? `[${chatInfo.chatName}]` : ""} ${chatInfo.contactName}: ${messageText}`,
			);

			// Store message persistently
			if (this.messageStore) {
				this.messageStore.storeMessage(message, chatId, chatInfo.contactName);
			}

			// Add message to history for this chat (for backward compatibility)
			this.openaiService.addMessageToHistory(chatId, messageText);

			// Determine if this is a bot group message
			const isBotGroup =
				isGroup && this.config.botGroupId && chatId === this.config.botGroupId;

			if (isBotGroup) {
				console.log(`Bot group message detected, routing to agent...`);
			} else {
				console.log(`Analyzing message for events...`);
			}

			// Route message to appropriate agent
			// Agents will handle their own responses via WhatsApp adapter
			if (isBotGroup) {
				const response = await this.openaiService.getChatResponse(
					chatId,
					messageText,
					chatInfo.chatName,
				);
				if (response) {
					console.log(
						`Bot response generated: ${response.substring(0, 100)}...`,
					);
				} else {
					console.warn("Bot did not generate a response");
				}
			} else {
				const analysis = await this.openaiService.analyzeMessage(
					chatId,
					messageText,
					chatInfo.chatName,
					chatInfo.contactName,
				);

				// Log analysis result
				if (analysis.isEvent) {
					console.log(`✓ Event detected: ${analysis.title || "Untitled"}`);
					console.log(`Event details:`, {
						title: analysis.title,
						date: analysis.date,
						time: analysis.time,
						location: analysis.location,
						description: analysis.description,
						startDateISO: analysis.startDateISO,
						endDateISO: analysis.endDateISO,
					});
				} else {
					console.log(`✗ No event detected in message`);
				}
			}
		} catch (error) {
			console.error("Error handling incoming message:", error);
		}
	}

	private async getChatInfo(
		chatId: string,
		message: WAMessage,
		isGroup: boolean,
	): Promise<ChatInfo> {
		let chatName = "";
		let contactName = "Unknown";

		try {
			if (isGroup) {
				// First try to get from cache to avoid rate limits
				const cachedMetadata = this.groupManager.getCachedMetadata(chatId);

				let groupMetadata = cachedMetadata;

				// Fetch metadata if not cached (we need it to process the message)
				// But only cache it if it's an allowed group to avoid rate limits
				if (!groupMetadata && this.socket) {
					const fetchedMetadata = await this.groupManager.fetchAndCacheMetadata(
						this.socket,
						chatId,
						null,
					);
					if (fetchedMetadata) {
						groupMetadata = fetchedMetadata;
					}
				}

				chatName = groupMetadata?.subject || "Unknown Group";

				// Find the participant who sent the message
				if (groupMetadata?.participants) {
					const participant = groupMetadata.participants.find(
						(p) =>
							jidNormalizedUser(p.id) ===
							jidNormalizedUser(message.key.participant || ""),
					);
					contactName =
						participant?.notify || participant?.id?.split("@")[0] || "Unknown";
				} else {
					contactName = message.key.participant?.split("@")[0] || "Unknown";
				}
			} else {
				chatName = chatId.split("@")[0];
				contactName = chatName;
			}
		} catch (error) {
			console.error("Error getting chat/contact info:", error);
			// Fallback values if error occurs
			if (!chatName) {
				chatName = chatId.split("@")[0];
			}
			if (contactName === "Unknown" && message.key.participant) {
				contactName = message.key.participant.split("@")[0];
			}
		}

		return { chatName, contactName };
	}
}
