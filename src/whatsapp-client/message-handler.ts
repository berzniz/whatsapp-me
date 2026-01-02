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

export class MessageHandler {
	private socket: WASocketType | null;
	private openaiService: OpenAIService;
	private eventDeduplicationService: EventDeduplicationService;
	private groupManager: GroupManager;
	private messageSender: MessageSender;
	private config: WhatsAppConfig;

	constructor(
		socket: WASocketType | null,
		openaiService: OpenAIService,
		eventDeduplicationService: EventDeduplicationService,
		groupManager: GroupManager,
		messageSender: MessageSender,
		config: WhatsAppConfig,
	) {
		this.socket = socket;
		this.openaiService = openaiService;
		this.eventDeduplicationService = eventDeduplicationService;
		this.groupManager = groupManager;
		this.messageSender = messageSender;
		this.config = config;
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

			// Check if this is a message from the bot group
			if (
				isGroup &&
				this.config.botGroupId &&
				chatId === this.config.botGroupId
			) {
				// Skip bot responses (messages starting with robot emoji) to avoid loops
				if (messageText.startsWith("🤖")) {
					return;
				}
				// Handle bot group messages differently
				console.log(`\n--------------------------------`);
				console.log(
					`[${timestamp}] [${chatInfo.chatName}] ${chatInfo.contactName}: ${messageText}`,
				);
				console.log(`Bot group message detected, getting OpenAI response...`);

				// Add message to history for this chat
				this.openaiService.addMessageToHistory(chatId, messageText);

				// Get response from OpenAI
				const response = await this.openaiService.getChatResponse(
					chatId,
					messageText,
				);

				if (response) {
					// Send response back to bot group with robot emoji
					const responseWithEmoji = `🤖 ${response}`;
					await this.messageSender.sendMessageToGroup(
						this.config.botGroupId,
						responseWithEmoji,
					);
					console.log(`Sent bot response to bot group`);
				} else {
					console.warn(
						`Failed to get response from OpenAI for bot group message`,
					);
				}

				return; // Don't process as event detection
			}

			// Log the message
			console.log(`\n--------------------------------`);
			console.log(
				`[${timestamp}] ${isGroup ? `[${chatInfo.chatName}]` : ""} ${chatInfo.contactName}: ${messageText}`,
			);

			// Add message to history for this chat
			this.openaiService.addMessageToHistory(chatId, messageText);

			// Analyze the message for events
			console.log(`Analyzing message for events...`);

			const analysis = await this.openaiService.analyzeMessage(
				chatId,
				messageText,
				chatInfo.chatName,
				chatInfo.contactName,
			);

			// Log analysis result
			if (analysis.isEvent) {
				console.log(`✓ Event detected: ${analysis.title || "Untitled"}`);
			} else {
				console.log(`✗ No event detected in message`);
			}

			if (analysis.isEvent && analysis.summary) {
				console.log(`Event detected! Summary: ${analysis.summary}`);
				console.log(`Event details:`, {
					title: analysis.title,
					date: analysis.date,
					time: analysis.time,
					location: analysis.location,
					description: analysis.description,
					startDateISO: analysis.startDateISO,
					endDateISO: analysis.endDateISO,
				});

				// Check for duplicate events before processing
				const eventHashData = {
					title: analysis.title,
					date: analysis.date,
					time: analysis.time,
					location: analysis.location,
				};

				const shouldProcess =
					this.eventDeduplicationService.shouldProcessEvent(eventHashData);

				if (!shouldProcess) {
					console.log("Event is duplicate, skipping notification");
					return; // Exit early for duplicate events
				}

				// If we found the target group, send the summary
				if (this.config.targetGroupId) {
					const sourceChatInfo = isGroup
						? `Group: ${chatInfo.chatName}`
						: `Contact: ${chatInfo.contactName}`;

					// Send unified message with summary and calendar attachment
					if (analysis.title && analysis.startDateISO) {
						await this.messageSender.sendUnifiedEventMessage(
							this.config.targetGroupId,
							analysis,
							sourceChatInfo,
						);
					} else {
						// Fallback to text-only message if no complete event details
						const summaryMessage = `Event Summary:\n\n${analysis.summary}\n\nSource: ${sourceChatInfo}`;
						await this.messageSender.sendMessageToGroup(
							this.config.targetGroupId,
							summaryMessage,
						);
					}
					console.log(
						`Single event message with ICS attachment sent to target group (ID: ${this.config.targetGroupId})`,
					);
				} else {
					console.log(
						`Target group ${this.config.targetGroupName ? `"${this.config.targetGroupName}"` : ""} not found yet. Event summary not sent.`,
					);
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
