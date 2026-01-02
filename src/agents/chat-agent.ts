import { Agent, run } from "@openai/agents";
import type { Session } from "@openai/agents";
import type { WhatsAppAdapter } from "./whatsapp-adapter.js";

/**
 * Agent specialized in general conversation
 */
export class ChatAgent {
	private agent: Agent;
	private whatsappAdapter: WhatsAppAdapter | null;
	private targetGroupId: string | null;

	constructor(
		whatsappAdapter?: WhatsAppAdapter,
		targetGroupId?: string | null,
	) {
		this.whatsappAdapter = whatsappAdapter || null;
		this.targetGroupId = targetGroupId || null;

		this.agent = new Agent({
			name: "Chat Agent",
			instructions: `You are a helpful assistant in a WhatsApp group chat. Provide helpful, concise responses. Match the language of the user's message.

Keep your responses:
- Concise and natural
- Helpful and relevant
- In the same language as the user's message (Hebrew if the message is in Hebrew, English if in English)
- Appropriate for a group chat context`,
		});
	}

	/**
	 * Process a message and get a chat response
	 * Optionally sends the response back to WhatsApp if adapter is configured
	 */
	public async processMessage(
		message: string,
		session: Session,
		context?: {
			history?: string[];
			chatId?: string;
			sendResponse?: boolean;
		},
	): Promise<string | null> {
		try {
			// Build the prompt with context
			let prompt = message;
			if (context?.history && context.history.length > 0) {
				const historyText = context.history
					.map((msg, i) => `[${i + 1}] ${msg}`)
					.join("\n");
				prompt = `Previous context:\n${historyText}\n\nCurrent message: ${message}`;
			}

			// Run the agent with the session
			const result = await run(this.agent, prompt, {
				session,
			});

			// Extract the response text
			const responseText = result.finalOutput?.toString() || "";
			const trimmedResponse = responseText.trim() || null;

			// Send response back if configured
			if (
				trimmedResponse &&
				context?.sendResponse &&
				context.chatId &&
				this.whatsappAdapter
			) {
				try {
					const responseWithEmoji = `🤖 ${trimmedResponse}`;
					await this.whatsappAdapter.sendMessageToGroup(
						context.chatId,
						responseWithEmoji,
					);
					console.log(`Sent bot response to group ${context.chatId}`);
				} catch (error) {
					console.error("Error sending chat response:", error);
				}
			}

			return trimmedResponse;
		} catch (error) {
			console.error("Error processing message with ChatAgent:", error);
			return null;
		}
	}
}
