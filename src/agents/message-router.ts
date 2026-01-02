import type { WhatsAppConfig } from "../whatsapp-client/config.js";
import { SessionManager } from "./session-manager.js";
import { BotGroupAgent } from "./bot-group-agent.js";
import { EventDetectionAgent } from "./event-detection-agent.js";
import { ChatAgent } from "./chat-agent.js";
import type { EventDetails, AgentContext } from "./types.js";
import type { WhatsAppAdapter } from "./whatsapp-adapter.js";
import type { EventDeduplicationService } from "../event-deduplication.js";
import type { Session } from "@openai/agents";

/**
 * Routes messages to appropriate agents based on chat name/ID
 */
export class MessageRouterService {
	private sessionManager: SessionManager;
	private botGroupAgent: BotGroupAgent;
	private eventDetectionAgent: EventDetectionAgent;
	private _chatAgent: ChatAgent; // Kept for potential future use
	private config: WhatsAppConfig;

	constructor(
		config: WhatsAppConfig,
		whatsappAdapter?: WhatsAppAdapter,
		eventDeduplicationService?: EventDeduplicationService,
	) {
		this.config = config;
		this.sessionManager = new SessionManager();

		// Initialize agents with dependencies
		this._chatAgent = new ChatAgent(whatsappAdapter, config.targetGroupId);
		this.eventDetectionAgent = new EventDetectionAgent(
			whatsappAdapter,
			eventDeduplicationService,
			config,
		);
		this.botGroupAgent = new BotGroupAgent(
			whatsappAdapter,
			config.botGroupId || null,
		);
	}

	/**
	 * Check if a string contains another string as a whole word (word boundary matching)
	 * Works with Unicode characters including Hebrew
	 */
	private containsWholeWord(text: string, searchWord: string): boolean {
		const normalizedSearchWord = searchWord.trim().toLowerCase();
		if (!normalizedSearchWord) return false;

		const words = text
			.split(/[\s\-–—,.;:!?()[\]{}'"`~@#$%^&*+=|\\<>\/]+/)
			.filter((word) => word.length > 0);

		return words.some((word) => word.toLowerCase() === normalizedSearchWord);
	}

	/**
	 * Check if a chat name is in the allowed list
	 */
	private isChatAllowed(chatName: string): boolean {
		if (this.config.allowedChatNames.length === 0) {
			return true; // If no names specified, allow all chats
		}
		return this.config.allowedChatNames.some((name) =>
			this.config.containsWholeWord(chatName, name),
		);
	}

	/**
	 * Route a message to the appropriate agent based on context
	 */
	public async routeMessage(
		context: AgentContext,
		message: string,
	): Promise<EventDetails | string | null> {
		const { chatId, chatName } = context;

		// Get session for this chat
		const session = this.sessionManager.getSession(chatId);

		// Route based on chat ID and name
		console.log(
			`Router checking: chatId="${chatId}", botGroupId="${this.config.botGroupId}", match=${chatId === this.config.botGroupId}`,
		);
		if (this.config.botGroupId && chatId === this.config.botGroupId) {
			// Bot group - use BotGroupAgent
			console.log(`Routing to BotGroupAgent for message: "${message}"`);
			const response = await this.botGroupAgent.processMessage(
				message,
				session,
				{
					chatId,
					sendResponse: true, // Auto-send response for bot group
				},
			);
			console.log(
				`BotGroupAgent returned response:`,
				response ? `"${response.substring(0, 50)}..."` : "null",
			);
			return response;
		} else if (this.isChatAllowed(chatName || chatId)) {
			// Allowed chat - use EventDetectionAgent
			console.log("Routing to EventDetectionAgent");
			const eventDetails = await this.eventDetectionAgent.processMessage(
				message,
				session,
				{
					history: context.messageHistory,
					sender: context.sender,
					chatId,
					chatName,
					isGroup: chatId.includes("@g.us"),
				},
			);
			return eventDetails;
		} else {
			// Not allowed - skip processing
			console.log(
				`Skipping message from chat "${chatName}" (ID: ${chatId}) - not in allowed list`,
			);
			return null;
		}
	}

	/**
	 * Get session manager (for backward compatibility)
	 */
	public getSessionManager(): SessionManager {
		return this.sessionManager;
	}
}
