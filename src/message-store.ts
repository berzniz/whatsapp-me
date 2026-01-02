import * as fs from "fs";
import * as path from "path";
import type { WAMessage } from "@whiskeysockets/baileys";
import { getContentType } from "@whiskeysockets/baileys";

export interface StoredMessage {
	text: string;
	sender: string;
	timestamp: number; // Unix timestamp in milliseconds
	chatId: string;
	messageId: string;
	participant?: string;
}

/**
 * Persistent message store that saves messages to disk and loads them on startup
 */
export class MessageStore {
	private readonly storeDir: string;
	private readonly messagesDir: string;
	private messages: Map<string, StoredMessage[]> = new Map();

	constructor(storeDir?: string) {
		// Default to .message-history directory in project root
		this.storeDir = storeDir || ".message-history";
		this.messagesDir = path.join(this.storeDir, "messages");

		// Ensure directories exist
		this.ensureDirectories();

		// Load existing messages from disk
		this.loadMessagesFromDisk();
	}

	private ensureDirectories(): void {
		if (!fs.existsSync(this.storeDir)) {
			fs.mkdirSync(this.storeDir, { recursive: true });
		}
		if (!fs.existsSync(this.messagesDir)) {
			fs.mkdirSync(this.messagesDir, { recursive: true });
		}
	}

	/**
	 * Get the file path for a chat's messages
	 */
	private getChatFilePath(chatId: string): string {
		// Sanitize chatId for filename (replace @ and other special chars)
		const sanitized = chatId.replace(/[@\/\\:]/g, "_");
		return path.join(this.messagesDir, `${sanitized}.json`);
	}

	/**
	 * Load all messages from disk
	 */
	private loadMessagesFromDisk(): void {
		try {
			if (!fs.existsSync(this.messagesDir)) {
				console.log("Message store directory does not exist, starting fresh");
				return;
			}

			const files = fs.readdirSync(this.messagesDir);
			let totalMessages = 0;

			for (const file of files) {
				if (!file.endsWith(".json")) continue;

				const filePath = path.join(this.messagesDir, file);
				try {
					const content = fs.readFileSync(filePath, "utf-8");
					const messages: StoredMessage[] = JSON.parse(content);

					// Extract chatId from first message (all messages in file have same chatId)
					if (messages.length > 0) {
						const chatId = messages[0].chatId;
						this.messages.set(chatId, messages);
						totalMessages += messages.length;
						console.log(
							`Loaded ${messages.length} messages for chat ${chatId.substring(0, 20)}...`,
						);
					}
				} catch (error) {
					console.error(`Error loading messages from ${file}:`, error);
				}
			}

			console.log(
				`✓ Loaded ${totalMessages} messages from ${files.length} chat files`,
			);
		} catch (error) {
			console.error("Error loading messages from disk:", error);
		}
	}

	/**
	 * Save messages for a chat to disk
	 */
	private saveChatToDisk(chatId: string, messages: StoredMessage[]): void {
		try {
			const filePath = this.getChatFilePath(chatId);
			fs.writeFileSync(filePath, JSON.stringify(messages, null, 2), "utf-8");
		} catch (error) {
			console.error(`Error saving messages for chat ${chatId}:`, error);
		}
	}

	/**
	 * Store a message
	 */
	public storeMessage(
		message: WAMessage,
		chatId: string,
		sender: string,
	): void {
		try {
			// Skip if message has no content
			if (!message.message) {
				return;
			}

			// Extract message text
			const messageType = getContentType(message.message);
			if (
				!messageType ||
				(messageType !== "conversation" &&
					messageType !== "extendedTextMessage")
			) {
				return; // Only store text messages
			}

			let text = "";
			if (messageType === "conversation" && message.message.conversation) {
				text = message.message.conversation;
			} else if (
				messageType === "extendedTextMessage" &&
				message.message.extendedTextMessage
			) {
				text = message.message.extendedTextMessage.text || "";
			}

			if (!text.trim()) return;

			// Skip bot responses
			if (text.startsWith("🤖")) return;

			// Skip event summaries
			if (text.includes("Event Summary:") || text.includes("Event details")) {
				return;
			}

			// Get timestamp
			const timestamp =
				message.messageTimestamp && typeof message.messageTimestamp === "number"
					? message.messageTimestamp * 1000 // Convert to milliseconds
					: Date.now();

			const storedMessage: StoredMessage = {
				text,
				sender,
				timestamp,
				chatId,
				messageId: message.key.id || "",
				participant: message.key.participant || undefined,
			};

			// Add to memory
			if (!this.messages.has(chatId)) {
				this.messages.set(chatId, []);
			}

			const chatMessages = this.messages.get(chatId);
			if (!chatMessages) {
				return; // Should not happen, but handle gracefully
			}

			// Check if message already exists (avoid duplicates)
			const exists = chatMessages.some(
				(m) => m.messageId === storedMessage.messageId,
			);
			if (exists) {
				return; // Skip duplicate
			}

			chatMessages.push(storedMessage);

			// Sort by timestamp (oldest first)
			chatMessages.sort((a, b) => a.timestamp - b.timestamp);

			// Save to disk (async, don't wait)
			this.saveChatToDisk(chatId, chatMessages);
		} catch (error) {
			console.error("Error storing message:", error);
		}
	}

	/**
	 * Get messages for a chat
	 */
	public getMessages(chatId: string, limit?: number): StoredMessage[] {
		const messages = this.messages.get(chatId) || [];

		if (limit) {
			// Return the last N messages (most recent)
			return messages.slice(-limit);
		}

		return messages;
	}

	/**
	 * Get all chat IDs that have messages
	 */
	public getAllChatIds(): string[] {
		return Array.from(this.messages.keys());
	}

	/**
	 * Get message count for a chat
	 */
	public getMessageCount(chatId: string): number {
		return this.messages.get(chatId)?.length || 0;
	}

	/**
	 * Get total message count across all chats
	 */
	public getTotalMessageCount(): number {
		let total = 0;
		for (const messages of this.messages.values()) {
			total += messages.length;
		}
		return total;
	}
}
