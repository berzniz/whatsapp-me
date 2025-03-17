import OpenAI from 'openai';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

export interface EventDetails {
  isEvent: boolean;
  summary: string | null;
  title: string | null;
  date: string | null;
  time: string | null;
  location: string | null;
  description: string | null;
  startDateISO: string | null;
  endDateISO: string | null;
}

export class OpenAIService {
  private openai: OpenAI;
  private messageHistory: Map<string, string[]> = new Map();
  private readonly MAX_HISTORY_LENGTH = 5;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not defined in .env file');
    }
    
    this.openai = new OpenAI({
      apiKey: apiKey
    });
  }

  /**
   * Add a message to the history for a specific chat
   */
  public addMessageToHistory(chatId: string, message: string): void {
    if (!this.messageHistory.has(chatId)) {
      this.messageHistory.set(chatId, []);
    }
    
    const history = this.messageHistory.get(chatId)!;
    history.push(message);
    
    // Keep only the last MAX_HISTORY_LENGTH messages
    if (history.length > this.MAX_HISTORY_LENGTH) {
      this.messageHistory.set(chatId, history.slice(-this.MAX_HISTORY_LENGTH));
    }
  }

  /**
   * Get the message history for a specific chat
   */
  public getMessageHistory(chatId: string): string[] {
    return this.messageHistory.get(chatId) || [];
  }

  /**
   * Analyze a message to detect if it contains an event
   */
  public async analyzeMessage(chatId: string, message: string, sender?: string): Promise<EventDetails> {
    try {
      // Get the message history for context
      const history = this.getMessageHistory(chatId);
      
      // Create the prompt for OpenAI
      const prompt = `
Analyze the following WhatsApp message and determine if it contains information about an event (like a meeting, party, gathering, etc.).
Events usually contains a day reference, like "יום ראשון" or "יום שני" or "יום שלישי" or "יום רביעי" or "יום חמישי" or "יום שישי" or "יום שבת" 
It could also be a specific date. It doesn't have to include all information like location.
If the message only tries to find a good time to meet, it's not an event.

If it is an event, extract the following details:
1. Title - A short title for the event (in Hebrew if possible)
2. Date - The date of the event (e.g., "Monday", "יום שני", "Tomorrow", "Next Friday", "12/25/2023")
3. Time - The time of the event (e.g., "3:00 PM", "15:00", "בשעה 18:00")
4. Location - Where the event will take place (in Hebrew if possible)
5. Description - A brief description of the event
6. Start Date ISO - Convert the date and time to ISO format (YYYY-MM-DDTHH:MM:SS.sssZ)
7. End Date ISO - Assume the event lasts 1 hour and provide the end time in ISO format

Previous messages for context:
${history.map((msg, i) => `[${i + 1}] ${msg}`).join('\n')}

Current message:
${message}

Sender: ${sender || 'Unknown'}

Respond in the following JSON format:
{
  "isEvent": true/false,
  "summary": "A concise summary of the event including date, time, location, and purpose. Include the original message text.",
  "title": "Event title in Hebrew if possible",
  "date": "Event date",
  "time": "Event time",
  "location": "Event location in Hebrew if possible",
  "description": "Event description including the original message and sender information",
  "startDateISO": "YYYY-MM-DDTHH:MM:SS.sssZ",
  "endDateISO": "YYYY-MM-DDTHH:MM:SS.sssZ"
}

If it's not an event, just set isEvent to false and leave the other fields as null.
For the summary, title, and location fields, prefer Hebrew if the content is in Hebrew or relates to Hebrew speakers.
Make sure to include the original message in the summary.
In the description, include both the original message and the sender information.

For the startDateISO and endDateISO fields:
1. Analyze the date and time from the message
2. Assume any date and time mentioned is in Israel timezone
3. Convert to ISO format (YYYY-MM-DDTHH:MM:SS.sssZ)
4. If the time is not specified, set the time to 8:00 AM (08:00) and end time to 9:00 AM (09:00)
5. If there is no year in the date, assume the current year (${new Date().getFullYear()})
6. If a time is specified, set the end time to 1 hour after the start time
7. If you can't determine a date, use the current date
`;

      // Call OpenAI API
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a helpful assistant that analyzes WhatsApp messages to detect events and extract structured details. For Hebrew content, provide Hebrew output for summary, title, and location. You are also skilled at converting dates and times to ISO format.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 500,
        response_format: { type: "json_object" }
      });

      const content = response.choices[0]?.message?.content || '';
      
      try {
        // Parse the JSON response
        const parsedResponse = JSON.parse(content);
        
        // Prepare description with original message and sender if not already included
        let description = parsedResponse.description || null;
        if (parsedResponse.isEvent === true && description) {
          if (!description.includes(message)) {
            const senderInfo = sender ? `Sender: ${sender}` : '';
            description = `${description}\n\nOriginal message: ${message}${senderInfo ? '\n' + senderInfo : ''}`;
          }
        }
        
        return {
          isEvent: parsedResponse.isEvent === true,
          summary: parsedResponse.summary || null,
          title: parsedResponse.title || null,
          date: parsedResponse.date || null,
          time: parsedResponse.time || null,
          location: parsedResponse.location || null,
          description: description,
          startDateISO: parsedResponse.startDateISO || null,
          endDateISO: parsedResponse.endDateISO || null
        };
      } catch (parseError) {
        console.error('Error parsing OpenAI response:', parseError);
        console.log('Raw response:', content);
        
        // Fallback to basic parsing if JSON parsing fails
        const isEvent = content.includes('"isEvent": true') || content.includes('"isEvent":true');
        const summaryMatch = content.match(/"summary":\s*"([^"]*)"/);
        
        return {
          isEvent,
          summary: summaryMatch ? summaryMatch[1] : null,
          title: null,
          date: null,
          time: null,
          location: null,
          description: null,
          startDateISO: null,
          endDateISO: null
        };
      }
    } catch (error) {
      console.error('Error analyzing message with OpenAI:', error);
      return {
        isEvent: false,
        summary: null,
        title: null,
        date: null,
        time: null,
        location: null,
        description: null,
        startDateISO: null,
        endDateISO: null
      };
    }
  }
} 