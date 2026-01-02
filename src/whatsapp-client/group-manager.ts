import NodeCache from "node-cache";
import type { WASocketType } from "./types.js";
import type { WhatsAppConfig } from "./config.js";
import type { GroupMetadata } from "./types.js";
import { MetadataUpdateTracker } from "./metadata-update-tracker.js";

export class GroupManager {
	private groupCache: NodeCache;
	private config: WhatsAppConfig;
	private updateTracker: MetadataUpdateTracker;

	constructor(config: WhatsAppConfig) {
		this.config = config;
		this.groupCache = new NodeCache({ stdTTL: 5 * 60, useClones: false }); // 5 minute TTL
		this.updateTracker = new MetadataUpdateTracker(config.sessionDir);
	}

	/**
	 * Check if a group should have its metadata cached
	 * We cache metadata for:
	 * 1. The target group (always) - needed to send messages
	 * 2. The bot group (always) - needed to send messages
	 * 3. Groups in the allowed list (if ALLOWED_CHAT_NAMES is set)
	 * 4. All groups (if no allowed list is specified)
	 */
	public shouldCacheGroupMetadata(
		groupSubject: string | null,
		groupId: string,
	): boolean {
		// Always cache the target group
		if (groupId === this.config.targetGroupId) {
			return true;
		}

		// Always cache the bot group
		if (groupId === this.config.botGroupId) {
			return true;
		}

		// If no allowed list is specified, cache all groups (backward compatibility)
		if (this.config.allowedChatNames.length === 0) {
			return true;
		}

		// Only cache groups that are in the allowed list
		if (!groupSubject) {
			return false;
		}

		return this.config.allowedChatNames.some((name) =>
			this.config.containsWholeWord(groupSubject, name),
		);
	}

	public getCachedMetadata(groupId: string): GroupMetadata | undefined {
		return this.groupCache.get(groupId) as GroupMetadata | undefined;
	}

	public setCachedMetadata(groupId: string, metadata: GroupMetadata): void {
		this.groupCache.set(groupId, metadata);
	}

	/**
	 * Set cached metadata and mark it as updated (used during sync)
	 */
	public setCachedMetadataAndMarkUpdated(
		groupId: string,
		metadata: GroupMetadata,
	): void {
		this.setCachedMetadata(groupId, metadata);
		this.updateTracker.markUpdated(groupId);
	}

	/**
	 * Check if metadata should be updated (has it been more than a week?)
	 */
	public shouldUpdateMetadata(groupId: string): boolean {
		return this.updateTracker.shouldUpdateMetadata(groupId);
	}

	public async fetchAndCacheMetadata(
		socket: WASocketType,
		groupId: string,
		_groupSubject: string | null,
	): Promise<GroupMetadata | null> {
		try {
			const metadata = await socket.groupMetadata(groupId);
			const fetchedSubject = metadata.subject || null;

			// Only cache if it's an allowed group (to avoid rate limits on updates)
			if (this.shouldCacheGroupMetadata(fetchedSubject, groupId)) {
				this.setCachedMetadata(groupId, metadata);
				this.updateTracker.markUpdated(groupId);
			}

			return metadata as GroupMetadata;
		} catch (error) {
			console.warn(
				`Could not fetch metadata for group ${groupId}, using fallback:`,
				error,
			);
			// Return null if fetch fails - caller should handle this
			return null;
		}
	}

	public async updateGroupMetadata(
		socket: WASocketType,
		groupId: string,
		groupSubject: string | null,
	): Promise<void> {
		if (!this.shouldCacheGroupMetadata(groupSubject, groupId)) {
			return;
		}

		// Only update if it's been more than a week since last update
		if (!this.updateTracker.shouldUpdateMetadata(groupId)) {
			return; // Skip update, use cached metadata
		}

		try {
			const metadata = await socket.groupMetadata(groupId);
			this.setCachedMetadata(groupId, metadata);
			this.updateTracker.markUpdated(groupId);
			console.log(
				`Updated group metadata cache for: ${metadata.subject || groupId}`,
			);
		} catch (error) {
			console.error(
				`Failed to update group metadata cache for ${groupId}:`,
				error,
			);
		}
	}

	/**
	 * Get all cached groups that match ALLOWED_CHAT_NAMES
	 */
	public getAllowedCachedGroups(): Array<{ id: string; name: string }> {
		const groups: Array<{ id: string; name: string }> = [];
		
		// Get all keys from the cache
		const keys = this.groupCache.keys();
		
		for (const groupId of keys) {
			const metadata = this.getCachedMetadata(groupId);
			if (metadata && metadata.subject) {
				const groupName = metadata.subject;
				// Check if this group matches ALLOWED_CHAT_NAMES
				if (this.shouldCacheGroupMetadata(groupName, groupId)) {
					groups.push({
						id: groupId,
						name: groupName,
					});
				}
			}
		}
		
		return groups;
	}

	/**
	 * Find a group ID by name (searches cached groups)
	 */
	public findGroupIdByName(groupName: string): string | null {
		const keys = this.groupCache.keys();
		
		for (const groupId of keys) {
			const metadata = this.getCachedMetadata(groupId);
			if (metadata && metadata.subject) {
				if (
					metadata.subject === groupName ||
					this.config.containsWholeWord(metadata.subject, groupName)
				) {
					return groupId;
				}
			}
		}
		
		return null;
	}
}
