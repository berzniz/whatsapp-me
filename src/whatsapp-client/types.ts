import makeWASocket, { type GroupMetadata } from "@whiskeysockets/baileys";

export type WASocketType = ReturnType<typeof makeWASocket>;

// Re-export Baileys GroupMetadata for convenience
export type { GroupMetadata };

export interface ChatInfo {
	chatName: string;
	contactName: string;
}
