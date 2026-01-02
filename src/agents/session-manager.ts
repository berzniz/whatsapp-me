import { MemorySession } from "@openai/agents";
import type { Session } from "@openai/agents";

/**
 * Manages sessions per chat ID using MemorySession from @openai/agents
 */
export class SessionManager {
	private sessions: Map<string, Session> = new Map();
	private readonly MAX_HISTORY_LENGTH = 5;

	/**
	 * Get or create a session for a chat ID
	 */
	public getSession(chatId: string): Session {
		if (!this.sessions.has(chatId)) {
			this.sessions.set(chatId, new MemorySession());
		}
		return this.sessions.get(chatId)!;
	}

	/**
	 * Add a message to the history for a specific chat
	 * This maintains backward compatibility with the old message history system
	 */
	public addMessageToHistory(chatId: string, message: string): void {
		const session = this.getSession(chatId);
		// The session will handle message history automatically through the run() function
		// This method is kept for backward compatibility
	}

	/**
	 * Get message history for a chat (for backward compatibility)
	 * Note: MemorySession manages history internally, so this returns an empty array
	 * The actual history is maintained by the session during agent runs
	 */
	public getMessageHistory(chatId: string): string[] {
		// MemorySession manages history internally, so we return empty array
		// The history is automatically included when running agents with the session
		return [];
	}

	/**
	 * Clear session for a chat ID
	 */
	public clearSession(chatId: string): void {
		this.sessions.delete(chatId);
	}

	/**
	 * Clear all sessions
	 */
	public clearAllSessions(): void {
		this.sessions.clear();
	}
}

