import dotenv from "dotenv";
import { MessageRouterService } from "./agents/message-router.js";
import { WhatsAppConfig } from "./whatsapp-client/config.js";
import type { AgentContext } from "./agents/types.js";
import type { WhatsAppAdapter } from "./agents/whatsapp-adapter.js";
import type { EventDeduplicationService } from "./event-deduplication.js";
import type { WASocketType } from "./whatsapp-client/types.js";
import type { GroupManager } from "./whatsapp-client/group-manager.js";
import type { MessageStore } from "./message-store.js";

// Load environment variables
dotenv.config();

export interface EventDetails {
	isEvent: boolean;
	summary: string | null;
	title: string | null;
	date: string | null;
	time: string | null;
	location: string | null;
	description: string | null;
	startDateISO: string | null;
	endDateISO: string | null;
}

export class OpenAIService {
	private router: MessageRouterService;
	private config: WhatsAppConfig;
	private messageHistory: Map<string, string[]> = new Map();
	private readonly MAX_HISTORY_LENGTH = 5;

	constructor(
		config: WhatsAppConfig,
		whatsappAdapter?: WhatsAppAdapter,
		eventDeduplicationService?: EventDeduplicationService,
		socket?: WASocketType | null,
		groupManager?: GroupManager,
		messageStore?: MessageStore | null,
	) {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			throw new Error("OPENAI_API_KEY is not defined in .env file");
		}

		// Use the shared config (so botGroupId updates are reflected)
		this.config = config;
		this.router = new MessageRouterService(
			this.config,
			whatsappAdapter,
			eventDeduplicationService,
			socket,
			groupManager,
			this, // Pass self so MessageHistoryFetcher can access stored message history
			messageStore || null,
		);
	}

	/**
	 * Update socket reference (needed when connection is established)
	 * Also passes additional params for late initialization of GroupSummaryAgent
	 */
	public setSocket(
		socket: WASocketType | null,
		groupManager?: GroupManager,
		messageStore?: MessageStore | null,
		whatsappAdapter?: WhatsAppAdapter,
	): void {
		this.router.setSocket(
			socket,
			groupManager,
			this, // Pass self as OpenAIService
			messageStore || null,
			whatsappAdapter,
		);
	}

	/**
	 * Add a message to the history for a specific chat
	 */
	public addMessageToHistory(chatId: string, message: string): void {
		if (!this.messageHistory.has(chatId)) {
			this.messageHistory.set(chatId, []);
		}

		const history = this.messageHistory.get(chatId);
		if (history) {
			history.push(message);

			// Keep only the last MAX_HISTORY_LENGTH messages
			if (history.length > this.MAX_HISTORY_LENGTH) {
				this.messageHistory.set(
					chatId,
					history.slice(-this.MAX_HISTORY_LENGTH),
				);
			}
		}
	}

	/**
	 * Get the message history for a specific chat
	 */
	public getMessageHistory(chatId: string): string[] {
		return this.messageHistory.get(chatId) || [];
	}

	/**
	 * Analyze a message to detect if it contains an event
	 */
	public async analyzeMessage(
		chatId: string,
		message: string,
		chatName: string,
		sender?: string,
	): Promise<EventDetails> {
		try {
			// Get the message history for context
			const history = this.getMessageHistory(chatId);

			// Create agent context
			const context: AgentContext = {
				chatId,
				chatName,
				sender,
				messageHistory: history,
			};

			// Route message through agent system
			const result = await this.router.routeMessage(context, message);

			// Handle result based on type
			if (result === null) {
				// Not allowed or no response
				return {
					isEvent: false,
					summary: null,
					title: null,
					date: null,
					time: null,
					location: null,
					description: null,
					startDateISO: null,
					endDateISO: null,
				};
			}

			if (typeof result === "string") {
				// Got a chat response instead of event details (shouldn't happen for analyzeMessage)
				console.warn("Received chat response instead of event details");
				return {
					isEvent: false,
					summary: null,
					title: null,
					date: null,
					time: null,
					location: null,
					description: null,
					startDateISO: null,
					endDateISO: null,
				};
			}

			// Got event details
			const eventDetails = result as EventDetails;

			// Log the analysis result for debugging
			if (eventDetails.isEvent) {
				console.log(
					`Analysis result: Event detected - ${eventDetails.title || "Untitled"}`,
				);
			} else {
				console.log(`Analysis result: No event detected`);
			}

			return eventDetails;
		} catch (error: unknown) {
			console.error("Error analyzing message with OpenAI:", error);

			// Provide more detailed error information
			if (error && typeof error === "object") {
				if ("status" in error) {
					console.error(`OpenAI API returned status: ${error.status}`);
				}
				if ("code" in error) {
					console.error(`OpenAI API error code: ${error.code}`);
				}
				if ("message" in error && typeof error.message === "string") {
					console.error(`Error message: ${error.message}`);
				}
			}

			return {
				isEvent: false,
				summary: null,
				title: null,
				date: null,
				time: null,
				location: null,
				description: null,
				startDateISO: null,
				endDateISO: null,
			};
		}
	}

	/**
	 * Get a general chat response from OpenAI (not event detection)
	 */
	public async getChatResponse(
		chatId: string,
		message: string,
		chatName?: string,
	): Promise<string | null> {
		try {
			// Get the message history for context
			const history = this.getMessageHistory(chatId);

			// Create agent context
			const context: AgentContext = {
				chatId,
				chatName: chatName || chatId, // Use provided chatName or chatId as fallback
				messageHistory: history,
			};

			// Route message through agent system
			const result = await this.router.routeMessage(context, message);

			// Handle result based on type
			if (result === null) {
				return null;
			}

			if (typeof result === "string") {
				// Got a chat response
				return result;
			}

			// Got event details instead of chat response (shouldn't happen for getChatResponse)
			console.warn("Received event details instead of chat response");
			return null;
		} catch (error: unknown) {
			console.error("Error getting chat response from OpenAI:", error);
			return null;
		}
	}
}
