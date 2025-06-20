import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WAMessageKey,
  getContentType,
  isJidGroup,
  jidNormalizedUser,
  WAMessage,
  Browsers
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as fs from 'fs';
import * as path from 'path';
import * as qrcode from 'qrcode-terminal';
import { OpenAIService, EventDetails } from './openai-service';

interface WASocketType {
  ev: any;
  sendMessage: any;
  groupMetadata: any;
  sendPresenceUpdate: any;
  end: any;
  logout: any;
  requestPairingCode?: any;
  authState: any;
  user: any;
}

export class WhatsAppClient {
  private socket: WASocketType | null = null;
  private isReady: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 3;
  private readonly sessionDir = '.baileys_auth';
  private openaiService: OpenAIService;
  private targetGroupName: string = 'אני'; // The target group to send summaries to
  private targetGroupId: string | null = null;
  private shouldReconnect: boolean = true;
  private connectionState: string = 'close';

  constructor() {
    this.openaiService = new OpenAIService();
    
    // Ensure session directory exists
    this.ensureSessionDir();
  }

  private ensureSessionDir(): void {
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  private async createSocket(): Promise<void> {
    try {
      console.log('Creating WhatsApp socket...');
      
      // Initialize auth state
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
      
      // Create the socket
      this.socket = makeWASocket({
        auth: state,
        browser: Browsers.ubuntu('WhatsApp Event Detection'),
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        fireInitQueries: true,
        generateHighQualityLinkPreview: false,
        getMessage: async (key: WAMessageKey) => {
          // Return empty message for now - could be enhanced with message store
          return { conversation: '' } as any;
        }
      });

      this.setupEventListeners(saveCreds);
      
    } catch (error) {
      console.error('Error creating WhatsApp socket:', error);
      throw error;
    }
  }

  private setupEventListeners(saveCreds: () => void): void {
    if (!this.socket) return;

    // Handle connection updates
    this.socket.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log('QR Code received. Please scan with your WhatsApp mobile app.');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        this.connectionState = 'close';
        this.isReady = false;
        
        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('Connection closed due to:', lastDisconnect?.error, ', reconnecting:', shouldReconnect);
        
        if (shouldReconnect && this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          console.log(`Attempting to reconnect... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
          
          // Wait before reconnecting
          await new Promise(resolve => setTimeout(resolve, 5000));
          await this.createSocket();
        } else if (!shouldReconnect) {
          console.log('Logged out. Please restart the application and scan QR code again.');
        } else {
          console.log('Max reconnection attempts reached. Please restart the application.');
        }
      } else if (connection === 'open') {
        this.connectionState = 'open';
        this.isReady = true;
        this.reconnectAttempts = 0;
        console.log('WhatsApp connection opened successfully!');
        
        // Find the target group when connection is established
        await this.findTargetGroup();
      } else if (connection === 'connecting') {
        this.connectionState = 'connecting';
        console.log('Connecting to WhatsApp...');
      }
    });

    // Handle credential updates
    this.socket.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    this.socket.ev.on('messages.upsert', async (messageUpdate: any) => {
      const { messages, type } = messageUpdate;
      
      if (type !== 'notify') return;
      
      for (const message of messages) {
        await this.handleIncomingMessage(message);
      }
    });

    // Handle group updates
    this.socket.ev.on('groups.update', async (updates: any[]) => {
      for (const update of updates) {
        if (update.subject && !this.targetGroupId) {
          // Check if this is our target group
          if (update.subject === this.targetGroupName) {
            this.targetGroupId = update.id;
            console.log(`Found target group "${this.targetGroupName}" with ID: ${this.targetGroupId}`);
          }
        }
      }
    });

    // Handle chats update
    this.socket.ev.on('chats.upsert', async (chats: any[]) => {
      // Look for our target group in new chats
      for (const chat of chats) {
        if (isJidGroup(chat.id) && chat.name === this.targetGroupName && !this.targetGroupId) {
          this.targetGroupId = chat.id;
          console.log(`Found target group "${this.targetGroupName}" with ID: ${this.targetGroupId}`);
        }
      }
    });
  }

  private async handleIncomingMessage(message: WAMessage): Promise<void> {
    try {
      // Skip if message is from self or has no content
      if (message.key.fromMe || !message.message) return;

      const messageType = getContentType(message.message);
      if (!messageType || messageType !== 'conversation' && messageType !== 'extendedTextMessage') {
        return; // Only process text messages for now
      }

      // Extract message text
      let messageText = '';
      if (messageType === 'conversation') {
        messageText = message.message.conversation || '';
      } else if (messageType === 'extendedTextMessage') {
        messageText = message.message.extendedTextMessage?.text || '';
      }

      if (!messageText.trim()) return;

      // Skip messages that are event summaries to avoid loops
      if (messageText.includes('Event Summary:') || messageText.includes('Event details')) {
        return;
      }

      const chatId = message.key.remoteJid!;
      const isGroup = isJidGroup(chatId);
      const timestamp = new Date().toLocaleTimeString();
      
      let chatName = '';
      let contactName = 'Unknown';

      // Get chat and contact information
      try {
        if (isGroup) {
          const groupMetadata = await this.socket!.groupMetadata(chatId);
          chatName = groupMetadata.subject || 'Unknown Group';
          
          // Find the participant who sent the message
          const participant = groupMetadata.participants.find((p: any) => 
            jidNormalizedUser(p.id) === jidNormalizedUser(message.key.participant || ''));
          contactName = participant?.notify || participant?.id?.split('@')[0] || 'Unknown';
        } else {
          chatName = chatId.split('@')[0];
          contactName = chatName;
        }
      } catch (error) {
        console.error('Error getting chat/contact info:', error);
      }

      // Log the message
      console.log(`\n--------------------------------`);
      console.log(`[${timestamp}] ${isGroup ? `[${chatName}]` : ''} ${contactName}: ${messageText}`);

      // Add message to history for this chat
      this.openaiService.addMessageToHistory(chatId, messageText);

      // Analyze the message for events
      console.log(`Analyzing message for events...`);
      
      const analysis = await this.openaiService.analyzeMessage(
        chatId,
        messageText,
        chatName,
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
          const sourceChatInfo = isGroup ? 
            `Group: ${chatName}` : 
            `Contact: ${contactName}`;

          const summaryMessage = `Event Summary:\n\n${analysis.summary}\n\nSource: ${sourceChatInfo}`;

          // Send the text summary
          await this.sendMessageToGroup(this.targetGroupId, summaryMessage);
          console.log(`Event summary sent to "${this.targetGroupName}" group`);

          // If we have complete event details, also send a calendar event
          if (analysis.title && analysis.startDateISO) {
            await this.sendEventToGroup(this.targetGroupId, analysis);
          }
        } else {
          console.log(`Target group "${this.targetGroupName}" not found. Event summary not sent.`);
        }
      }

    } catch (error) {
      console.error('Error handling incoming message:', error);
    }
  }

  private async findTargetGroup(): Promise<void> {
    if (!this.socket || !this.isReady) return;

    try {
      console.log(`Looking for target group: "${this.targetGroupName}"`);
      
      // We'll rely on the chats.upsert and groups.update events to find the group
      // This is more efficient than querying all groups
      
      // Set a timeout to log if group is not found
      setTimeout(() => {
        if (!this.targetGroupId) {
          console.log(`Target group "${this.targetGroupName}" not found yet. Make sure the bot is added to the group.`);
        }
      }, 10000);

    } catch (error) {
      console.error('Error finding target group:', error);
    }
  }

  private async sendMessageToGroup(groupId: string, message: string): Promise<void> {
    if (!this.socket || !this.isReady) {
      console.error('WhatsApp socket not ready');
      return;
    }

    try {
      await this.socket.sendMessage(groupId, { text: message });
    } catch (error) {
      console.error('Error sending message to group:', error);
    }
  }

  private async sendEventToGroup(groupId: string, eventDetails: EventDetails): Promise<void> {
    if (!this.socket || !this.isReady) {
      console.error('WhatsApp socket not ready');
      return;
    }

    try {
      // Create a detailed event message
      const eventMessage = this.formatEventMessage(eventDetails);
      
      // Send the event details
      await this.socket.sendMessage(groupId, { text: eventMessage });
      
      // Send VCF calendar file if we have complete event details
      if (eventDetails.title && eventDetails.startDateISO) {
        const vCalendarContent = this.createEventVCalendar(eventDetails);
        const filename = `event_${Date.now()}.ics`;
        
        // For now, we'll send the calendar as text
        // In a full implementation, you could save to file and send as document
        await this.socket.sendMessage(groupId, { 
          text: `📅 Calendar Event:\n\n${vCalendarContent}` 
        });
      }

    } catch (error) {
      console.error('Error sending event to group:', error);
    }
  }

  private formatEventMessage(eventDetails: EventDetails): string {
    let eventMessage = `📅 **Event Details:**\n\n`;
    
    if (eventDetails.title) {
      eventMessage += `**Title:** ${eventDetails.title}\n`;
    }
    
    if (eventDetails.date) {
      eventMessage += `**Date:** ${eventDetails.date}\n`;
    }
    
    if (eventDetails.time) {
      eventMessage += `**Time:** ${eventDetails.time}\n`;
    }
    
    if (eventDetails.location) {
      eventMessage += `**Location:** ${eventDetails.location}\n`;
    }
    
    if (eventDetails.description) {
      eventMessage += `**Description:** ${eventDetails.description}\n`;
    }
    
    if (eventDetails.startDateISO) {
      eventMessage += `**Start (ISO):** ${eventDetails.startDateISO}\n`;
    }
    
    if (eventDetails.endDateISO) {
      eventMessage += `**End (ISO):** ${eventDetails.endDateISO}\n`;
    }
    
    return eventMessage;
  }

  private createEventVCalendar(eventDetails: EventDetails): string {
    const now = new Date();
    const dtstamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const uid = `event-${Date.now()}@whatsapp-bot`;
    
    let vcalendar = 'BEGIN:VCALENDAR\n';
    vcalendar += 'VERSION:2.0\n';
    vcalendar += 'PRODID:-//WhatsApp Event Bot//EN\n';
    vcalendar += 'BEGIN:VEVENT\n';
    vcalendar += `UID:${uid}\n`;
    vcalendar += `DTSTAMP:${dtstamp}\n`;
    
    if (eventDetails.startDateISO) {
      const startDate = new Date(eventDetails.startDateISO);
      const dtstart = startDate.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      vcalendar += `DTSTART:${dtstart}\n`;
    }
    
    if (eventDetails.endDateISO) {
      const endDate = new Date(eventDetails.endDateISO);
      const dtend = endDate.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      vcalendar += `DTEND:${dtend}\n`;
    }
    
    if (eventDetails.title) {
      vcalendar += `SUMMARY:${eventDetails.title.replace(/\n/g, '\\n')}\n`;
    }
    
    if (eventDetails.description) {
      vcalendar += `DESCRIPTION:${eventDetails.description.replace(/\n/g, '\\n')}\n`;
    }
    
    if (eventDetails.location) {
      vcalendar += `LOCATION:${eventDetails.location.replace(/\n/g, '\\n')}\n`;
    }
    
    vcalendar += 'END:VEVENT\n';
    vcalendar += 'END:VCALENDAR';
    
    return vcalendar;
  }

  public async initialize(): Promise<void> {
    try {
      console.log('Initializing WhatsApp client...');
      await this.createSocket();
      
      // Wait for connection to be established
      let attempts = 0;
      const maxAttempts = 60; // 60 seconds timeout
      
      while (!this.isReady && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
        
        if (attempts % 10 === 0) {
          console.log(`Waiting for WhatsApp connection... (${attempts}s)`);
        }
      }
      
      if (!this.isReady) {
        throw new Error('Failed to establish WhatsApp connection within timeout period');
      }
      
      console.log('WhatsApp client initialized successfully!');
      
    } catch (error) {
      console.error('Error initializing WhatsApp client:', error);
      throw error;
    }
  }

  public startListeningForMessages(): void {
    if (!this.isReady) {
      console.error('WhatsApp client is not ready. Please initialize first.');
      return;
    }
    
    console.log('Started listening for messages...');
    console.log('The bot will now monitor all conversations for event-related discussions.');
    console.log(`Event summaries will be sent to the "${this.targetGroupName}" group when detected.`);
  }

  public async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    
    if (this.socket) {
      try {
        await this.socket.logout();
      } catch (error) {
        console.error('Error during logout:', error);
      }
    }
    
    this.isReady = false;
    this.socket = null;
    console.log('WhatsApp client disconnected.');
  }

  public isConnected(): boolean {
    return this.isReady && this.connectionState === 'open';
  }

  public getConnectionState(): string {
    return this.connectionState;
  }
} 