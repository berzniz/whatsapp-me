# WhatsApp Message Reader with Event Detection

This application connects to WhatsApp Web, listens for messages, and uses OpenAI to detect events in the messages. When an event is detected, it creates a summary and sends it to a designated WhatsApp group, along with a calendar event file that can be added to your calendar.

## Features

- Connect to WhatsApp Web using QR code authentication
- Reuse existing sessions to avoid repeated QR code scanning
- Listen for all incoming WhatsApp messages
- Analyze messages using OpenAI to detect events
- Extract structured event details (title, date, time, location, description)
- Create summaries of detected events
- Send event summaries to a designated WhatsApp group
- Generate and send calendar event files (.ics) for easy addition to your calendar
- Display all messages in the console
- Smart date parsing that understands relative dates (like "next Monday" or "tomorrow")

## Prerequisites

- Node.js v18 or higher
- Yarn package manager
- An OpenAI API key
- A WhatsApp account
- A WhatsApp group named "אני" (or change the target group name in the code)

## Installation

1. Clone this repository
2. Install dependencies:
   ```
   yarn install
   ```
3. Create a `.env` file in the root directory with your OpenAI API key:
   ```
   OPENAI_API_KEY=your_api_key_here
   ```
4. (Optional) Add `ALLOWED_CHAT_NAMES` to your `.env` file to filter which chats are analyzed:
   ```
   ALLOWED_CHAT_NAMES=Family Group,Work Team,Book Club
   ```
   - If not set, all chats will be analyzed
   - If set, only messages from chats whose names include any of the specified names will be analyzed
   - Names are case-sensitive and use partial matching (e.g., "Family Group" will match "My Family Group" or "Family Group Chat")
   - Multiple names can be specified by separating them with commas

## Usage

1. Start the application:
   ```
   yarn start
   ```

2. If this is your first time running the application, you'll need to scan a QR code to authenticate with WhatsApp Web.

3. After authentication, the application will:
   - Listen for all WhatsApp messages
   - Analyze messages to detect events
   - Send summaries of detected events to the "אני" WhatsApp group
   - Send calendar event files (.ics) that can be added to your calendar
   - Display all messages in the console

4. To force a new session (rarely needed):
   ```
   yarn start --new-session
   ```

## How It Works

1. The application connects to WhatsApp Web using the `whatsapp-web.js` library.
2. When a message is received, it's displayed in the console and added to a message history for that chat.
3. The message is analyzed using OpenAI's GPT-4o model to determine if it contains information about an event.
4. If an event is detected:
   - OpenAI extracts structured event details (title, date, time, location, description)
   - A summary is created including date, time, location, and purpose
   - The summary is sent to the designated WhatsApp group ("אני")
   - A calendar event file (.ics) is generated using the extracted details
   - The calendar event is sent to the same group
   - The calendar event can be tapped to add it directly to your phone's calendar

## Smart Date Handling

The application intelligently handles various date formats:

- Absolute dates (e.g., "12/25/2023", "25.12.2023")
- Day names in English and Hebrew (e.g., "Monday", "יום שני")
- Relative dates (e.g., "tomorrow", "next Friday", "יום ראשון הבא")
- Month names (e.g., "25 December")

When a day of the week is mentioned without "next" (e.g., just "Monday"), the application assumes the upcoming Monday relative to the current date.

## Troubleshooting

- If the application fails to connect, try using the `--new-session` flag.
- If the target group is not found, make sure you have a WhatsApp group named "אני" or change the target group name in the code.
- If OpenAI analysis fails, check your API key and internet connection.
- If calendar events don't contain the correct information, the event details might not be clearly specified in the original message.

## License

MIT