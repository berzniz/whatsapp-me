import type { WASocketType } from "./types.js";
import type { EventDetails } from "../openai-service.js";
import { CalendarService } from "./calendar-service.js";

export class MessageSender {
	private socket: WASocketType | null;
	private isReady: boolean;
	private calendarService: CalendarService;

	constructor() {
		this.socket = null;
		this.isReady = false;
		this.calendarService = new CalendarService();
	}

	public setSocket(socket: WASocketType | null): void {
		this.socket = socket;
	}

	public setReady(ready: boolean): void {
		this.isReady = ready;
	}

	public async sendMessageToGroup(groupId: string, message: string): Promise<void> {
		if (!this.socket || !this.isReady) {
			console.error("WhatsApp socket not ready");
			return;
		}

		try {
			await this.socket.sendMessage(groupId, { text: message });
		} catch (error) {
			console.error("Error sending message to group:", error);
		}
	}

	public async sendUnifiedEventMessage(
		groupId: string,
		eventDetails: EventDetails,
		sourceChatInfo: string,
	): Promise<void> {
		if (!this.socket || !this.isReady) {
			console.error("WhatsApp socket not ready");
			return;
		}

		try {
			// Create comprehensive caption with all event details
			const caption = this.calendarService.formatUnifiedEventCaption(
				eventDetails,
				sourceChatInfo,
			);

			// Create ICS calendar content
			const vCalendarContent = this.calendarService.createEventVCalendar(
				eventDetails,
			);
			const filename = `event_${Date.now()}.ics`;
			const buffer = Buffer.from(vCalendarContent, "utf-8");

			// Send single message with ICS file and comprehensive caption
			await this.socket.sendMessage(groupId, {
				document: buffer,
				fileName: filename,
				mimetype: "text/calendar",
				caption: caption,
			});

			console.log(`Single event message with ICS attachment sent to group`);
		} catch (error) {
			console.error("Error sending unified event message:", error);
			// Fallback to text-only message
			try {
				const fallbackMessage = `📅 Event Summary:\n\n${this.calendarService.formatUnifiedEventMessage(eventDetails, sourceChatInfo)}`;
				await this.sendMessageToGroup(groupId, fallbackMessage);
			} catch (fallbackError) {
				console.error("Fallback message also failed:", fallbackError);
			}
		}
	}
}

