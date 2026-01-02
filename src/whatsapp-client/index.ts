import { OpenAIService } from "../openai-service.js";
import { EventDeduplicationService } from "../event-deduplication.js";
import { WhatsAppConfig } from "./config.js";
import { GroupManager } from "./group-manager.js";
import { ConnectionManager } from "./connection-manager.js";
import { EventHandler } from "./event-handler.js";
import { MessageHandler } from "./message-handler.js";
import { MessageSender } from "./message-sender.js";
import { SyncService } from "./sync-service.js";
import { WhatsAppAdapterImpl } from "../agents/whatsapp-adapter-impl.js";
import { MessageStore } from "../message-store.js";
import type { WASocketType } from "./types.js";

export class WhatsAppClient {
	private config: WhatsAppConfig;
	private connectionManager: ConnectionManager;
	private groupManager: GroupManager;
	private messageSender: MessageSender;
	private syncService: SyncService;
	private eventHandler: EventHandler;
	private messageHandler: MessageHandler;
	private openaiService: OpenAIService;
	private eventDeduplicationService: EventDeduplicationService;
	private messageStore: MessageStore;

	constructor() {
		this.config = new WhatsAppConfig();
		this.eventDeduplicationService = new EventDeduplicationService();
		this.groupManager = new GroupManager(this.config);
		this.messageSender = new MessageSender();

		// Create message store (loads messages from disk on initialization)
		this.messageStore = new MessageStore();
		console.log(
			`Message store initialized with ${this.messageStore.getTotalMessageCount()} total messages`,
		);

		// Create WhatsApp adapter for agents
		const whatsappAdapter = new WhatsAppAdapterImpl(this.messageSender);

		// Initialize OpenAI service with shared config, adapter, deduplication service, socket, groupManager, and messageStore
		// Using shared config ensures botGroupId updates are reflected
		// Socket and groupManager are needed for GroupSummaryAgent to fetch message history
		// MessageStore provides persistent message storage
		this.openaiService = new OpenAIService(
			this.config,
			whatsappAdapter,
			this.eventDeduplicationService,
			null, // Socket will be set later via setSocket
			this.groupManager,
			this.messageStore,
		);

		this.connectionManager = new ConnectionManager(this.config);
		this.syncService = new SyncService(null, this.groupManager, this.config);
		this.messageHandler = new MessageHandler(
			null,
			this.openaiService,
			this.eventDeduplicationService,
			this.groupManager,
			this.messageSender,
			this.config,
			this.messageStore,
		);
		this.eventHandler = new EventHandler(
			null,
			this.groupManager,
			this.messageHandler,
			this.config,
		);

		// Setup connection handlers
		this.connectionManager.setConnectionOpenHandler(async () => {
			await this.syncService.performFullSync();
			// Update readiness state after sync completes
			this.messageSender.setReady(true);
		});

		this.connectionManager.setConnectionCloseHandler(async () => {
			// Mark as not ready when connection closes
			this.messageSender.setReady(false);
			await this.connectionManager.createSocket((jid) =>
				this.groupManager.getCachedMetadata(jid),
			);
			const newSocket = this.connectionManager.getSocket();
			if (newSocket) {
				this.updateSocketReferences(newSocket);
				this.eventHandler.setupEventListeners();
			}
		});
	}

	private updateSocketReferences(socket: WASocketType): void {
		this.syncService.setSocket(socket);
		this.messageHandler.setSocket(socket);
		this.eventHandler.setSocket(socket);
		this.messageSender.setSocket(socket);
		this.openaiService.setSocket(socket); // Update socket for message history fetcher
		// Don't set ready here - it will be set when connection actually opens
		// via the connectionOpenHandler
	}

	public async initialize(): Promise<void> {
		try {
			console.log("Initializing WhatsApp client...");
			const socket = await this.connectionManager.createSocket((jid) =>
				this.groupManager.getCachedMetadata(jid),
			);
			this.updateSocketReferences(socket);
			this.eventHandler.setupEventListeners();

			// Wait for connection to be established and synchronized
			let attempts = 0;
			const maxAttempts = 90; // 90 seconds timeout (increased to allow for sync)

			while (attempts < maxAttempts) {
				const state = this.connectionManager.getState();
				if (state.isReady && state.isSynced) {
					break;
				}

				await new Promise((resolve) => setTimeout(resolve, 1000));
				attempts++;

				if (attempts % 10 === 0) {
					const status = state.isReady ? "syncing..." : "connecting...";
					console.log(`Waiting for WhatsApp ${status} (${attempts}s)`);
				}
			}

			const finalState = this.connectionManager.getState();
			if (!finalState.isReady) {
				throw new Error(
					"Failed to establish WhatsApp connection within timeout period",
				);
			}

			if (!finalState.isSynced) {
				console.warn(
					"Warning: Synchronization did not complete, but connection is ready. Continuing anyway...",
				);
			}

			// Ensure MessageSender is marked as ready after initialization
			this.messageSender.setReady(finalState.isReady);

			console.log("WhatsApp client initialized and synchronized successfully!");
		} catch (error) {
			console.error("Error initializing WhatsApp client:", error);
			throw error;
		}
	}

	public startListeningForMessages(): void {
		const state = this.connectionManager.getState();
		if (!state.isReady) {
			console.error("WhatsApp client is not ready. Please initialize first.");
			return;
		}

		if (!state.isSynced) {
			console.warn(
				"Warning: Synchronization may not be complete. Starting to listen anyway...",
			);
		}

		console.log("Started listening for messages...");
		console.log(
			"The bot will now monitor all conversations for event-related discussions.",
		);
		if (this.config.targetGroupId) {
			console.log(
				`Event summaries will be sent to the target group (ID: ${this.config.targetGroupId}) when detected.`,
			);
		} else if (this.config.targetGroupName) {
			console.log(
				`Will search for target group "${this.config.targetGroupName}". Event summaries will be sent once the group is found.`,
			);
		} else {
			console.log(
				`⚠ Target group not configured. Event summaries will not be sent. Please set TARGET_GROUP_ID or TARGET_GROUP_NAME in your .env file.`,
			);
		}
		if (this.config.botGroupId) {
			console.log(
				`Bot group "${this.config.botGroupName}" is active. The bot will respond to messages in this group.`,
			);
		} else if (this.config.botGroupName) {
			console.log(
				`⚠ Bot group "${this.config.botGroupName}" not found. Bot responses will not be sent until the group is found.`,
			);
		}
	}

	public async disconnect(): Promise<void> {
		await this.connectionManager.disconnect();
	}

	public isConnected(): boolean {
		const state = this.connectionManager.getState();
		return state.isReady && state.connectionState === "open";
	}

	public getConnectionState(): string {
		return this.connectionManager.getState().connectionState;
	}
}
