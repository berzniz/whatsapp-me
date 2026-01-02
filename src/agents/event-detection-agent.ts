import { Agent, run } from "@openai/agents";
import type { Session } from "@openai/agents";
import type { EventDetails } from "./types.js";
import type { WhatsAppAdapter } from "./whatsapp-adapter.js";
import type { EventDeduplicationService } from "../event-deduplication.js";
import type { WhatsAppConfig } from "../whatsapp-client/config.js";

/**
 * Agent specialized in detecting events from WhatsApp messages
 */
export class EventDetectionAgent {
	private agent: Agent;
	private whatsappAdapter: WhatsAppAdapter | null;
	private eventDeduplicationService: EventDeduplicationService | null;
	private config: WhatsAppConfig | null;

	constructor(
		whatsappAdapter?: WhatsAppAdapter,
		eventDeduplicationService?: EventDeduplicationService,
		config?: WhatsAppConfig,
	) {
		this.whatsappAdapter = whatsappAdapter || null;
		this.eventDeduplicationService = eventDeduplicationService || null;
		this.config = config || null;

		this.agent = new Agent({
			name: "Event Detection Agent",
			instructions: `You are a helpful assistant that analyzes WhatsApp messages to detect events and extract structured details. For Hebrew content, provide Hebrew output for summary, title, and location. You are also skilled at converting dates and times to ISO format.

Analyze WhatsApp messages for event information. Look for actual events (meetings, parties, gatherings) with date references like day names (יום ראשון, Monday, etc.) or specific dates.

EVENT CRITERIA:
- Must be an actual planned event, not just time-finding discussions
- Must have some date reference (day name, date, "tomorrow", etc.)
- Include location if mentioned

REQUIRED OUTPUT:
Extract concise event details in JSON format. Keep summaries brief and actionable.

Always respond with a valid JSON object in this exact format:
{
  "isEvent": true/false,
  "summary": "Brief 1-2 sentence summary in Hebrew if content is Hebrew-related",
  "title": "Short event title (Hebrew preferred for Hebrew content)",
  "date": "Date (e.g., 'יום שני', 'Monday', 'Tomorrow', '12/25')",
  "time": "Time (e.g., '15:00', '3 PM', 'בשעה 18:00')",
  "location": "Location (Hebrew preferred if applicable)",
  "description": "Brief description without original message repetition",
  "startDateISO": "ISO format (assume Israel timezone, default 8:00 AM if no time)",
  "endDateISO": "ISO format (1 hour after start by default)"
}

Current date context: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
If no year specified, use current year: ${new Date().getFullYear()}
If no time specified, use 08:00 AM`,
		});
	}

	/**
	 * Process a message and detect events
	 * If an event is detected and configured, automatically sends it to the target group
	 */
	public async processMessage(
		message: string,
		session: Session,
		context?: {
			history?: string[];
			sender?: string;
			chatId?: string;
			chatName?: string;
			isGroup?: boolean;
		},
	): Promise<EventDetails> {
		try {
			// Build the prompt with context
			let prompt = message;
			if (context?.history && context.history.length > 0) {
				const historyText = context.history
					.map((msg, i) => `[${i + 1}] ${msg}`)
					.join("\n");
				prompt = `Previous context:\n${historyText}\n\nCurrent message: ${message}`;
			}
			if (context?.sender) {
				prompt += `\nSender: ${context.sender}`;
			}

			// Run the agent with the session
			const result = await run(this.agent, prompt, {
				session,
			});

			// Extract the response text
			const responseText = result.finalOutput?.toString() || "";

			if (!responseText) {
				return this.getEmptyEventDetails();
			}

			// Try to parse JSON from the response
			let eventDetails: EventDetails;
			try {
				// Extract JSON from the response (might be wrapped in markdown code blocks)
				let jsonText = responseText.trim();
				const jsonMatch = jsonText.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
				if (jsonMatch) {
					jsonText = jsonMatch[1];
				}

				const parsed = JSON.parse(jsonText);

				// Prepare description with original message if needed
				let description = parsed.description || null;
				if (parsed.isEvent === true && description && !description.includes(message)) {
					const senderInfo = context?.sender ? `Sender: ${context.sender}` : "";
					description = `${description}\n\nOriginal message: ${message}${senderInfo ? "\n" + senderInfo : ""}`;
				}

				eventDetails = {
					isEvent: parsed.isEvent === true,
					summary: parsed.summary || null,
					title: parsed.title || null,
					date: parsed.date || null,
					time: parsed.time || null,
					location: parsed.location || null,
					description: description,
					startDateISO: parsed.startDateISO || null,
					endDateISO: parsed.endDateISO || null,
				};
			} catch (parseError) {
				console.error("Error parsing agent response as JSON:", parseError);
				console.log("Raw response:", responseText);

				// Fallback parsing
				const isEvent =
					responseText.includes('"isEvent": true') ||
					responseText.includes('"isEvent":true');
				const summaryMatch = responseText.match(/"summary":\s*"([^"]*)"/);

				eventDetails = {
					isEvent,
					summary: summaryMatch ? summaryMatch[1] : null,
					title: null,
					date: null,
					time: null,
					location: null,
					description: null,
					startDateISO: null,
					endDateISO: null,
				};
			}

			// If event detected, handle sending to target group
			if (eventDetails.isEvent && eventDetails.summary) {
				await this.handleEventDetected(eventDetails, context);
			}

			return eventDetails;
		} catch (error) {
			console.error("Error processing message with EventDetectionAgent:", error);
			return this.getEmptyEventDetails();
		}
	}

	/**
	 * Handle event detection - check deduplication and send to target group
	 */
	private async handleEventDetected(
		eventDetails: EventDetails,
		context?: {
			chatId?: string;
			chatName?: string;
			isGroup?: boolean;
		},
	): Promise<void> {
		// Check for duplicate events before processing
		if (this.eventDeduplicationService) {
			const eventHashData = {
				title: eventDetails.title,
				date: eventDetails.date,
				time: eventDetails.time,
				location: eventDetails.location,
			};

			const shouldProcess =
				this.eventDeduplicationService.shouldProcessEvent(eventHashData);

			if (!shouldProcess) {
				console.log("Event is duplicate, skipping notification");
				return; // Exit early for duplicate events
			}
		}

		// Send to target group if configured
		if (
			this.config?.targetGroupId &&
			this.whatsappAdapter &&
			eventDetails.title &&
			eventDetails.startDateISO
		) {
			const sourceChatInfo = context && context.isGroup
				? `Group: ${context.chatName || "Unknown"}`
				: `Contact: ${context?.chatName || "Unknown"}`;

			try {
				await this.whatsappAdapter.sendEventMessage(
					this.config.targetGroupId,
					eventDetails,
					sourceChatInfo,
				);
				console.log(
					`Event message sent to target group (ID: ${this.config.targetGroupId})`,
				);
			} catch (error) {
				console.error("Error sending event message:", error);
			}
		} else if (
			this.config?.targetGroupId &&
			this.whatsappAdapter &&
			eventDetails.summary
		) {
			// Fallback to text-only message if no complete event details
			const sourceChatInfo = context && context.isGroup
				? `Group: ${context.chatName || "Unknown"}`
				: `Contact: ${context?.chatName || "Unknown"}`;
			const summaryMessage = `Event Summary:\n\n${eventDetails.summary}\n\nSource: ${sourceChatInfo}`;

			try {
				await this.whatsappAdapter.sendMessageToGroup(
					this.config.targetGroupId,
					summaryMessage,
				);
				console.log(
					`Event summary sent to target group (ID: ${this.config.targetGroupId})`,
				);
			} catch (error) {
				console.error("Error sending event summary:", error);
			}
		}
	}

	private getEmptyEventDetails(): EventDetails {
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
