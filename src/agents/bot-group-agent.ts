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

		// Use the GroupSummaryAgent's agent instance if available, otherwise create a simple one
		const groupSummarySubAgent = this.groupSummaryAgent
			? this.groupSummaryAgent.getAgent()
			: new Agent({
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
			instructions: `You are a router that delegates messages to specialized sub-agents. Your ONLY job is to identify which sub-agent should handle the message and hand off to them. DO NOT respond to the user yourself - let the sub-agent respond.

ROUTING RULES:
1. For questions about WhatsApp groups, summarizing messages, reading messages, "who said what", "how many messages", or any group-related queries:
   → Hand off to "Group Summary Sub-Agent" and STOP. Do not respond yourself.

2. For event-related queries (detecting events, extracting event details, calendar information, meetings, dates):
   → Hand off to "Event Detection Sub-Agent" and STOP. Do not respond yourself.

3. For general conversation, questions, and chat:
   → Hand off to "Chat Sub-Agent" and STOP. Do not respond yourself.

CRITICAL: After handing off, DO NOT generate your own response. The sub-agent will handle everything. Your handoff IS your complete action - do not add commentary, do not explain, do not respond.`,
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
				console.log(
					`BotGroupAgent result structure:`,
					resultStr.substring(0, 1000),
				);
			} catch (e) {
				console.log(`BotGroupAgent result (cannot stringify):`, result);
			}
			console.log(`BotGroupAgent result keys:`, Object.keys(result));
			console.log(`BotGroupAgent finalOutput:`, result.finalOutput);
			console.log(`BotGroupAgent finalOutput type:`, typeof result.finalOutput);

			// Log state information if available
			if (result.state) {
				const state = result.state as unknown as Record<string, unknown>;
				console.log(`BotGroupAgent state.currentAgent:`, state.currentAgent);
				console.log(`BotGroupAgent state.currentTurn:`, state.currentTurn);
				if (state.modelResponses) {
					console.log(
						`BotGroupAgent state.modelResponses count:`,
						Array.isArray(state.modelResponses)
							? state.modelResponses.length
							: "not an array",
					);
				}
			}

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
