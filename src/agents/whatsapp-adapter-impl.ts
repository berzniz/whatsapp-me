import type { WhatsAppAdapter } from "./whatsapp-adapter.js";
import type { EventDetails } from "../openai-service.js";
import type { MessageSender } from "../whatsapp-client/message-sender.js";

/**
 * Implementation of WhatsAppAdapter using MessageSender
 */
export class WhatsAppAdapterImpl implements WhatsAppAdapter {
	private messageSender: MessageSender;

	constructor(messageSender: MessageSender) {
		this.messageSender = messageSender;
	}

	async sendMessageToGroup(groupId: string, message: string): Promise<void> {
		await this.messageSender.sendMessageToGroup(groupId, message);
	}

	async sendEventMessage(
		groupId: string,
		eventDetails: EventDetails,
		sourceChatInfo: string,
	): Promise<void> {
		await this.messageSender.sendUnifiedEventMessage(
			groupId,
			eventDetails,
			sourceChatInfo,
		);
	}
}

