import type { EventDetails } from "../openai-service.js";

export class CalendarService {
	/**
	 * Create ICS calendar content for an event
	 */
	public createEventVCalendar(eventDetails: EventDetails): string {
		const now = new Date();
		const dtstamp = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
		const uid = `event-${Date.now()}@whatsapp-bot`;

		let vcalendar = "BEGIN:VCALENDAR\n";
		vcalendar += "VERSION:2.0\n";
		vcalendar += "PRODID:-//WhatsApp Event Bot//EN\n";
		vcalendar += "BEGIN:VEVENT\n";
		vcalendar += `UID:${uid}\n`;
		vcalendar += `DTSTAMP:${dtstamp}\n`;

		if (eventDetails.startDateISO) {
			const startDate = new Date(eventDetails.startDateISO);
			const dtstart =
				startDate.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
			vcalendar += `DTSTART:${dtstart}\n`;
		}

		if (eventDetails.endDateISO) {
			const endDate = new Date(eventDetails.endDateISO);
			const dtend =
				endDate.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
			vcalendar += `DTEND:${dtend}\n`;
		}

		if (eventDetails.title) {
			vcalendar += `SUMMARY:${eventDetails.title.replace(/\n/g, "\\n")}\n`;
		}

		if (eventDetails.description) {
			vcalendar += `DESCRIPTION:${eventDetails.description.replace(/\n/g, "\\n")}\n`;
		}

		if (eventDetails.location) {
			vcalendar += `LOCATION:${eventDetails.location.replace(/\n/g, "\\n")}\n`;
		}

		vcalendar += "END:VEVENT\n";
		vcalendar += "END:VCALENDAR";

		return vcalendar;
	}

	/**
	 * Format event details as a text message
	 */
	public formatUnifiedEventMessage(
		eventDetails: EventDetails,
		sourceChatInfo: string,
	): string {
		let message = `📅 **Event Summary**\n\n`;

		// Essential information only
		if (eventDetails.title) {
			message += `🎯 **${eventDetails.title}**\n`;
		}

		// Date and time on one line
		let dateTimeLine = "";
		if (eventDetails.date) {
			dateTimeLine += `📅 ${eventDetails.date}`;
		}
		if (eventDetails.time) {
			dateTimeLine += ` ${eventDetails.time}`;
		}
		if (dateTimeLine) {
			message += `${dateTimeLine}\n`;
		}

		// Location
		if (eventDetails.location) {
			message += `📍 ${eventDetails.location}\n`;
		}

		// Brief description (first line only, keep it short)
		if (eventDetails.description) {
			const firstLine = eventDetails.description.split("\n")[0];
			if (firstLine.length > 100) {
				message += `📝 ${firstLine.substring(0, 97)}...\n`;
			} else {
				message += `📝 ${firstLine}\n`;
			}
		}

		// Source information
		message += `\n💬 ${sourceChatInfo}`;

		return message;
	}

	/**
	 * Format event details as a caption for WhatsApp message
	 */
	public formatUnifiedEventCaption(
		eventDetails: EventDetails,
		sourceChatInfo: string,
	): string {
		let caption = `📅 *${eventDetails.title || "Event"}*\n`;

		// Date and time on same line if both exist
		if (eventDetails.date && eventDetails.time) {
			caption += `📅 ${eventDetails.date} | 🕐 ${eventDetails.time}\n`;
		} else if (eventDetails.date) {
			caption += `📅 ${eventDetails.date}\n`;
		} else if (eventDetails.time) {
			caption += `🕐 ${eventDetails.time}\n`;
		}

		// Location
		if (eventDetails.location) {
			caption += `📍 ${eventDetails.location}\n`;
		}

		// Brief description
		if (eventDetails.description) {
			const firstLine = eventDetails.description.split("\n")[0];
			if (firstLine.length > 150) {
				caption += `📝 ${firstLine.substring(0, 147)}...\n`;
			} else {
				caption += `📝 ${firstLine}\n`;
			}
		}

		// Source
		caption += `\n💬 ${sourceChatInfo}`;

		return caption;
	}
}

