# WhatsApp Event Detection System

This application connects to WhatsApp using the Baileys library, listens for messages, and uses OpenAI to detect events in the messages. When an event is detected, it creates a summary and sends it to a designated WhatsApp group, along with calendar event information that can be added to your calendar.

## Features

- Connect to WhatsApp using QR code authentication (no browser required)
- Reuse existing sessions to avoid repeated QR code scanning
- Listen for all incoming WhatsApp messages in real-time
- Analyze messages using OpenAI to detect events
- Extract structured event details (title, date, time, location, description)
- Create summaries of detected events
- Send event summaries to a designated WhatsApp group
- Generate and send calendar event information (.ics format) for easy addition to your calendar
- Display all messages in the console
- Smart date parsing that understands relative dates (like "next Monday" or "tomorrow")
- Support for both English and Hebrew event discussions
- Lightweight and efficient - no browser automation required
- Automatic reconnection handling
- Cross-platform support (Windows, macOS, Linux)

## Prerequisites

- Node.js v18 or higher
- npm or yarn package manager
- An OpenAI API key
- A WhatsApp account
- A WhatsApp group named "אני" (or change the target group name in the code)

## Installation

1. Clone this repository
2. Install dependencies:
   ```
   npm install
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
   npm start
   ```

2. If this is your first time running the application, you'll need to scan a QR code to authenticate with WhatsApp:
   - A QR code will be displayed in your terminal
   - Open WhatsApp on your phone
   - Go to Settings > Linked Devices
   - Tap "Link a Device" and scan the QR code

3. After authentication, the application will:
   - Connect to WhatsApp using WebSocket (no browser required)
   - Listen for all WhatsApp messages
   - Analyze messages to detect events
   - Send summaries of detected events to the "אני" WhatsApp group
   - Send calendar event information that can be added to your calendar
   - Display all messages in the console

4. For development with auto-restart:
   ```
   npm run dev
   ```

## How It Works

1. The application connects to WhatsApp using the `@whiskeysockets/baileys` library via WebSocket.
2. When a message is received, it's displayed in the console and added to a message history for that chat.
3. The message is analyzed using OpenAI's GPT-4o model to determine if it contains information about an event.
4. If an event is detected:
   - OpenAI extracts structured event details (title, date, time, location, description)
   - A summary is created including date, time, location, and purpose
   - The summary is sent to the designated WhatsApp group ("אני")
   - Calendar event information is generated using the extracted details
   - The calendar information is sent to the same group
   - Users can manually add the event to their calendars using the provided information

## Smart Date Handling

The application intelligently handles various date formats:

- Absolute dates (e.g., "12/25/2023", "25.12.2023")
- Day names in English and Hebrew (e.g., "Monday", "יום שני")
- Relative dates (e.g., "tomorrow", "next Friday", "יום ראשון הבא")
- Month names (e.g., "25 December")

When a day of the week is mentioned without "next" (e.g., just "Monday"), the application assumes the upcoming Monday relative to the current date.

## Advantages of Baileys over WhatsApp Web

- **No Browser Required**: Baileys connects directly via WebSocket, eliminating the need for Chromium/Puppeteer
- **Lower Resource Usage**: Uses significantly less RAM and CPU compared to browser automation
- **Better Stability**: More reliable connection with automatic reconnection handling
- **Faster**: Direct WebSocket communication is faster than browser automation
- **Cross-Platform**: Works consistently across different operating systems
- **Session Persistence**: Better session management with multi-file auth state

## Troubleshooting

- If the application fails to connect, make sure your internet connection is stable
- If the target group is not found, make sure you have a WhatsApp group named "אני" or change the target group name in the code
- If OpenAI analysis fails, check your API key and internet connection
- If calendar events don't contain the correct information, the event details might not be clearly specified in the original message
- If authentication fails, delete the `.baileys_auth` folder and restart to get a fresh QR code

## Project Structure

```
src/
├── index.ts              # Main application entry point
├── whatsapp-client.ts    # Baileys WhatsApp client wrapper
└── openai-service.ts     # OpenAI API integration for event detection
```

## License

MIT