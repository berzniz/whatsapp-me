import { Agent, run } from "@openai/agents";
import type { Session } from "@openai/agents";
import type { WhatsAppAdapter } from "./whatsapp-adapter.js";
import type { GroupSummaryAgent } from "./group-summary-agent.js";

/**
 * Main agent for BOT_GROUP_NAME that delegates to sub-agents
 * Uses SDK handoffs mechanism to route to specialized agents
 */
export class BotGroupAgent {
	private routerAgent: Agent;
	private whatsappAdapter: WhatsAppAdapter | null;
	private targetGroupId: string | null;
	private groupSummaryAgent: GroupSummaryAgent | null;

	constructor(
		whatsappAdapter?: WhatsAppAdapter,
		targetGroupId?: string | null,
		groupSummaryAgent?: GroupSummaryAgent | null,
	) {
		this.whatsappAdapter = whatsappAdapter || null;
		this.targetGroupId = targetGroupId || null;
		this.groupSummaryAgent = groupSummaryAgent || null;

		// Create sub-agents for handoffs - these are the actual Agent instances
		const chatSubAgent = new Agent({
			name: "Chat Sub-Agent",
			instructions:
				"Handle general conversation and chat queries in a WhatsApp group. Provide helpful, concise responses. Match the language of the user's message.",
		});

		const eventSubAgent = new Agent({
			name: "Event Detection Sub-Agent",
			instructions: `Detect and extract event information from messages. Analyze WhatsApp messages for event information. Look for actual events (meetings, parties, gatherings) with date references.

Always respond with a valid JSON object in this exact format:
{
  "isEvent": true/false,
  "summary": "Brief summary",
  "title": "Event title",
  "date": "Date",
  "time": "Time",
  "location": "Location",
  "description": "Description",
  "startDateISO": "ISO format",
  "endDateISO": "ISO format"
}`,
		});

		const groupSummarySubAgent = new Agent({
			name: "Group Summary Sub-Agent",
			instructions: `Read and summarize messages from WhatsApp groups specified in ALLOWED_CHAT_NAMES. Answer questions about what was discussed in those groups, provide summaries of recent conversations, and identify key topics or decisions.

When asked about a group or to summarize messages:
- Use the provided message history to answer questions
- Provide concise summaries of recent conversations
- Answer specific questions about what was discussed
- Identify key topics, decisions, or important information

If asked about groups or to summarize messages from groups, use this agent.`,
		});

		// Create main router agent with handoffs
		const handoffs = [chatSubAgent, eventSubAgent];
		if (groupSummarySubAgent) {
			handoffs.push(groupSummarySubAgent);
		}

		this.routerAgent = new Agent({
			name: "Bot Group Agent",
			instructions: `You are a helpful assistant in a WhatsApp group chat. Your role is to analyze messages and delegate to specialized sub-agents:

1. For event-related queries (detecting events, extracting event details, calendar information, meetings, dates):
   - Hand off to the "Event Detection Sub-Agent"

2. For questions about other WhatsApp groups, summarizing group messages, or reading messages from groups:
   - Hand off to the "Group Summary Sub-Agent"

3. For general conversation, questions, and chat:
   - Hand off to the "Chat Sub-Agent"

Analyze the user's message and delegate to the appropriate sub-agent. If the message mentions events, meetings, dates, times, calendar, or scheduling, use Event Detection Sub-Agent. If the message asks about other groups, wants summaries, or asks to read messages from groups, use Group Summary Sub-Agent. Otherwise, use Chat Sub-Agent for general conversation.`,
			handoffs: handoffs,
		});
	}

	/**
	 * Process a message and get a response
	 * The agent will automatically hand off to appropriate sub-agents via SDK handoffs
	 * Optionally sends the response back to WhatsApp if adapter is configured
	 */
	public async processMessage(
		message: string,
		session: Session,
		context?: {
			chatId?: string;
			sendResponse?: boolean;
		},
	): Promise<string | null> {
		try {
			console.log(`BotGroupAgent processing message: "${message}"`);
			
			// Run the router agent with the session
			// The SDK will handle handoffs automatically based on the agent's instructions
			const result = await run(this.routerAgent, message, {
				session,
			});

			// Log the full result structure for debugging
			try {
				const resultStr = JSON.stringify(result, null, 2);
				console.log(`BotGroupAgent result structure:`, resultStr.substring(0, 500));
			} catch (e) {
				console.log(`BotGroupAgent result (cannot stringify):`, result);
			}
			console.log(`BotGroupAgent result keys:`, Object.keys(result));
			console.log(`BotGroupAgent finalOutput:`, result.finalOutput);
			console.log(`BotGroupAgent finalOutput type:`, typeof result.finalOutput);

			// Extract the response text - try different ways to access it
			let responseText = "";
			if (result.finalOutput) {
				if (typeof result.finalOutput === "string") {
					responseText = result.finalOutput;
				} else if (typeof result.finalOutput === "object") {
					const outputObj = result.finalOutput as Record<string, unknown>;
					if ("text" in outputObj) {
						responseText = String(outputObj.text);
					} else {
						responseText = String(result.finalOutput);
					}
				} else {
					responseText = String(result.finalOutput);
				}
			}
			
			const trimmedResponse = responseText.trim() || null;
			
			console.log(`BotGroupAgent extracted response:`, {
				responseText,
				trimmedResponse,
				length: trimmedResponse?.length || 0,
			});

			// Send response back if configured
			if (trimmedResponse && context?.sendResponse && context.chatId) {
				if (this.whatsappAdapter) {
					try {
						const responseWithEmoji = `🤖 ${trimmedResponse}`;
						await this.whatsappAdapter.sendMessageToGroup(
							context.chatId,
							responseWithEmoji,
						);
						console.log(
							`✓ Sent bot response to group ${context.chatId}: ${trimmedResponse.substring(0, 50)}...`,
						);
					} catch (error) {
						console.error("Error sending bot group response:", error);
						// Still return the response even if sending failed
					}
				} else {
					console.warn(
						`Bot response generated but WhatsApp adapter not configured. Response: ${trimmedResponse.substring(0, 50)}...`,
					);
				}
			}

			return trimmedResponse;
		} catch (error) {
			console.error("Error processing message with BotGroupAgent:", error);
			return null;
		}
	}
}
