import crypto from "crypto";
import NodeCache from "node-cache";

export interface EventHashData {
	title: string | null;
	date: string | null;
	time: string | null;
	location: string | null;
}

export class EventDeduplicationService {
	private cache: NodeCache;
	private readonly DEFAULT_TTL_HOURS = 24;
	private readonly TTL_SECONDS: number;

	constructor() {
		// Get TTL from environment variable (in hours), default to 24 hours
		const ttlHours = parseInt(
			process.env.EVENT_DEDUPLICATION_TTL_HOURS ||
				this.DEFAULT_TTL_HOURS.toString(),
		);
		this.TTL_SECONDS = ttlHours * 60 * 60; // Convert hours to seconds

		// Initialize cache with TTL
		this.cache = new NodeCache({
			stdTTL: this.TTL_SECONDS,
			useClones: false,
		});

		console.log(`Event deduplication initialized with ${ttlHours} hour TTL`);
	}

	/**
	 * Generate a unique hash for an event based on its core properties
	 */
	private generateEventHash(eventData: EventHashData): string {
		// Normalize the data for consistent hashing
		const normalizedData = {
			title: this.normalizeText(eventData.title),
			date: this.normalizeText(eventData.date),
			time: this.normalizeText(eventData.time),
			location: this.normalizeText(eventData.location),
		};

		// Create a string representation of the normalized data
		const hashString = JSON.stringify(normalizedData);

		// Generate SHA-256 hash
		return crypto.createHash("sha256").update(hashString).digest("hex");
	}

	/**
	 * Normalize text for consistent hashing
	 * - Convert to lowercase
	 * - Remove extra whitespace
	 * - Remove punctuation
	 */
	private normalizeText(text: string | null): string {
		if (!text) return "";

		return text
			.toLowerCase()
			.trim()
			.replace(/\s+/g, " ") // Replace multiple spaces with single space
			.replace(/[.,!?;:]/g, "") // Remove punctuation
			.replace(/["']/g, ""); // Remove quotes
	}

	/**
	 * Check if an event has already been processed
	 * Returns true if event is duplicate, false if it's new
	 */
	public isDuplicateEvent(eventData: EventHashData): boolean {
		const eventHash = this.generateEventHash(eventData);
		const isDuplicate = this.cache.has(eventHash);

		if (isDuplicate) {
			console.log(`Duplicate event detected: ${eventHash}`);
		} else {
			console.log(`New event detected: ${eventHash}`);
		}

		return isDuplicate;
	}

	/**
	 * Mark an event as processed (store its hash in cache)
	 */
	public markEventAsProcessed(eventData: EventHashData): void {
		const eventHash = this.generateEventHash(eventData);
		this.cache.set(eventHash, true);
		console.log(`Event marked as processed: ${eventHash}`);
	}

	/**
	 * Check if event is duplicate and mark as processed if new
	 * Returns true if event should be processed (not duplicate), false if duplicate
	 */
	public shouldProcessEvent(eventData: EventHashData): boolean {
		if (this.isDuplicateEvent(eventData)) {
			return false; // Don't process duplicate
		}

		// Mark as processed and return true to process it
		this.markEventAsProcessed(eventData);
		return true;
	}

	/**
	 * Get cache statistics
	 */
	public getCacheStats(): {
		keys: number;
		hits: number;
		misses: number;
		ttl: number;
	} {
		return {
			keys: this.cache.keys().length,
			hits: this.cache.getStats().hits,
			misses: this.cache.getStats().misses,
			ttl: this.TTL_SECONDS,
		};
	}

	/**
	 * Clear all cached events (useful for testing)
	 */
	public clearCache(): void {
		this.cache.flushAll();
		console.log("Event deduplication cache cleared");
	}

	/**
	 * Get TTL in hours
	 */
	public getTtlHours(): number {
		return this.TTL_SECONDS / 3600;
	}
}
