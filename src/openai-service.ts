import OpenAI from "openai";
import dotenv from "dotenv";

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
	private openai: OpenAI;
	private messageHistory: Map<string, string[]> = new Map();
	private readonly MAX_HISTORY_LENGTH = 5;
	private readonly allowedChatNames: string[];

	constructor() {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			throw new Error("OPENAI_API_KEY is not defined in .env file");
		}

		// Configure timeout (30 seconds default, can be overridden via env var)
		const timeoutMs = parseInt(process.env.OPENAI_TIMEOUT_MS || "30000", 10);

		this.openai = new OpenAI({
			apiKey: apiKey,
			timeout: timeoutMs,
			maxRetries: 2, // Retry up to 2 times on failure
		});

		// Get allowed chat names from environment variable
		const allowedChatNamesStr = process.env.ALLOWED_CHAT_NAMES;
		this.allowedChatNames = allowedChatNamesStr
			? allowedChatNamesStr.split(",").map((name) => name.trim())
			: [];
	}

	/**
	 * Check if a string contains another string as a whole word (word boundary matching)
	 * Works with Unicode characters including Hebrew
	 */
	private containsWholeWord(text: string, searchWord: string): boolean {
		// Normalize the search word (trim and lowercase for comparison)
		const normalizedSearchWord = searchWord.trim().toLowerCase();
		if (!normalizedSearchWord) return false;

		// Split text by word boundaries (spaces, punctuation, etc.)
		// This regex matches Unicode word characters and splits on non-word characters
		// For Hebrew and other Unicode, we'll split on spaces and common separators
		const words = text
			.split(/[\s\-–—,.;:!?()[\]{}'"`~@#$%^&*+=|\\<>\/]+/)
			.filter((word) => word.length > 0);

		// Check if any word exactly matches the search word (case-insensitive)
		return words.some((word) => word.toLowerCase() === normalizedSearchWord);
	}

	/**
	 * Check if a chat name is in the allowed list
	 */
	private isChatAllowed(chatName: string): boolean {
		if (this.allowedChatNames.length === 0) {
			return true; // If no names specified, allow all chats
		}
		return this.allowedChatNames.some((name) =>
			this.containsWholeWord(chatName, name),
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
			// Check if the chat is allowed
			if (!this.isChatAllowed(chatName || chatId)) {
				console.log(
					`Skipping analysis for chat ID: "${chatId}" - chat name: "${chatName}" - not in allowed list`,
				);
				console.log(`Allowed list:`, JSON.stringify(this.allowedChatNames));
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

			// Get the message history for context
			const history = this.getMessageHistory(chatId);

			// Create the prompt for OpenAI - optimized for concise summaries
			const prompt = `
Analyze this WhatsApp message for event information. Look for actual events (meetings, parties, gatherings) with date references like day names (יום ראשון, Monday, etc.) or specific dates.

EVENT CRITERIA:
- Must be an actual planned event, not just time-finding discussions
- Must have some date reference (day name, date, "tomorrow", etc.)
- Include location if mentioned

REQUIRED OUTPUT:
Extract concise event details in JSON format. Keep summaries brief and actionable.

Previous context:
${history.map((msg, i) => `[${i + 1}] ${msg}`).join("\n")}

Current message: ${message}
Sender: ${sender || "Unknown"}

JSON Response Format:
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
If no time specified, use 08:00 AM
`;

			// Call OpenAI API with timeout handling
			const startTime = Date.now();
			let response: Awaited<
				ReturnType<typeof this.openai.chat.completions.create>
			>;

			try {
				const apiCall = this.openai.chat.completions.create({
					model: "gpt-4o",
					messages: [
						{
							role: "system",
							content:
								"You are a helpful assistant that analyzes WhatsApp messages to detect events and extract structured details. For Hebrew content, provide Hebrew output for summary, title, and location. You are also skilled at converting dates and times to ISO format.",
						},
						{ role: "user", content: prompt },
					],
					temperature: 0.2,
					max_tokens: 300,
					response_format: { type: "json_object" },
				});

				// Add an additional timeout safety net (35 seconds)
				const timeoutPromise = new Promise<never>((_, reject) =>
					setTimeout(
						() =>
							reject(new Error("OpenAI API call timed out after 35 seconds")),
						35000,
					),
				);

				response = await Promise.race([apiCall, timeoutPromise]);

				const duration = Date.now() - startTime;
				console.log(`OpenAI API call completed in ${duration}ms`);
			} catch (apiError: unknown) {
				const duration = Date.now() - startTime;
				const errorMessage =
					apiError instanceof Error ? apiError.message : String(apiError);
				console.error(
					`OpenAI API call failed after ${duration}ms:`,
					errorMessage,
				);

				// Check if it's a timeout error
				if (
					errorMessage.includes("timeout") ||
					errorMessage.includes("timed out")
				) {
					console.error(
						"OpenAI API call timed out. This might indicate network issues or API overload.",
					);
				}

				throw apiError;
			}

			const content = response.choices[0]?.message?.content || "";

			if (!content) {
				console.warn("OpenAI API returned empty content");
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

			try {
				// Parse the JSON response
				const parsedResponse = JSON.parse(content);

				// Prepare description with original message and sender if not already included
				let description = parsedResponse.description || null;
				if (parsedResponse.isEvent === true && description) {
					if (!description.includes(message)) {
						const senderInfo = sender ? `Sender: ${sender}` : "";
						description = `${description}\n\nOriginal message: ${message}${senderInfo ? "\n" + senderInfo : ""}`;
					}
				}

				const result = {
					isEvent: parsedResponse.isEvent === true,
					summary: parsedResponse.summary || null,
					title: parsedResponse.title || null,
					date: parsedResponse.date || null,
					time: parsedResponse.time || null,
					location: parsedResponse.location || null,
					description: description,
					startDateISO: parsedResponse.startDateISO || null,
					endDateISO: parsedResponse.endDateISO || null,
				};

				// Log the analysis result for debugging
				if (result.isEvent) {
					console.log(
						`Analysis result: Event detected - ${result.title || "Untitled"}`,
					);
				} else {
					console.log(`Analysis result: No event detected`);
				}

				return result;
			} catch (parseError) {
				console.error("Error parsing OpenAI response:", parseError);
				console.log("Raw response:", content);

				// Fallback to basic parsing if JSON parsing fails
				const isEvent =
					content.includes('"isEvent": true') ||
					content.includes('"isEvent":true');
				const summaryMatch = content.match(/"summary":\s*"([^"]*)"/);

				return {
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
	): Promise<string | null> {
		try {
			// Get the message history for context
			const history = this.getMessageHistory(chatId);

			// Create the prompt for OpenAI
			const prompt = `
You are a helpful assistant in a WhatsApp group chat. Provide a helpful, concise response to the user's message.

Previous context:
${history.map((msg, i) => `[${i + 1}] ${msg}`).join("\n")}

Current message: ${message}

Provide a helpful response. Keep it concise and natural. If the content is in Hebrew, respond in Hebrew.
`;

			// Call OpenAI API
			const startTime = Date.now();
			let response: Awaited<
				ReturnType<typeof this.openai.chat.completions.create>
			>;

			try {
				const apiCall = this.openai.chat.completions.create({
					model: "gpt-4o",
					messages: [
						{
							role: "system",
							content:
								"You are a helpful assistant in a WhatsApp group chat. Provide helpful, concise responses. Match the language of the user's message.",
						},
						{ role: "user", content: prompt },
					],
					temperature: 0.7,
					max_tokens: 500,
				});

				// Add timeout safety net (35 seconds)
				const timeoutPromise = new Promise<never>((_, reject) =>
					setTimeout(
						() =>
							reject(new Error("OpenAI API call timed out after 35 seconds")),
						35000,
					),
				);

				response = await Promise.race([apiCall, timeoutPromise]);

				const duration = Date.now() - startTime;
				console.log(`OpenAI chat API call completed in ${duration}ms`);
			} catch (apiError: unknown) {
				const duration = Date.now() - startTime;
				const errorMessage =
					apiError instanceof Error ? apiError.message : String(apiError);
				console.error(
					`OpenAI chat API call failed after ${duration}ms:`,
					errorMessage,
				);
				throw apiError;
			}

			const content = response.choices[0]?.message?.content || "";

			if (!content) {
				console.warn("OpenAI API returned empty content");
				return null;
			}

			return content.trim();
		} catch (error: unknown) {
			console.error("Error getting chat response from OpenAI:", error);
			return null;
		}
	}
}
