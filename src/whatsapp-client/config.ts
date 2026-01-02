import * as fs from "fs";

export class WhatsAppConfig {
	public readonly sessionDir = ".baileys_auth";
	public targetGroupName: string = "אני"; // Default, will be overridden in configureTargetGroup
	public targetGroupId: string | null = null;
	public botGroupName: string | null = null;
	public botGroupId: string | null = null;
	public readonly allowedChatNames: string[];

	constructor() {
		// Get allowed chat names from environment variable
		const allowedChatNamesStr = process.env.ALLOWED_CHAT_NAMES;
		this.allowedChatNames = allowedChatNamesStr
			? allowedChatNamesStr.split(",").map((name) => name.trim())
			: [];

		// Configure target group from environment variables
		this.configureTargetGroup();

		// Configure bot group from environment variables
		this.configureBotGroup();

		// Ensure session directory exists
		this.ensureSessionDir();
	}

	private configureTargetGroup(): void {
		// Read target group configuration from environment variables
		const envTargetGroupId = process.env.TARGET_GROUP_ID?.trim();
		const envTargetGroupName = process.env.TARGET_GROUP_NAME?.trim();

		if (envTargetGroupId) {
			// If TARGET_GROUP_ID is provided, use it directly
			this.targetGroupId = envTargetGroupId;
			console.log(
				`Using target group ID from environment: ${this.targetGroupId}`,
			);
			this.targetGroupName = envTargetGroupName || "אני";
		} else if (envTargetGroupName) {
			// If only TARGET_GROUP_NAME is provided, use it for searching
			this.targetGroupName = envTargetGroupName;
			console.log(
				`Will search for target group by name: "${this.targetGroupName}"`,
			);
		} else {
			// Use default value if nothing is configured in .env
			this.targetGroupName = "אני"; // Default target group name
			console.log(`Using default target group name: "${this.targetGroupName}"`);
		}
	}

	private configureBotGroup(): void {
		// Read bot group configuration from environment variables
		const envBotGroupId = process.env.BOT_GROUP_ID?.trim();
		const envBotGroupName = process.env.BOT_GROUP_NAME?.trim();

		if (envBotGroupId) {
			// If BOT_GROUP_ID is provided, use it directly
			this.botGroupId = envBotGroupId;
			console.log(
				`Using bot group ID from environment: ${this.botGroupId}`,
			);
			this.botGroupName = envBotGroupName || null;
		} else if (envBotGroupName) {
			// If only BOT_GROUP_NAME is provided, use it for searching
			this.botGroupName = envBotGroupName;
			console.log(
				`Will search for bot group by name: "${this.botGroupName}"`,
			);
		}
	}

	private ensureSessionDir(): void {
		if (!fs.existsSync(this.sessionDir)) {
			fs.mkdirSync(this.sessionDir, { recursive: true });
		}
	}

	/**
	 * Check if a string contains another string as a whole word (word boundary matching)
	 * Works with Unicode characters including Hebrew
	 */
	public containsWholeWord(text: string, searchWord: string): boolean {
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
}

