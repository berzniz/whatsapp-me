import type { EventDetails } from "../openai-service.js";

/**
 * Context information passed to agents
 */
export interface AgentContext {
	chatId: string;
	chatName: string;
	sender?: string;
	messageHistory: string[];
}

/**
 * Response types from agents
 */
export type AgentResponse = EventDetailsResponse | ChatResponse;

export interface EventDetailsResponse {
	type: "event";
	data: EventDetails;
}

export interface ChatResponse {
	type: "chat";
	data: string;
}

/**
 * Re-export EventDetails for convenience
 */
export type { EventDetails };

