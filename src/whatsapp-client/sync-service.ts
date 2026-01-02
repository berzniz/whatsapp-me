import type { WASocketType } from "./types.js";
import type { GroupManager } from "./group-manager.js";
import type { WhatsAppConfig } from "./config.js";

export class SyncService {
	private socket: WASocketType | null;
	private groupManager: GroupManager;
	private config: WhatsAppConfig;

	constructor(
		socket: WASocketType | null,
		groupManager: GroupManager,
		config: WhatsAppConfig,
	) {
		this.socket = socket;
		this.groupManager = groupManager;
		this.config = config;
	}

	public setSocket(socket: WASocketType | null): void {
		this.socket = socket;
	}

	public async performFullSync(): Promise<void> {
		if (!this.socket) {
			throw new Error("Socket not available for synchronization");
		}

		console.log("Performing full synchronization...");

		// Step 1: Sync all groups and find target group
		await this.syncAllGroups();

		// Step 2: Sync all chats (this happens via events, but we wait a bit)
		await this.syncAllChats();

		// Step 3: Verify target group is accessible if configured
		// Always verify target group if it's been more than a week (it's needed for sending messages)
		if (this.config.targetGroupId) {
			// Always verify target group, but only update metadata if it's been a week
			if (this.groupManager.shouldUpdateMetadata(this.config.targetGroupId)) {
				try {
					const metadata = await this.socket.groupMetadata(
						this.config.targetGroupId,
					);
					this.groupManager.setCachedMetadataAndMarkUpdated(
						this.config.targetGroupId,
						metadata,
					);
					console.log(
						`✓ Target group verified: ${metadata.subject || this.config.targetGroupId}`,
					);
				} catch (error) {
					console.warn(
						`⚠ Could not verify target group ${this.config.targetGroupId}:`,
						error,
					);
				}
			} else {
				console.log(
					`✓ Target group metadata is up to date (updated less than a week ago)`,
				);
			}
		} else {
			console.warn(
				`⚠ Target group "${this.config.targetGroupName}" not found. Make sure the bot is added to the group.`,
			);
		}

		console.log("Full synchronization completed");
	}

	private async syncAllGroups(): Promise<void> {
		if (!this.socket) return;

		try {
			console.log("Syncing all groups...");
			const groupsDict = await this.socket.groupFetchAllParticipating();

			// Convert dictionary to array
			const groups = Object.values(groupsDict);

			console.log(`✓ Found ${groups.length} groups`);

			// Cache group metadata only for allowed groups (to avoid rate limits)
			// Only update metadata if it's been more than a week since last update
			let cachedCount = 0;
			let skippedCount = 0;
			for (const group of groups) {
				if (
					this.groupManager.shouldCacheGroupMetadata(
						group.subject || null,
						group.id,
					)
				) {
					// Only update if it's been more than a week since last update
					if (this.groupManager.shouldUpdateMetadata(group.id)) {
						this.groupManager.setCachedMetadataAndMarkUpdated(group.id, group);
						cachedCount++;
					} else {
						// Skip updating, but still cache if we don't have it
						const existing = this.groupManager.getCachedMetadata(group.id);
						if (!existing) {
							this.groupManager.setCachedMetadata(group.id, group);
							cachedCount++;
						} else {
							skippedCount++;
						}
					}
				}
			}
			console.log(
				`✓ Cached metadata for ${cachedCount} groups (filtered by ALLOWED_CHAT_NAMES${skippedCount > 0 ? `, ${skippedCount} skipped due to recent update` : ""})`,
			);

			// If we don't have target group ID yet, search for it
			if (!this.config.targetGroupId) {
				const foundGroup = groups.find(
					(g) => g.subject === this.config.targetGroupName,
				);
				if (foundGroup) {
					this.config.targetGroupId = foundGroup.id;
					console.log(
						`✓ Found target group "${this.config.targetGroupName}" with ID: ${this.config.targetGroupId}`,
					);
				} else {
					console.log(
						`Target group "${this.config.targetGroupName}" not found in ${groups.length} groups.`,
					);
					if (groups.length > 0) {
						console.log(
							"Available groups:",
							groups.map((g) => g.subject || g.id).join(", "),
						);
					}
				}
			} else {
				// Verify the target group exists
				const targetGroup = groups.find((g) => g.id === this.config.targetGroupId);
				if (targetGroup) {
					console.log(
						`✓ Verified target group exists: ${targetGroup.subject || this.config.targetGroupId}`,
					);
					this.groupManager.setCachedMetadataAndMarkUpdated(
						this.config.targetGroupId,
						targetGroup,
					);
				} else {
					console.warn(
						`⚠ Target group ID ${this.config.targetGroupId} not found in synced groups.`,
					);
				}
			}
		} catch (error) {
			console.error("Error syncing groups:", error);
			throw error;
		}
	}

	private async syncAllChats(): Promise<void> {
		if (!this.socket) return;

		try {
			console.log("Syncing all chats...");

			// Wait for chats to be loaded via events
			// Baileys will emit chats.upsert events with all chats
			// We'll wait a bit for the initial sync to complete
			await new Promise((resolve) => setTimeout(resolve, 2000));

			console.log("✓ Chats sync completed");
		} catch (error) {
			console.error("Error syncing chats:", error);
			// Don't throw - chats sync is less critical than groups
		}
	}
}

