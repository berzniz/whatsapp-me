import makeWASocket, {
	useMultiFileAuthState,
	Browsers,
	DisconnectReason,
	type WAMessageKey,
	type BaileysEventMap,
	type GroupMetadata,
} from "@whiskeysockets/baileys";
import type { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import type { WASocketType } from "./types.js";
import type { WhatsAppConfig } from "./config.js";

export interface ConnectionState {
	isReady: boolean;
	isSynced: boolean;
	connectionState: string;
	reconnectAttempts: number;
	maxReconnectAttempts: number;
	shouldReconnect: boolean;
}

export class ConnectionManager {
	private socket: WASocketType | null = null;
	private config: WhatsAppConfig;
	private state: ConnectionState;
	private onConnectionOpen?: () => Promise<void>;
	private onConnectionClose?: () => Promise<void>;

	constructor(config: WhatsAppConfig) {
		this.config = config;
		this.state = {
			isReady: false,
			isSynced: false,
			connectionState: "close",
			reconnectAttempts: 0,
			maxReconnectAttempts: 3,
			shouldReconnect: true,
		};
	}

	public setConnectionOpenHandler(handler: () => Promise<void>): void {
		this.onConnectionOpen = handler;
	}

	public setConnectionCloseHandler(handler: () => Promise<void>): void {
		this.onConnectionClose = handler;
	}

	public getSocket(): WASocketType | null {
		return this.socket;
	}

	public getState(): ConnectionState {
		return { ...this.state };
	}

	public setReady(ready: boolean): void {
		this.state.isReady = ready;
	}

	public setSynced(synced: boolean): void {
		this.state.isSynced = synced;
	}

	public setConnectionState(state: string): void {
		this.state.connectionState = state;
	}

	public setShouldReconnect(should: boolean): void {
		this.state.shouldReconnect = should;
	}

	public async createSocket(
		groupCache: (jid: string) => GroupMetadata | undefined,
	): Promise<WASocketType> {
		try {
			console.log("Creating WhatsApp socket...");

			// Initialize auth state
			const { state, saveCreds } = await useMultiFileAuthState(
				this.config.sessionDir,
			);

			// Create a silent logger to suppress Baileys JSON logs
			const silentLogger = {
				level: "silent" as const,
				info: () => {},
				error: () => {},
				warn: () => {},
				debug: () => {},
				trace: () => {},
				fatal: () => {},
				child: () => silentLogger,
			};

			// Create the socket
			this.socket = makeWASocket({
				auth: state,
				browser: Browsers.ubuntu("WhatsApp Event Detection"),
				defaultQueryTimeoutMs: 60000,
				connectTimeoutMs: 60000,
				keepAliveIntervalMs: 10000,
				markOnlineOnConnect: false,
				syncFullHistory: false,
				fireInitQueries: true,
				generateHighQualityLinkPreview: false,
				logger: silentLogger,
				cachedGroupMetadata: async (jid) => groupCache(jid),
				getMessage: async (_key: WAMessageKey) => {
					// Return undefined for now - could be enhanced with message store
					return undefined;
				},
			});

			this.setupConnectionListeners(saveCreds);
			return this.socket;
		} catch (error) {
			console.error("Error creating WhatsApp socket:", error);
			throw error;
		}
	}

	private setupConnectionListeners(saveCreds: () => void): void {
		if (!this.socket) return;

		// Handle connection updates
		this.socket.ev.on(
			"connection.update",
			async (update: BaileysEventMap["connection.update"]) => {
				const { connection, lastDisconnect, qr } = update;

				if (qr) {
					console.log(
						"QR Code received. Please scan with your WhatsApp mobile app.",
					);
					qrcode.generate(qr, { small: true });
				}

				if (connection === "close") {
					this.state.connectionState = "close";
					this.state.isReady = false;
					this.state.isSynced = false;

					const shouldReconnect =
						(lastDisconnect?.error as Boom)?.output?.statusCode !==
						DisconnectReason.loggedOut;
					console.log(
						"Connection closed due to:",
						lastDisconnect?.error,
						", reconnecting:",
						shouldReconnect,
					);

					if (
						shouldReconnect &&
						this.state.shouldReconnect &&
						this.state.reconnectAttempts < this.state.maxReconnectAttempts
					) {
						this.state.reconnectAttempts++;
						console.log(
							`Attempting to reconnect... (${this.state.reconnectAttempts}/${this.state.maxReconnectAttempts})`,
						);

						// Wait before reconnecting
						await new Promise((resolve) => setTimeout(resolve, 5000));
						if (this.onConnectionClose) {
							await this.onConnectionClose();
						}
					} else if (!shouldReconnect) {
						console.log(
							"Logged out. Please restart the application and scan QR code again.",
						);
					} else {
						console.log(
							"Max reconnection attempts reached. Please restart the application.",
						);
					}
				} else if (connection === "open") {
					this.state.connectionState = "open";
					this.state.reconnectAttempts = 0;
					console.log("WhatsApp connection opened successfully!");

					// Perform full synchronization before marking as ready
					if (this.onConnectionOpen) {
						try {
							console.log("Starting full synchronization...");
							await this.onConnectionOpen();
							this.state.isSynced = true;
							this.state.isReady = true;
							console.log("Full synchronization completed successfully!");
						} catch (error) {
							console.error("Error during synchronization:", error);
							// Still mark as ready but log the error
							this.state.isReady = true;
							this.state.isSynced = false;
						}
					}
				} else if (connection === "connecting") {
					this.state.connectionState = "connecting";
					console.log("Connecting to WhatsApp...");
				}
			},
		);

		// Handle credential updates
		this.socket.ev.on("creds.update", saveCreds);
	}

	public async disconnect(): Promise<void> {
		this.state.shouldReconnect = false;

		if (this.socket) {
			try {
				await this.socket.logout();
			} catch (error) {
				console.error("Error during logout:", error);
			}
		}

		this.state.isReady = false;
		this.socket = null;
		console.log("WhatsApp client disconnected.");
	}
}
