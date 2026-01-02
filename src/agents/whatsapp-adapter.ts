import type { EventDetails } from "../openai-service.js";

/**
 * Interface for agents to send messages back to WhatsApp
 * This abstracts the WhatsApp implementation from the agents
 */
export interface WhatsAppAdapter {
	/**
	 * Send a text message to a group
	 */
	sendMessageToGroup(groupId: string, message: string): Promise<void>;

	/**
	 * Send an event message with calendar attachment to a group
	 */
	sendEventMessage(
		groupId: string,
		eventDetails: EventDetails,
		sourceChatInfo: string,
	): Promise<void>;
}

