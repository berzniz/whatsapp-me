import makeWASocket, {
	useMultiFileAuthState,
	getContentType,
	isJidGroup,
	jidNormalizedUser,
	Browsers,
	DisconnectReason,
	type WAMessageKey,
	type WAMessage,
	type BaileysEventMap,
} from "@whiskeysockets/baileys";
import type { Boom } from "@hapi/boom";
import * as fs from "fs";
import qrcode from "qrcode-terminal";
import NodeCache from "node-cache";
import { OpenAIService, type EventDetails } from "./openai-service.js";
import { EventDeduplicationService } from "./event-deduplication.js";

type WASocketType = ReturnType<typeof makeWASocket>;

export class WhatsAppClient {
	private socket: WASocketType | null = null;
	private isReady: boolean = false;
	private isSynced: boolean = false;
	private reconnectAttempts: number = 0;
	private maxReconnectAttempts: number = 3;
	private readonly sessionDir = ".baileys_auth";
	private openaiService: OpenAIService;
	private targetGroupName: string = "אני"; // Default target group name (can be overridden via TARGET_GROUP_NAME env var)
	private targetGroupId: string | null = null;
	private shouldReconnect: boolean = true;
	private connectionState: string = "close";
	private groupCache = new NodeCache({ stdTTL: 5 * 60, useClones: false }); // 5 minute TTL
	private eventDeduplicationService: EventDeduplicationService;
	private readonly allowedChatNames: string[];

	constructor() {
		this.openaiService = new OpenAIService();
		this.eventDeduplicationService = new EventDeduplicationService();

		// Get allowed chat names from environment variable
		const allowedChatNamesStr = process.env.ALLOWED_CHAT_NAMES;
		this.allowedChatNames = allowedChatNamesStr
			? allowedChatNamesStr.split(",").map((name) => name.trim())
			: [];

		// Configure target group from environment variables
		this.configureTargetGroup();

		// Ensure session directory exists
		this.ensureSessionDir();
	}

	private configureTargetGroup(): void {
		// Read target group configuration from environment variables
		const envTargetGroupId = process.env.TARGET_GROUP_ID?.trim();
		const envTargetGroupName = process.env.TARGET_GROUP_NAME?.trim();

		if (envTargetGroupId) {
			// If TARGET_GROUP_ID is provided, use it directly
			this.targetGroupId = envTargetGroupId;
			console.log(
				`Using target group ID from environment: ${this.targetGroupId}`,
			);
		} else if (envTargetGroupName) {
			// If only TARGET_GROUP_NAME is provided, use it for searching
			this.targetGroupName = envTargetGroupName;
			console.log(
				`Will search for target group by name: "${this.targetGroupName}"`,
			);
		} else {
			// Use default value if nothing is configured in .env
			console.log(`Using default target group name: "${this.targetGroupName}"`);
		}
	}

	private ensureSessionDir(): void {
		if (!fs.existsSync(this.sessionDir)) {
			fs.mkdirSync(this.sessionDir, { recursive: true });
		}
	}

	/**
	 * Check if a string contains another string as a whole word (word boundary matching)
	 * Works with Unicode characters including Hebrew
	 */
	private containsWholeWord(text: string, searchWord: string): boolean {
		// Normalize the search word (trim and lowercase for comparison)
		const normalizedSearchWord = searchWord.trim().toLowerCase();
		if (!normalizedSearchWord) return false;

		// Split text by word boundaries (spaces, punctuation, etc.)
		// This regex matches Unicode word characters and splits on non-word characters
		// For Hebrew and other Unicode, we'll split on spaces and common separators
		const words = text
			.split(/[\s\-–—,.;:!?()[\]{}'"`~@#$%^&*+=|\\<>\/]+/)
			.filter((word) => word.length > 0);

		// Check if any word exactly matches the search word (case-insensitive)
		return words.some((word) => word.toLowerCase() === normalizedSearchWord);
	}

	/**
	 * Check if a group should have its metadata cached
	 * We cache metadata for:
	 * 1. The target group (always) - needed to send messages
	 * 2. Groups in the allowed list (if ALLOWED_CHAT_NAMES is set)
	 * 3. All groups (if no allowed list is specified)
	 */
	private shouldCacheGroupMetadata(
		groupSubject: string | null,
		groupId: string,
	): boolean {
		// Always cache the target group
		if (groupId === this.targetGroupId) {
			return true;
		}

		// If no allowed list is specified, cache all groups (backward compatibility)
		if (this.allowedChatNames.length === 0) {
			return true;
		}

		// Only cache groups that are in the allowed list
		if (!groupSubject) {
			return false;
		}

		return this.allowedChatNames.some((name) =>
			this.containsWholeWord(groupSubject, name),
		);
	}

	private async createSocket(): Promise<void> {
		try {
			console.log("Creating WhatsApp socket...");

			// Initialize auth state
			const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);

			// Create the socket
			this.socket = makeWASocket({
				auth: state,
				browser: Browsers.ubuntu("WhatsApp Event Detection"),
				defaultQueryTimeoutMs: 60000,
				connectTimeoutMs: 60000,
				keepAliveIntervalMs: 10000,
				markOnlineOnConnect: false,
				syncFullHistory: false,
				fireInitQueries: true,
				generateHighQualityLinkPreview: false,
				cachedGroupMetadata: async (jid) => this.groupCache.get(jid),
				getMessage: async (_key: WAMessageKey) => {
					// Return undefined for now - could be enhanced with message store
					return undefined;
				},
			});

			this.setupEventListeners(saveCreds);
		} catch (error) {
			console.error("Error creating WhatsApp socket:", error);
			throw error;
		}
	}

	private setupEventListeners(saveCreds: () => void): void {
		if (!this.socket) return;

		// Handle connection updates
		this.socket.ev.on(
			"connection.update",
			async (update: BaileysEventMap["connection.update"]) => {
				const { connection, lastDisconnect, qr } = update;

				if (qr) {
					console.log(
						"QR Code received. Please scan with your WhatsApp mobile app.",
					);
					qrcode.generate(qr, { small: true });
				}

				if (connection === "close") {
					this.connectionState = "close";
					this.isReady = false;
					this.isSynced = false;

					const shouldReconnect =
						(lastDisconnect?.error as Boom)?.output?.statusCode !==
						DisconnectReason.loggedOut;
					console.log(
						"Connection closed due to:",
						lastDisconnect?.error,
						", reconnecting:",
						shouldReconnect,
					);

					if (
						shouldReconnect &&
						this.shouldReconnect &&
						this.reconnectAttempts < this.maxReconnectAttempts
					) {
						this.reconnectAttempts++;
						console.log(
							`Attempting to reconnect... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
						);

						// Wait before reconnecting
						await new Promise((resolve) => setTimeout(resolve, 5000));
						await this.createSocket();
					} else if (!shouldReconnect) {
						console.log(
							"Logged out. Please restart the application and scan QR code again.",
						);
					} else {
						console.log(
							"Max reconnection attempts reached. Please restart the application.",
						);
					}
				} else if (connection === "open") {
					this.connectionState = "open";
					this.reconnectAttempts = 0;
					console.log("WhatsApp connection opened successfully!");

					// Perform full synchronization before marking as ready
					try {
						console.log("Starting full synchronization...");
						await this.performFullSync();
						this.isSynced = true;
						this.isReady = true;
						console.log("Full synchronization completed successfully!");
					} catch (error) {
						console.error("Error during synchronization:", error);
						// Still mark as ready but log the error
						this.isReady = true;
						this.isSynced = false;
					}
				} else if (connection === "connecting") {
					this.connectionState = "connecting";
					console.log("Connecting to WhatsApp...");
				}
			},
		);

		// Handle credential updates
		this.socket.ev.on("creds.update", saveCreds);

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
						await this.handleIncomingMessage(message);
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
					if (update.subject && !this.targetGroupId && update.id) {
						if (update.subject === this.targetGroupName) {
							this.targetGroupId = update.id;
							console.log(
								`Found target group "${this.targetGroupName}" with ID: ${this.targetGroupId}`,
							);
						}
					}

					// Only update group metadata cache for allowed groups to avoid rate limits
					if (
						!this.shouldCacheGroupMetadata(update.subject || null, update.id)
					) {
						continue;
					}

					try {
						if (!this.socket) return;
						const metadata = await this.socket.groupMetadata(update.id);
						this.groupCache.set(update.id, metadata);
						console.log(
							`Updated group metadata cache for: ${metadata.subject || update.id}`,
						);
					} catch (error) {
						console.error(
							`Failed to update group metadata cache for ${update.id}:`,
							error,
						);
					}
				}
			},
		);

		// Handle group participants update
		this.socket.ev.on(
			"group-participants.update",
			async (event: BaileysEventMap["group-participants.update"]) => {
				// Only update group metadata cache for allowed groups to avoid rate limits
				// First check if we have cached metadata to get the subject
				let groupSubject: string | null = null;
				const cachedMetadata = this.groupCache.get(event.id) as
					| { subject?: string | null }
					| undefined;
				groupSubject = cachedMetadata?.subject ?? null;

				if (!this.shouldCacheGroupMetadata(groupSubject, event.id)) {
					return;
				}

				// Update group metadata cache when participants change
				try {
					if (!this.socket) return;
					const metadata = await this.socket.groupMetadata(event.id);
					this.groupCache.set(event.id, metadata);
					console.log(
						`Updated group metadata cache for participant change in: ${metadata.subject || event.id}`,
					);
				} catch (error) {
					console.error(
						`Failed to update group metadata cache for participant change in ${event.id}:`,
						error,
					);
				}
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
						chat.name === this.targetGroupName &&
						!this.targetGroupId
					) {
						this.targetGroupId = chat.id;
						console.log(
							`Found target group "${this.targetGroupName}" with ID: ${this.targetGroupId}`,
						);
					}
				}
			},
		);
	}

	private async handleIncomingMessage(message: WAMessage): Promise<void> {
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
			const isGroup = isJidGroup(chatId);
			const timestamp = new Date().toLocaleTimeString();

			let chatName = "";
			let contactName = "Unknown";

			// Get chat and contact information
			try {
				if (isGroup) {
					// First try to get from cache to avoid rate limits
					const cachedMetadata = this.groupCache.get(chatId) as
						| {
								subject?: string;
								participants?: Array<{ id: string; notify?: string }>;
						  }
						| undefined;

					let groupMetadata = cachedMetadata;

					// Fetch metadata if not cached (we need it to process the message)
					// But only cache it if it's an allowed group to avoid rate limits
					if (!groupMetadata && this.socket) {
						try {
							const fetchedMetadata = await this.socket.groupMetadata(chatId);
							const groupSubject = fetchedMetadata.subject || null;

							// Use the metadata for this message
							groupMetadata = fetchedMetadata;

							// Only cache if it's an allowed group (to avoid rate limits on updates)
							if (this.shouldCacheGroupMetadata(groupSubject, chatId)) {
								this.groupCache.set(chatId, fetchedMetadata);
							}
						} catch (error) {
							// If fetch fails (e.g., rate limit), use fallback
							console.warn(
								`Could not fetch metadata for group ${chatId}, using fallback:`,
								error,
							);
							groupMetadata = { subject: chatId.split("@")[0] };
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
							participant?.notify ||
							participant?.id?.split("@")[0] ||
							"Unknown";
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

			// Log the message
			console.log(`\n--------------------------------`);
			console.log(
				`[${timestamp}] ${isGroup ? `[${chatName}]` : ""} ${contactName}: ${messageText}`,
			);

			// Add message to history for this chat
			this.openaiService.addMessageToHistory(chatId, messageText);

			// Analyze the message for events
			console.log(`Analyzing message for events...`);

			const analysis = await this.openaiService.analyzeMessage(
				chatId,
				messageText,
				chatName,
				contactName,
			);

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
				if (this.targetGroupId) {
					const sourceChatInfo = isGroup
						? `Group: ${chatName}`
						: `Contact: ${contactName}`;

					const summaryMessage = `Event Summary:\n\n${analysis.summary}\n\nSource: ${sourceChatInfo}`;

					// Send unified message with summary and calendar attachment
					if (analysis.title && analysis.startDateISO) {
						await this.sendUnifiedEventMessage(
							this.targetGroupId,
							analysis,
							sourceChatInfo,
						);
					} else {
						// Fallback to text-only message if no complete event details
						await this.sendMessageToGroup(this.targetGroupId, summaryMessage);
					}
					console.log(
						`Single event message with ICS attachment sent to "${this.targetGroupName}" group`,
					);
				} else {
					console.log(
						`Target group "${this.targetGroupName}" not found. Event summary not sent.`,
					);
				}
			}
		} catch (error) {
			console.error("Error handling incoming message:", error);
		}
	}

	private async performFullSync(): Promise<void> {
		if (!this.socket) {
			throw new Error("Socket not available for synchronization");
		}

		console.log("Performing full synchronization...");

		// Step 1: Sync all groups and find target group
		await this.syncAllGroups();

		// Step 2: Sync all chats (this happens via events, but we wait a bit)
		await this.syncAllChats();

		// Step 3: Verify target group is accessible if configured
		if (this.targetGroupId) {
			try {
				const metadata = await this.socket.groupMetadata(this.targetGroupId);
				this.groupCache.set(this.targetGroupId, metadata);
				console.log(
					`✓ Target group verified: ${metadata.subject || this.targetGroupId}`,
				);
			} catch (error) {
				console.warn(
					`⚠ Could not verify target group ${this.targetGroupId}:`,
					error,
				);
			}
		} else {
			console.warn(
				`⚠ Target group "${this.targetGroupName}" not found. Make sure the bot is added to the group.`,
			);
		}

		console.log("Full synchronization completed");
	}

	private async syncAllGroups(): Promise<void> {
		if (!this.socket) return;

		try {
			console.log("Syncing all groups...");
			const groupsDict = await this.socket.groupFetchAllParticipating();

			// Convert dictionary to array
			const groups = Object.values(groupsDict);

			console.log(`✓ Found ${groups.length} groups`);

			// Cache group metadata only for allowed groups (to avoid rate limits)
			let cachedCount = 0;
			for (const group of groups) {
				if (this.shouldCacheGroupMetadata(group.subject || null, group.id)) {
					this.groupCache.set(group.id, group);
					cachedCount++;
				}
			}
			console.log(
				`✓ Cached metadata for ${cachedCount} groups (filtered by ALLOWED_CHAT_NAMES)`,
			);

			// If we don't have target group ID yet, search for it
			if (!this.targetGroupId) {
				const foundGroup = groups.find(
					(g) => g.subject === this.targetGroupName,
				);
				if (foundGroup) {
					this.targetGroupId = foundGroup.id;
					console.log(
						`✓ Found target group "${this.targetGroupName}" with ID: ${this.targetGroupId}`,
					);
				} else {
					console.log(
						`Target group "${this.targetGroupName}" not found in ${groups.length} groups.`,
					);
					if (groups.length > 0) {
						console.log(
							"Available groups:",
							groups.map((g) => g.subject || g.id).join(", "),
						);
					}
				}
			} else {
				// Verify the target group exists
				const targetGroup = groups.find((g) => g.id === this.targetGroupId);
				if (targetGroup) {
					console.log(
						`✓ Verified target group exists: ${targetGroup.subject || this.targetGroupId}`,
					);
					this.groupCache.set(this.targetGroupId, targetGroup);
				} else {
					console.warn(
						`⚠ Target group ID ${this.targetGroupId} not found in synced groups.`,
					);
				}
			}
		} catch (error) {
			console.error("Error syncing groups:", error);
			throw error;
		}
	}

	private async syncAllChats(): Promise<void> {
		if (!this.socket) return;

		try {
			console.log("Syncing all chats...");

			// Wait for chats to be loaded via events
			// Baileys will emit chats.upsert events with all chats
			// We'll wait a bit for the initial sync to complete
			await new Promise((resolve) => setTimeout(resolve, 2000));

			console.log("✓ Chats sync completed");
		} catch (error) {
			console.error("Error syncing chats:", error);
			// Don't throw - chats sync is less critical than groups
		}
	}

	private async sendMessageToGroup(
		groupId: string,
		message: string,
	): Promise<void> {
		if (!this.socket || !this.isReady) {
			console.error("WhatsApp socket not ready");
			return;
		}

		try {
			await this.socket.sendMessage(groupId, { text: message });
		} catch (error) {
			console.error("Error sending message to group:", error);
		}
	}

	private async sendUnifiedEventMessage(
		groupId: string,
		eventDetails: EventDetails,
		sourceChatInfo: string,
	): Promise<void> {
		if (!this.socket || !this.isReady) {
			console.error("WhatsApp socket not ready");
			return;
		}

		try {
			// Create comprehensive caption with all event details
			const caption = this.formatUnifiedEventCaption(
				eventDetails,
				sourceChatInfo,
			);

			// Create ICS calendar content
			const vCalendarContent = this.createEventVCalendar(eventDetails);
			const filename = `event_${Date.now()}.ics`;
			const buffer = Buffer.from(vCalendarContent, "utf-8");

			// Send single message with ICS file and comprehensive caption
			await this.socket.sendMessage(groupId, {
				document: buffer,
				fileName: filename,
				mimetype: "text/calendar",
				caption: caption,
			});

			console.log(`Single event message with ICS attachment sent to group`);
		} catch (error) {
			console.error("Error sending unified event message:", error);
			// Fallback to text-only message
			try {
				const fallbackMessage = `📅 Event Summary:\n\n${this.formatUnifiedEventMessage(eventDetails, sourceChatInfo)}`;
				await this.sendMessageToGroup(groupId, fallbackMessage);
			} catch (fallbackError) {
				console.error("Fallback message also failed:", fallbackError);
			}
		}
	}

	private formatUnifiedEventMessage(
		eventDetails: EventDetails,
		sourceChatInfo: string,
	): string {
		let message = `📅 **Event Summary**\n\n`;

		// Essential information only
		if (eventDetails.title) {
			message += `🎯 **${eventDetails.title}**\n`;
		}

		// Date and time on one line
		let dateTimeLine = "";
		if (eventDetails.date) {
			dateTimeLine += `📅 ${eventDetails.date}`;
		}
		if (eventDetails.time) {
			dateTimeLine += ` ${eventDetails.time}`;
		}
		if (dateTimeLine) {
			message += `${dateTimeLine}\n`;
		}

		// Location
		if (eventDetails.location) {
			message += `📍 ${eventDetails.location}\n`;
		}

		// Brief description (first line only, keep it short)
		if (eventDetails.description) {
			const firstLine = eventDetails.description.split("\n")[0];
			if (firstLine.length > 100) {
				message += `📝 ${firstLine.substring(0, 97)}...\n`;
			} else {
				message += `📝 ${firstLine}\n`;
			}
		}

		// Source information
		message += `\n💬 ${sourceChatInfo}`;

		return message;
	}

	private formatUnifiedEventCaption(
		eventDetails: EventDetails,
		sourceChatInfo: string,
	): string {
		let caption = `📅 *${eventDetails.title || "Event"}*\n`;

		// Date and time on same line if both exist
		if (eventDetails.date && eventDetails.time) {
			caption += `📅 ${eventDetails.date} | 🕐 ${eventDetails.time}\n`;
		} else if (eventDetails.date) {
			caption += `📅 ${eventDetails.date}\n`;
		} else if (eventDetails.time) {
			caption += `🕐 ${eventDetails.time}\n`;
		}

		// Location
		if (eventDetails.location) {
			caption += `📍 ${eventDetails.location}\n`;
		}

		// Brief description
		if (eventDetails.description) {
			const firstLine = eventDetails.description.split("\n")[0];
			if (firstLine.length > 150) {
				caption += `📝 ${firstLine.substring(0, 147)}...\n`;
			} else {
				caption += `📝 ${firstLine}\n`;
			}
		}

		// Source
		caption += `\n💬 ${sourceChatInfo}`;

		return caption;
	}

	private createEventVCalendar(eventDetails: EventDetails): string {
		const now = new Date();
		const dtstamp = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
		const uid = `event-${Date.now()}@whatsapp-bot`;

		let vcalendar = "BEGIN:VCALENDAR\n";
		vcalendar += "VERSION:2.0\n";
		vcalendar += "PRODID:-//WhatsApp Event Bot//EN\n";
		vcalendar += "BEGIN:VEVENT\n";
		vcalendar += `UID:${uid}\n`;
		vcalendar += `DTSTAMP:${dtstamp}\n`;

		if (eventDetails.startDateISO) {
			const startDate = new Date(eventDetails.startDateISO);
			const dtstart =
				startDate.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
			vcalendar += `DTSTART:${dtstart}\n`;
		}

		if (eventDetails.endDateISO) {
			const endDate = new Date(eventDetails.endDateISO);
			const dtend =
				endDate.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
			vcalendar += `DTEND:${dtend}\n`;
		}

		if (eventDetails.title) {
			vcalendar += `SUMMARY:${eventDetails.title.replace(/\n/g, "\\n")}\n`;
		}

		if (eventDetails.description) {
			vcalendar += `DESCRIPTION:${eventDetails.description.replace(/\n/g, "\\n")}\n`;
		}

		if (eventDetails.location) {
			vcalendar += `LOCATION:${eventDetails.location.replace(/\n/g, "\\n")}\n`;
		}

		vcalendar += "END:VEVENT\n";
		vcalendar += "END:VCALENDAR";

		return vcalendar;
	}

	public async initialize(): Promise<void> {
		try {
			console.log("Initializing WhatsApp client...");
			await this.createSocket();

			// Wait for connection to be established and synchronized
			let attempts = 0;
			const maxAttempts = 90; // 90 seconds timeout (increased to allow for sync)

			while ((!this.isReady || !this.isSynced) && attempts < maxAttempts) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
				attempts++;

				if (attempts % 10 === 0) {
					const status = this.isReady ? "syncing..." : "connecting...";
					console.log(`Waiting for WhatsApp ${status} (${attempts}s)`);
				}
			}

			if (!this.isReady) {
				throw new Error(
					"Failed to establish WhatsApp connection within timeout period",
				);
			}

			if (!this.isSynced) {
				console.warn(
					"Warning: Synchronization did not complete, but connection is ready. Continuing anyway...",
				);
			}

			console.log("WhatsApp client initialized and synchronized successfully!");
		} catch (error) {
			console.error("Error initializing WhatsApp client:", error);
			throw error;
		}
	}

	public startListeningForMessages(): void {
		if (!this.isReady) {
			console.error("WhatsApp client is not ready. Please initialize first.");
			return;
		}

		if (!this.isSynced) {
			console.warn(
				"Warning: Synchronization may not be complete. Starting to listen anyway...",
			);
		}

		console.log("Started listening for messages...");
		console.log(
			"The bot will now monitor all conversations for event-related discussions.",
		);
		if (this.targetGroupId) {
			console.log(
				`Event summaries will be sent to the "${this.targetGroupName}" group when detected.`,
			);
		} else {
			console.log(
				`⚠ Target group "${this.targetGroupName}" not found. Event summaries will not be sent until the group is found.`,
			);
		}
	}

	public async disconnect(): Promise<void> {
		this.shouldReconnect = false;

		if (this.socket) {
			try {
				await this.socket.logout();
			} catch (error) {
				console.error("Error during logout:", error);
			}
		}

		this.isReady = false;
		this.socket = null;
		console.log("WhatsApp client disconnected.");
	}

	public isConnected(): boolean {
		return this.isReady && this.connectionState === "open";
	}

	public getConnectionState(): string {
		return this.connectionState;
	}
}
