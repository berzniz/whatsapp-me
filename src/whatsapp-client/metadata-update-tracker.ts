import * as fs from "fs";
import * as path from "path";

interface UpdateRecord {
	groupId: string;
	lastUpdate: number; // timestamp in milliseconds
}

export class MetadataUpdateTracker {
	private readonly updateFile: string;
	private updates: Map<string, number> = new Map();
	private readonly WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

	constructor(sessionDir: string) {
		this.updateFile = path.join(sessionDir, "group_metadata_updates.json");
		this.loadUpdates();
	}

	private loadUpdates(): void {
		try {
			if (fs.existsSync(this.updateFile)) {
				const data = fs.readFileSync(this.updateFile, "utf-8");
				const records: UpdateRecord[] = JSON.parse(data);
				for (const record of records) {
					this.updates.set(record.groupId, record.lastUpdate);
				}
			}
		} catch (error) {
			console.warn("Failed to load metadata update tracker:", error);
		}
	}

	private saveUpdates(): void {
		try {
			const records: UpdateRecord[] = Array.from(this.updates.entries()).map(
				([groupId, lastUpdate]) => ({
					groupId,
					lastUpdate,
				}),
			);
			fs.writeFileSync(this.updateFile, JSON.stringify(records, null, 2));
		} catch (error) {
			console.warn("Failed to save metadata update tracker:", error);
		}
	}

	/**
	 * Check if metadata should be updated (if it's been more than a week)
	 */
	public shouldUpdateMetadata(groupId: string): boolean {
		const lastUpdate = this.updates.get(groupId);
		if (!lastUpdate) {
			return true; // Never updated, should update
		}

		const now = Date.now();
		const timeSinceUpdate = now - lastUpdate;
		return timeSinceUpdate >= this.WEEK_IN_MS;
	}

	/**
	 * Mark metadata as updated for a group
	 */
	public markUpdated(groupId: string): void {
		this.updates.set(groupId, Date.now());
		this.saveUpdates();
	}

	/**
	 * Get the last update time for a group
	 */
	public getLastUpdate(groupId: string): number | undefined {
		return this.updates.get(groupId);
	}
}

