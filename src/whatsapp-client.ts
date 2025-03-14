import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import * as fs from 'fs';
import * as path from 'path';
import puppeteer from 'puppeteer';
import { OpenAIService, EventDetails } from './openai-service';

export class WhatsAppClient {
  private client!: Client;
  private isReady: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 3;
  private readonly sessionDir = '.wwebjs_auth';
  private readonly chromeDataDir: string;
  private chromePath: string | undefined;
  private qrCodeDisplayed: boolean = false;
  private isExistingSession: boolean = false;
  private forceNewSession: boolean = false;
  private openaiService: OpenAIService;
  private targetGroupName: string = 'אני'; // The target group to send summaries to
  private targetGroupId: string | null = null;

  constructor(forceNewSession: boolean = false) {
    this.forceNewSession = forceNewSession;
    this.chromeDataDir = path.join(this.sessionDir, 'chrome-data');
    this.openaiService = new OpenAIService();
    
    // Ensure session directory exists
    this.ensureSessionDir();
    
    // If forcing a new session, reset it now
    if (this.forceNewSession) {
      this.resetSession();
    }
    
    // Check if session already exists
    this.checkExistingSession();
  }

  private ensureSessionDir(): void {
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
    
    const sessionPath = path.join(this.sessionDir, 'session');
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }
    
    if (!fs.existsSync(this.chromeDataDir)) {
      fs.mkdirSync(this.chromeDataDir, { recursive: true });
    }
  }
  
  private async findChromePath(): Promise<string | undefined> {
    try {
      console.log('Launching browser to find Chrome executable path...');
      // Try to find Chrome executable path using Puppeteer
      const browser = await puppeteer.launch();
      const executablePath = browser.process()?.spawnfile;
      await browser.close();
      
      if (executablePath) {
        console.log(`Found Chrome executable at: ${executablePath}`);
        return executablePath;
      } else {
        console.log('Could not find Chrome executable path, using default');
        return undefined;
      }
    } catch (error) {
      console.error('Error finding Chrome path:', error);
      return undefined;
    }
  }

  private initializeClient(chromePath?: string): void {
    console.log('Creating WhatsApp client...');
    
    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: this.sessionDir,
        clientId: 'whatsapp-me-client'
      }),
      puppeteer: {
        headless: true,
        executablePath: chromePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--user-data-dir=' + this.chromeDataDir
        ]
      },
      restartOnAuthFail: true
    });

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.client.on('qr', (qr) => {
      this.qrCodeDisplayed = true;
      console.log('Scan the QR code below to log in to WhatsApp:');
      qrcode.generate(qr, { small: true });
      console.log('\nWaiting for QR code to be scanned...');
    });

    this.client.on('loading_screen', (percent, message) => {
      console.log(`Loading WhatsApp: ${percent}% - ${message}`);
    });

    this.client.on('authenticated', () => {
      console.log('Authentication successful!');
      console.log('Waiting for WhatsApp to fully load...');
    });

    this.client.on('auth_failure', (error) => {
      console.error('Authentication failed:', error);
      console.log('Authentication error occurred. Please restart the application and try again.');
      
      // Don't remove the session directory to preserve data
      process.exit(1);
    });

    this.client.on('ready', async () => {
      console.log('Client is ready!');
      this.isReady = true;
      this.reconnectAttempts = 0;
      
      // Find the target group when client is ready
      await this.findTargetGroup();
    });

    // Listen to all incoming messages, including those sent by the user
    this.client.on('message_create', async (message) => {
      try {
        // Skip messages sent by this client to avoid loops
        if (/* message.fromMe && */ message.body.includes('Event Summary:') || message.body.includes('Event details')) {
          console.log('Skipping message from self:', message.body);
          return;
        }
        
        const chat = await message.getChat();
        const contact = await message.getContact();
        const contactName = contact.pushname || contact.number;
        const timestamp = new Date().toLocaleTimeString();
        const chatName = chat.isGroup ? `[${chat.name}]` : '';
        const fromMe = message.fromMe ? '[YOU]' : '';
        
        // Log the message
        console.log(`\n[${timestamp}] ${chatName} ${fromMe} ${contactName}: ${message.body}`);
        
        // Add message to history for this chat
        this.openaiService.addMessageToHistory(chat.id._serialized, message.body);
        
        // Only analyze messages that aren't empty and aren't from the target group
        if (message.body.trim() /* && chat.name !== this.targetGroupName */) {
          console.log(`Analyzing message for events...`);
          
          // Analyze the message for events
          const analysis = await this.openaiService.analyzeMessage(
            chat.id._serialized, 
            message.body,
            contactName
          );
          
          if (analysis.isEvent && analysis.summary) {
            console.log(`Event detected! Summary: ${analysis.summary}`);
            console.log(`Event details:`, {
              title: analysis.title,
              date: analysis.date,
              time: analysis.time,
              location: analysis.location,
              description: analysis.description,
              startDateISO: analysis.startDateISO,
              endDateISO: analysis.endDateISO
            });
            
            // If we found the target group, send the summary
            if (this.targetGroupId) {
              const sourceChatInfo = chat.isGroup ? 
                `Group: ${chat.name}` : 
                `Contact: ${contactName}`;
              
              const summaryMessage = `Event Summary:\n\n${analysis.summary}\n\nSource: ${sourceChatInfo}`;
              
              // Send the text summary
              await this.sendMessageToGroup(this.targetGroupId, summaryMessage);
              console.log(`Event summary sent to "${this.targetGroupName}" group`);
              
              // Send as WhatsApp event using the structured data from OpenAI
              await this.sendEventToGroup(this.targetGroupId, analysis);
            } else {
              console.log(`Target group "${this.targetGroupName}" not found. Summary not sent.`);
            }
          } else {
            console.log(`No event detected in message: ${message.body}`);
          }
        }
      } catch (error) {
        console.error('Error processing message:', error);
      }
    });

    this.client.on('disconnected', async (reason) => {
      console.log(`\nClient was disconnected: ${reason}`);
      this.isReady = false;
      
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
        
        // Wait a bit before reconnecting
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Re-initialize the client
        this.initializeClient(this.chromePath);
        try {
          await this.initialize();
        } catch (error) {
          console.error('Failed to reconnect:', error);
        }
      } else {
        console.error('Maximum reconnection attempts reached. Please restart the application.');
        process.exit(1);
      }
    });
  }

  private async findTargetGroup(): Promise<void> {
    try {
      console.log(`Looking for target group "${this.targetGroupName}"...`);
      const chats = await this.client.getChats();
      const targetGroup = chats.find(chat => {
        return chat.name === this.targetGroupName
      }
        
      );
      
      if (targetGroup) {
        this.targetGroupId = targetGroup.id._serialized;
        console.log(`Found target group "${this.targetGroupName}" with ID: ${this.targetGroupId}`);
      } else {
        console.log(`Target group "${this.targetGroupName}" not found. Event summaries will not be sent.`);
      }
    } catch (error) {
      console.error('Error finding target group:', error);
    }
  }

  private async sendMessageToGroup(groupId: string, message: string): Promise<void> {
    try {
      await this.client.sendMessage(groupId, message);
    } catch (error) {
      console.error('Error sending message to group:', error);
    }
  }

  /**
   * Extracts event details from a summary and sends it as a WhatsApp event
   */
  private async sendEventToGroup(groupId: string, eventDetails: EventDetails): Promise<void> {
    try {
      if (eventDetails.isEvent) {
        console.log('Creating WhatsApp event with details:', eventDetails);
        
        // Format the event vCard
        const vcard = this.createEventVCard(eventDetails);
        
        // Send the vCard as a document
        const media = new MessageMedia('text/calendar', Buffer.from(vcard).toString('base64'), 'event.ics');
        await this.client.sendMessage(groupId, media, {
          caption: 'Event details (add to calendar)'
        });
        
        console.log('WhatsApp event sent successfully');
      } else {
        console.log('No event details available to send');
      }
    } catch (error) {
      console.error('Error sending event to group:', error);
    }
  }
  
  /**
   * Creates an iCalendar vCard for an event
   */
  private createEventVCard(eventDetails: EventDetails): string {
    // Generate a unique ID for the event
    const eventId = `event-${Date.now()}@whatsapp-me.app`;
    
    // Current timestamp in iCalendar format
    const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    
    // Try to use the ISO date strings provided by OpenAI
    let startDate = now;
    let endDate = now;
    
    try {
      if (eventDetails.startDateISO) {
        // Convert ISO string to iCalendar format
        startDate = new Date(eventDetails.startDateISO)
          .toISOString()
          .replace(/[-:]/g, '')
          .split('.')[0] + 'Z';
        
        // Use the provided end date or default to start + 1 hour
        if (eventDetails.endDateISO) {
          endDate = new Date(eventDetails.endDateISO)
            .toISOString()
            .replace(/[-:]/g, '')
            .split('.')[0] + 'Z';
        } else {
          // Default to 1 hour after start time
          const endEventDate = new Date(new Date(eventDetails.startDateISO).getTime() + 60 * 60 * 1000);
          endDate = endEventDate
            .toISOString()
            .replace(/[-:]/g, '')
            .split('.')[0] + 'Z';
        }
        
        // Check if the time part is 08:00:00 (meaning it was a date-only event set to 8am by OpenAI)
        const startDateTime = new Date(eventDetails.startDateISO);
        const isDefaultTime = startDateTime.getHours() === 8 && startDateTime.getMinutes() === 0;
        
        console.log(`Using OpenAI provided dates - Start: ${startDate}, End: ${endDate}${isDefaultTime ? ' (Default 8am-9am time)' : ''}`);
      } else {
        // Fall back to manual parsing if ISO dates are not provided
        // Get current date as the base
        const today = new Date();
        let eventDate = new Date(today);
        
        // Parse the date string
        if (eventDetails.date) {
          const dateStr = eventDetails.date.toLowerCase();
          
          // Handle absolute dates first
          const absoluteDateMatch = dateStr.match(/(\d{1,2})[\/\.](\d{1,2})[\/\.](\d{2,4})/);
          if (absoluteDateMatch) {
            // Assuming DD/MM/YYYY format (adjust if your locale uses MM/DD/YYYY)
            const day = parseInt(absoluteDateMatch[1]);
            const month = parseInt(absoluteDateMatch[2]) - 1; // JS months are 0-indexed
            const year = parseInt(absoluteDateMatch[3]);
            
            eventDate = new Date(year < 100 ? year + 2000 : year, month, day);
          } 
          // Handle month names
          else if (dateStr.match(/\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December)/i)) {
            const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 
                               'july', 'august', 'september', 'october', 'november', 'december'];
            
            for (let i = 0; i < monthNames.length; i++) {
              if (dateStr.toLowerCase().includes(monthNames[i])) {
                const dayMatch = dateStr.match(/(\d{1,2})/);
                if (dayMatch) {
                  const day = parseInt(dayMatch[1]);
                  eventDate.setMonth(i);
                  eventDate.setDate(day);
                  break;
                }
              }
            }
          }
          // Handle days of the week (English)
          else if (dateStr.match(/(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/i)) {
            const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
            const targetDay = dayNames.findIndex(day => dateStr.toLowerCase().includes(day));
            
            if (targetDay !== -1) {
              const currentDay = today.getDay();
              let daysToAdd = targetDay - currentDay;
              
              // If it's "next" day, add 7 days
              if (dateStr.includes('next')) {
                daysToAdd += 7;
              } 
              // If it's the same day but we've passed it, or it's a past day, go to next week
              else if (daysToAdd <= 0 && !dateStr.includes('today')) {
                daysToAdd += 7;
              }
              
              eventDate.setDate(today.getDate() + daysToAdd);
            }
          }
          // Handle Hebrew days of the week
          else if (dateStr.match(/יום (ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/i)) {
            const hebrewDayMap: Record<string, number> = {
              'ראשון': 0,   // Sunday
              'שני': 1,     // Monday
              'שלישי': 2,   // Tuesday
              'רביעי': 3,   // Wednesday
              'חמישי': 4,   // Thursday
              'שישי': 5,    // Friday
              'שבת': 6      // Saturday
            };
            
            // Find which Hebrew day is mentioned
            let targetDay = -1;
            for (const [hebrewDay, dayIndex] of Object.entries(hebrewDayMap)) {
              if (dateStr.includes(hebrewDay)) {
                targetDay = dayIndex;
                break;
              }
            }
            
            if (targetDay !== -1) {
              const currentDay = today.getDay();
              let daysToAdd = targetDay - currentDay;
              
              // If it includes "הבא" (next) or "הקרוב" (upcoming), add 7 days
              if (dateStr.includes('הבא') || dateStr.includes('הקרוב')) {
                daysToAdd += 7;
              } 
              // If it's the same day but we've passed it, or it's a past day, go to next week
              else if (daysToAdd <= 0) {
                daysToAdd += 7;
              }
              
              eventDate.setDate(today.getDate() + daysToAdd);
            }
          }
          // Handle "tomorrow" and "today"
          else if (dateStr.includes('tomorrow')) {
            eventDate.setDate(today.getDate() + 1);
          }
          else if (dateStr.includes('today')) {
            // Already set to today
          }
          
          console.log(`Parsed date "${dateStr}" to: ${eventDate.toISOString()}`);
        }
        
        // Parse the time
        if (eventDetails.time) {
          const timeStr = eventDetails.time.toLowerCase();
          
          // Extract hours and minutes
          let hours = 0;
          let minutes = 0;
          
          // Handle "HH:MM" format
          const timeMatch = timeStr.match(/(\d{1,2})(?::(\d{2}))?/);
          if (timeMatch) {
            hours = parseInt(timeMatch[1]);
            minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
            
            // Handle AM/PM
            if (timeStr.includes('pm') && hours < 12) {
              hours += 12;
            } else if (timeStr.includes('am') && hours === 12) {
              hours = 0;
            }
            
            eventDate.setHours(hours, minutes, 0, 0);
          }
          
          console.log(`Parsed time "${timeStr}" to: ${eventDate.toISOString()}`);
        } else {
          // Default to 8:00 AM if no time specified
          eventDate.setHours(8, 0, 0, 0);
        }
        
        // Format the date for iCalendar
        startDate = eventDate.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        
        // End date is 1 hour after start date (9:00 AM if no time was specified)
        const endEventDate = new Date(eventDate.getTime() + 60 * 60 * 1000);
        endDate = endEventDate.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        
        console.log(`Event start: ${startDate}, end: ${endDate}`);
      }
    } catch (error) {
      console.error('Error parsing event date/time:', error);
      // Use default values (current time) if parsing fails
    }
    
    // Create the iCalendar content
    return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//WhatsApp-Me//Event//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
BEGIN:VEVENT
DTSTAMP:${now}
DTSTART:${startDate}
DTEND:${endDate}
SUMMARY:${eventDetails.title || 'Event'}
DESCRIPTION:${(eventDetails.description || eventDetails.summary || 'Event').replace(/\n/g, '\\n')}
LOCATION:${eventDetails.location || ''}
UID:${eventId}
STATUS:CONFIRMED
SEQUENCE:0
TRANSP:TRANSPARENT
END:VEVENT
END:VCALENDAR`;
  }

  private resetSession(): void {
    try {
      console.log('Resetting WhatsApp session...');
      console.log('Session reset complete. Attempting to reuse existing session data.');
      // Check if session already exists
      this.checkExistingSession();
    } catch (error) {
      console.error('Error resetting session:', error);
    }
  }

  private checkExistingSession(): void {
    const sessionPath = path.join(this.sessionDir, 'session', 'Default', 'Local Storage', 'leveldb');
    this.isExistingSession = fs.existsSync(sessionPath) && fs.readdirSync(sessionPath).length > 0;
    
    if (this.isExistingSession) {
      console.log('Found existing WhatsApp session. Will attempt to reuse it.');
    } else {
      console.log('No existing session found. You will need to scan a QR code to authenticate.');
    }
  }

  public async initialize(): Promise<void> {
    try {
      console.log('Initializing WhatsApp client...');
      
      // Find Chrome path before initializing client
      this.chromePath = await this.findChromePath();
      
      // Initialize client with Chrome path
      this.initializeClient(this.chromePath);
      
      console.log('Starting WhatsApp client...');
      if (this.isExistingSession) {
        console.log('Attempting to restore previous session...');
      } else {
        console.log('New session will be created. Please scan the QR code when prompted.');
      }
      
      let initAttempts = 0;
      const maxInitAttempts = 3;
      
      while (initAttempts < maxInitAttempts) {
        try {
          await this.client.initialize();
          // If we get here, initialization was successful
          break;
        } catch (error: any) {
          initAttempts++;
          console.error(`Error during client initialization (attempt ${initAttempts}/${maxInitAttempts}):`, error.message);
          
          // Check for specific error messages
          const errorMessage = error.message || '';
          const isBrowserLaunchError = errorMessage.includes('Failed to launch the browser process');
          const isLockError = errorMessage.includes('SingletonLock');
          
          if ((isBrowserLaunchError || isLockError) && initAttempts < maxInitAttempts) {
            console.log('Browser launch failed. Waiting before trying again...');
            
            // Wait a bit before retrying
            console.log(`Waiting 5 seconds before retry ${initAttempts}/${maxInitAttempts}...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Reinitialize the client
            this.initializeClient(this.chromePath);
          } else if (this.isExistingSession && initAttempts < maxInitAttempts) {
            // If we're trying to use an existing session and it's failing, try again
            console.log('Failed to restore previous session. Trying again...');
            this.initializeClient(this.chromePath);
          } else if (initAttempts >= maxInitAttempts) {
            // If we've reached max attempts, throw the error
            throw new Error(`Failed to initialize client after ${maxInitAttempts} attempts: ${error.message}`);
          } else {
            // For other errors, just throw
            throw error;
          }
        }
      }
      
      // Wait for client to be ready with timeout
      if (!this.isReady) {
        console.log('Waiting for client to be ready...');
        
        // Set a timeout to check if QR code was displayed
        const qrCheckTimeout = setTimeout(() => {
          if (!this.qrCodeDisplayed && !this.isReady && !this.isExistingSession) {
            console.log('\nNo QR code was displayed. This might indicate a connection issue.');
            console.log('Try restarting the application or check your internet connection.');
          }
        }, 30000); // 30 second timeout
        
        await Promise.race([
          new Promise<void>((resolve) => {
            const checkReady = setInterval(() => {
              if (this.isReady) {
                clearInterval(checkReady);
                clearTimeout(qrCheckTimeout);
                resolve();
              }
            }, 1000);
          }),
          new Promise<void>((_, reject) => {
            setTimeout(() => {
              clearTimeout(qrCheckTimeout);
              reject(new Error('Timeout waiting for client to be ready'));
            }, 120000); // 2 minute timeout
          })
        ]);
      }
    } catch (error) {
      console.error('Error initializing client:', error);
      throw error;
    }
  }

  private async waitForClientReady(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (this.isReady) {
        resolve(true);
        return;
      }
      
      const checkInterval = setInterval(() => {
        if (this.isReady) {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          resolve(true);
        }
      }, 1000);
      
      const timeout = setTimeout(() => {
        clearInterval(checkInterval);
        console.log('Timeout waiting for client to be ready');
        resolve(false);
      }, timeoutMs);
    });
  }

  public startListeningForMessages(): void {
    console.log('\nListening for all WhatsApp messages and analyzing for events.');
    console.log(`Event summaries will be sent to the "${this.targetGroupName}" WhatsApp group if found.`);
    console.log('Messages will be displayed in the format: [time] [group_name] [YOU] contact_name: message');
    console.log('Press Ctrl+C to exit.\n');
  }
} 