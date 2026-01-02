import { Agent, run, type Tool } from "@openai/agents";
import type { Session } from "@openai/agents";
import type { WhatsAppAdapter } from "./whatsapp-adapter.js";
import type { GroupSummaryAgent } from "./group-summary-agent.js";

/**
 * Main agent for BOT_GROUP_NAME that handles all bot interactions
 * Uses a single agent with tools for group summary functionality
 */
export class BotGroupAgent {
	private mainAgent: Agent;
	private whatsappAdapter: WhatsAppAdapter | null;
	private groupSummaryAgent: GroupSummaryAgent | null;
	private groupSummaryTools: Tool[] = [];

	constructor(
		whatsappAdapter?: WhatsAppAdapter,
		_targetGroupId?: string | null, // Kept for API compatibility
		groupSummaryAgent?: GroupSummaryAgent | null,
	) {
		this.whatsappAdapter = whatsappAdapter || null;
		this.groupSummaryAgent = groupSummaryAgent || null;

		// Get tools from GroupSummaryAgent if available
		if (this.groupSummaryAgent) {
			const summaryAgent = this.groupSummaryAgent.getAgent();
			this.groupSummaryTools = summaryAgent.tools || [];
			console.log(
				`BotGroupAgent: Initialized with ${this.groupSummaryTools.length} group summary tools`,
			);
		} else {
			console.warn(
				`BotGroupAgent: GroupSummaryAgent not available, group summary features will be limited`,
			);
		}

		// Build instructions based on available tools
		const hasGroupTools = this.groupSummaryTools.length > 0;
		const groupInstructions = hasGroupTools
			? `
FOR GROUP SUMMARY QUESTIONS (messages about groups, "what was said", summaries):
- You have access to tools to read messages from WhatsApp groups
- ALWAYS use the read_group_messages tool when asked about a group's messages
- First call the tool to get the messages, then answer based on the results
- DO NOT say you don't have access - USE THE TOOLS!`
			: `
FOR GROUP SUMMARY QUESTIONS: Group summary tools are not available yet. Ask the user to try again later.`;

		// Create a single agent with tools that handles all requests
		this.mainAgent = new Agent({
			name: "Bot Group Agent",
			instructions: `You are a helpful WhatsApp bot assistant. You can handle different types of requests:

1. GENERAL CHAT: Answer questions, have conversations, provide helpful information
2. EVENT DETECTION: When asked to detect events, analyze for meetings, parties, gatherings with dates
${groupInstructions}

LANGUAGE: Always respond in the same language as the user's message (Hebrew if Hebrew, English if English).

Keep responses concise and helpful. Match the casual tone of WhatsApp chat.`,
			tools: this.groupSummaryTools,
		});
	}

	/**
	 * Update the agent with new tools (called when GroupSummaryAgent becomes available)
	 */
	public updateGroupSummaryAgent(groupSummaryAgent: GroupSummaryAgent): void {
		this.groupSummaryAgent = groupSummaryAgent;
		const summaryAgent = groupSummaryAgent.getAgent();
		this.groupSummaryTools = summaryAgent.tools || [];
		console.log(
			`BotGroupAgent: Updated with ${this.groupSummaryTools.length} group summary tools`,
		);

		// Recreate main agent with the new tools
		this.mainAgent = new Agent({
			name: "Bot Group Agent",
			instructions: `You are a helpful WhatsApp bot assistant. You can handle different types of requests:

1. GENERAL CHAT: Answer questions, have conversations, provide helpful information
2. EVENT DETECTION: When asked to detect events, analyze for meetings, parties, gatherings with dates
3. GROUP SUMMARY: When asked about WhatsApp group messages, use the available tools

FOR GROUP SUMMARY QUESTIONS (messages about groups, "what was said", summaries):
- You have access to tools to read messages from WhatsApp groups
- ALWAYS use the read_group_messages tool when asked about a group's messages
- First call the tool to get the messages, then answer based on the results
- DO NOT say you don't have access - USE THE TOOLS!

LANGUAGE: Always respond in the same language as the user's message (Hebrew if Hebrew, English if English).

Keep responses concise and helpful. Match the casual tone of WhatsApp chat.`,
			tools: this.groupSummaryTools,
		});
	}

	/**
	 * Process a message and get a response
	 * The agent uses tools directly instead of handoffs for reliability
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
			console.log(
				`BotGroupAgent has ${this.groupSummaryTools.length} tools available`,
			);

			// Run the main agent with the session
			// maxTurns needs to be high enough for: tool call + tool result + response
			const result = await run(this.mainAgent, message, {
				session,
				maxTurns: 10, // Allow enough turns for tool calls
			});

			// Log result summary
			const state = result.state as unknown as Record<string, unknown>;
			console.log(`BotGroupAgent completed:`, {
				turns: state?.currentTurn,
				agent: (state?.currentAgent as { name?: string })?.name,
				hasOutput: !!result.finalOutput,
			});

			// Extract the response text
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
