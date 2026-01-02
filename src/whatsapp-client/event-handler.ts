import { isJidGroup, type BaileysEventMap } from "@whiskeysockets/baileys";
import type { WASocketType } from "./types.js";
import type { GroupManager } from "./group-manager.js";
import type { MessageHandler } from "./message-handler.js";
import type { WhatsAppConfig } from "./config.js";

export class EventHandler {
	private socket: WASocketType | null;
	private groupManager: GroupManager;
	private messageHandler: MessageHandler;
	private config: WhatsAppConfig;

	constructor(
		socket: WASocketType | null,
		groupManager: GroupManager,
		messageHandler: MessageHandler,
		config: WhatsAppConfig,
	) {
		this.socket = socket;
		this.groupManager = groupManager;
		this.messageHandler = messageHandler;
		this.config = config;
	}

	public setSocket(socket: WASocketType | null): void {
		this.socket = socket;
	}

	public setupEventListeners(): void {
		if (!this.socket) return;

		// Handle incoming messages
		this.socket.ev.on(
			"messages.upsert",
			async (messageUpdate: BaileysEventMap["messages.upsert"]) => {
				const { messages, type } = messageUpdate;

				console.log(`Received ${messages.length} message(s), type: ${type}`);

				if (type !== "notify") {
					console.log(`Skipping message type: ${type}`);
					return;
				}

				for (const message of messages) {
					try {
						await this.messageHandler.handleIncomingMessage(message);
					} catch (error) {
						console.error("Error handling message:", error);
						// Continue processing other messages even if one fails
					}
				}
			},
		);

		// Handle group updates
		this.socket.ev.on(
			"groups.update",
			async (updates: BaileysEventMap["groups.update"]) => {
				for (const update of updates) {
					if (!update.id) continue;

					// Check if this is our target group (only if not already configured from env)
					if (update.subject && !this.config.targetGroupId && update.id) {
						if (update.subject === this.config.targetGroupName) {
							this.config.targetGroupId = update.id;
							console.log(
								`Found target group "${this.config.targetGroupName}" with ID: ${this.config.targetGroupId}`,
							);
						}
					}

					// Check if this is our bot group (only if not already configured from env)
					if (
						update.subject &&
						this.config.botGroupName &&
						!this.config.botGroupId &&
						update.id
					) {
						if (update.subject === this.config.botGroupName) {
							this.config.botGroupId = update.id;
							console.log(
								`Found bot group "${this.config.botGroupName}" with ID: ${this.config.botGroupId}`,
							);
						}
					}

					// Only update group metadata cache for allowed groups to avoid rate limits
					if (
						!this.groupManager.shouldCacheGroupMetadata(
							update.subject || null,
							update.id,
						)
					) {
						continue;
					}

					if (!this.socket) return;
					await this.groupManager.updateGroupMetadata(
						this.socket,
						update.id,
						update.subject || null,
					);
				}
			},
		);

		// Handle group participants update
		this.socket.ev.on(
			"group-participants.update",
			async (event: BaileysEventMap["group-participants.update"]) => {
				// Only update group metadata cache for allowed groups to avoid rate limits
				// First check if we have cached metadata to get the subject
				const cachedMetadata = this.groupManager.getCachedMetadata(event.id);
				const groupSubject = cachedMetadata?.subject ?? null;

				if (!this.groupManager.shouldCacheGroupMetadata(groupSubject, event.id)) {
					return;
				}

				// Update group metadata cache when participants change
				if (!this.socket) return;
				await this.groupManager.updateGroupMetadata(
					this.socket,
					event.id,
					groupSubject,
				);
			},
		);

		// Handle chats update
		this.socket.ev.on(
			"chats.upsert",
			async (chats: BaileysEventMap["chats.upsert"]) => {
				// Look for our target group in new chats (only if not already configured from env)
				for (const chat of chats) {
					if (
						chat.id &&
						isJidGroup(chat.id) &&
						chat.name === this.config.targetGroupName &&
						!this.config.targetGroupId
					) {
						this.config.targetGroupId = chat.id;
						console.log(
							`Found target group "${this.config.targetGroupName}" with ID: ${this.config.targetGroupId}`,
						);
					}

					// Look for our bot group in new chats (only if not already configured from env)
					if (
						chat.id &&
						isJidGroup(chat.id) &&
						this.config.botGroupName &&
						chat.name === this.config.botGroupName &&
						!this.config.botGroupId
					) {
						this.config.botGroupId = chat.id;
						console.log(
							`Found bot group "${this.config.botGroupName}" with ID: ${this.config.botGroupId}`,
						);
					}
				}
			},
		);
	}
}

