import makeWASocket, {
	DisconnectReason,
	useMultiFileAuthState,
	WAMessageKey,
	getContentType,
	isJidGroup,
	jidNormalizedUser,
	WAMessage,
	Browsers,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import * as fs from "fs";
import * as path from "path";
import * as qrcode from "qrcode-terminal";
import NodeCache from "node-cache";
import { OpenAIService, EventDetails } from "./openai-service";
import { EventDeduplicationService } from "./event-deduplication";

type WASocketType = ReturnType<typeof makeWASocket>;

export class WhatsAppClient {
	private socket: WASocketType | null = null;
	private isReady: boolean = false;
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

	constructor() {
		this.openaiService = new OpenAIService();
		this.eventDeduplicationService = new EventDeduplicationService();

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
				getMessage: async (key: WAMessageKey) => {
					// Return empty message for now - could be enhanced with message store
					return { conversation: "" } as any;
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
		this.socket.ev.on("connection.update", async (update: any) => {
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
				this.isReady = true;
				this.reconnectAttempts = 0;
				console.log("WhatsApp connection opened successfully!");

				// Find the target group when connection is established
				await this.findTargetGroup();
			} else if (connection === "connecting") {
				this.connectionState = "connecting";
				console.log("Connecting to WhatsApp...");
			}
		});

		// Handle credential updates
		this.socket.ev.on("creds.update", saveCreds);

		// Handle incoming messages
		this.socket.ev.on("messages.upsert", async (messageUpdate: any) => {
			const { messages, type } = messageUpdate;

			if (type !== "notify") return;

			for (const message of messages) {
				await this.handleIncomingMessage(message);
			}
		});

		// Handle group updates
		this.socket.ev.on("groups.update", async (updates: any[]) => {
			for (const update of updates) {
				// Update group metadata cache
				try {
					const metadata = await this.socket!.groupMetadata(update.id);
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

				if (update.subject && !this.targetGroupId) {
					// Check if this is our target group (only if not already configured from env)
					if (update.subject === this.targetGroupName) {
						this.targetGroupId = update.id;
						console.log(
							`Found target group "${this.targetGroupName}" with ID: ${this.targetGroupId}`,
						);
					}
				}
			}
		});

		// Handle group participants update
		this.socket.ev.on("group-participants.update", async (event: any) => {
			// Update group metadata cache when participants change
			try {
				const metadata = await this.socket!.groupMetadata(event.id);
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
		});

		// Handle chats update
		this.socket.ev.on("chats.upsert", async (chats: any[]) => {
			// Look for our target group in new chats (only if not already configured from env)
			for (const chat of chats) {
				if (
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
		});
	}

	private async handleIncomingMessage(message: WAMessage): Promise<void> {
		try {
			// Skip if message is from self or has no content
			if (message.key.fromMe || !message.message) return;

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

			const chatId = message.key.remoteJid!;
			const isGroup = isJidGroup(chatId);
			const timestamp = new Date().toLocaleTimeString();

			let chatName = "";
			let contactName = "Unknown";

			// Get chat and contact information
			try {
				if (isGroup) {
					const groupMetadata = await this.socket!.groupMetadata(chatId);
					chatName = groupMetadata.subject || "Unknown Group";

					// Find the participant who sent the message
					const participant = groupMetadata.participants.find(
						(p: any) =>
							jidNormalizedUser(p.id) ===
							jidNormalizedUser(message.key.participant || ""),
					);
					contactName =
						participant?.notify || participant?.id?.split("@")[0] || "Unknown";
				} else {
					chatName = chatId.split("@")[0];
					contactName = chatName;
				}
			} catch (error) {
				console.error("Error getting chat/contact info:", error);
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
						`Event notification sent to "${this.targetGroupName}" group`,
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

	private async findTargetGroup(): Promise<void> {
		if (!this.socket || !this.isReady) return;

		try {
			// If we already have the target group ID from environment variables, no need to search
			if (this.targetGroupId) {
				console.log(
					`Target group ID already configured: ${this.targetGroupId}`,
				);
				return;
			}

			console.log(`Looking for target group: "${this.targetGroupName}"`);

			// We'll rely on the chats.upsert and groups.update events to find the group
			// This is more efficient than querying all groups

			// Set a timeout to log if group is not found
			setTimeout(() => {
				if (!this.targetGroupId) {
					console.log(
						`Target group "${this.targetGroupName}" not found yet. Make sure the bot is added to the group.`,
					);
				}
			}, 10000);
		} catch (error) {
			console.error("Error finding target group:", error);
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
			// Create concise event message
			const eventMessage = this.formatUnifiedEventMessage(
				eventDetails,
				sourceChatInfo,
			);

			// Create ICS calendar content
			const vCalendarContent = this.createEventVCalendar(eventDetails);
			const filename = `event_${Date.now()}.ics`;
			const buffer = Buffer.from(vCalendarContent, "utf-8");

			// Send message with attachment
			await this.socket.sendMessage(groupId, {
				text: eventMessage,
				document: buffer,
				fileName: filename,
				mimetype: "text/calendar",
			});

			console.log(`Unified event message with calendar attachment sent`);
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

	private async sendEventToGroup(
		groupId: string,
		eventDetails: EventDetails,
	): Promise<void> {
		if (!this.socket || !this.isReady) {
			console.error("WhatsApp socket not ready");
			return;
		}

		try {
			// Create a detailed event message
			const eventMessage = this.formatEventMessage(eventDetails);

			// Send the event details
			// Send as text message first
			await this.socket.sendMessage(groupId, { text: eventMessage });

			// Try to send as calendar event if we have complete details
			if (
				eventDetails.title &&
				eventDetails.startDateISO &&
				eventDetails.endDateISO
			) {
				try {
					const vCalendarContent = this.createEventVCalendar(eventDetails);
					const filename = `event_${Date.now()}.ics`;

					// Create a buffer from the VCalendar content
					const buffer = Buffer.from(vCalendarContent, "utf-8");

					// Send as document attachment
					await this.socket.sendMessage(groupId, {
						document: buffer,
						fileName: filename,
						mimetype: "text/calendar",
						caption: `📅 Calendar Event: ${eventDetails.title}`,
					});
				} catch (error) {
					console.error(
						"Failed to send calendar attachment, falling back to text:",
						error,
					);
					// Fallback to text format if attachment fails
					await this.socket.sendMessage(groupId, {
						text: `📅 Calendar Event fallback:\n\n${this.createEventVCalendar(eventDetails)}`,
					});
				}
			}

			// Send VCF calendar file if we have complete event details
			if (eventDetails.title && eventDetails.startDateISO) {
				const vCalendarContent = this.createEventVCalendar(eventDetails);
				const filename = `event_${Date.now()}.ics`;

				// For now, we'll send the calendar as text
				// In a full implementation, you could save to file and send as document
				await this.socket.sendMessage(groupId, {
					text: `📅 Calendar Event:\n\n${vCalendarContent}`,
				});
			}
		} catch (error) {
			console.error("Error sending event to group:", error);
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

	private formatEventMessage(eventDetails: EventDetails): string {
		let eventMessage = `📅 **Event Details:**\n\n`;

		if (eventDetails.title) {
			eventMessage += `**Title:** ${eventDetails.title}\n`;
		}

		if (eventDetails.date) {
			eventMessage += `**Date:** ${eventDetails.date}\n`;
		}

		if (eventDetails.time) {
			eventMessage += `**Time:** ${eventDetails.time}\n`;
		}

		if (eventDetails.location) {
			eventMessage += `**Location:** ${eventDetails.location}\n`;
		}

		if (eventDetails.description) {
			eventMessage += `**Description:** ${eventDetails.description}\n`;
		}

		if (eventDetails.startDateISO) {
			eventMessage += `**Start (ISO):** ${eventDetails.startDateISO}\n`;
		}

		if (eventDetails.endDateISO) {
			eventMessage += `**End (ISO):** ${eventDetails.endDateISO}\n`;
		}

		return eventMessage;
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

			// Wait for connection to be established
			let attempts = 0;
			const maxAttempts = 60; // 60 seconds timeout

			while (!this.isReady && attempts < maxAttempts) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
				attempts++;

				if (attempts % 10 === 0) {
					console.log(`Waiting for WhatsApp connection... (${attempts}s)`);
				}
			}

			if (!this.isReady) {
				throw new Error(
					"Failed to establish WhatsApp connection within timeout period",
				);
			}

			console.log("WhatsApp client initialized successfully!");
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

		console.log("Started listening for messages...");
		console.log(
			"The bot will now monitor all conversations for event-related discussions.",
		);
		console.log(
			`Event summaries will be sent to the "${this.targetGroupName}" group when detected.`,
		);
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
