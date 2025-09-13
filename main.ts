import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { Bot, type Context, InlineKeyboard, GrammyError, HttpError } from "grammy";
import { Message, type File } from 'grammy/types';
import { type FileFlavor, hydrateFiles } from "@grammyjs/files";

import * as path from 'path';
import * as fs from 'fs';

// Import Node.js modules for Electron environment
const https = require('https');
const http = require('http');

const moment = window.moment;

export interface FileX {
    /** Computes a URL from the `file_path` property of this file object. The
     * URL can be used to download the file contents.
     *
     * If you are using a local Bot API server, then this method will return the
     * file path that identifies the local file on your system.
     *
     * If the `file_path` of this file object is `undefined`, this method will
     * throw an error.
     *
     * Note that this method is installed by grammY on [the File
     * object](https://core.telegram.org/bots/api#file).
     */
    getUrl(): string;
    /**
     * This method will download the file from the Telegram servers and store it
     * under the given file path on your system. It returns the absolute path to
     * the created file, so this may be the same value as the argument to the
     * function.
     *
     * If you omit the path argument to this function, then a temporary file
     * will be created for you. This path will still be returned, hence giving
     * you access to the downloaded file.
     *
     * If you are using a local Bot API server, then the local file will be
     * copied over to the specified path, or to a new temporary location.
     *
     * If the `file_path` of this file object is `undefined`, this method will
     * throw an error.
     *
     * Note that this method is installed by grammY on [the File
     * object](https://core.telegram.org/bots/api#file).
     *
     * @param path Optional path to store the file (default: temporary file)
     * @returns An absolute file path to the downloaded/copied file
     */
    download(path?: string): Promise<string>;
    /**
     * This method will fetch the file URL and return an async iterator which
     * yields every time a new chunk of data is read.
     *
     * If the `file_path` of this file object is `undefined`, this method will
     * throw an error.
     *
     * @example
     * ```ts
     *  bot.on([":video", ":animation"], async (ctx) => {
     *      // Prepare file for download
     *      const file = await ctx.getFile();
     *      // Print the size of each chunk
     *      for await (const chunk of file) {
     *        console.log(`Read ${chunk.length} bytes`);
     *      }
     *  });
     * ```
     *
     * @returns Async iterator for the received data
     */
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
}

type GrammyFile = File & FileX;

// Node.js-based Telegram API client to bypass browser limitations
class NodeTelegramAPI {
	private token: string;

	constructor(token: string) {
		this.token = token;
	}

	makeRequest(method: string, data?: any): Promise<any> {
		return new Promise((resolve, reject) => {
			const url = `https://api.telegram.org/bot${this.token}/${method}`;
			const postData = data ? JSON.stringify(data) : '';
			
			const options = {
				method: data ? 'POST' : 'GET',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(postData),
					'User-Agent': 'Obsidian-Telegram-Bot-Plugin/1.0'
				}
			};

			const req = https.request(url, options, (res: any) => {
				let responseData = '';
				res.on('data', (chunk: any) => {
					responseData += chunk;
				});
				res.on('end', () => {
					try {
						const result = JSON.parse(responseData);
						if (result.ok) {
							resolve(result.result);
						} else {
							reject(new Error(`Telegram API error: ${result.error_code} - ${result.description}`));
						}
					} catch (parseError) {
						reject(new Error(`Failed to parse response: ${responseData}`));
					}
				});
			});

			req.on('error', (error: any) => {
				reject(error);
			});

			if (postData) {
				req.write(postData);
			}
			req.end();
		});
	}

	async getMe(): Promise<any> {
		return this.makeRequest('getMe');
	}

	async sendMessage(chatId: string, text: string, options?: any): Promise<any> {
		return this.makeRequest('sendMessage', {
			chat_id: chatId,
			text: text,
			...options
		});
	}
}

interface TelegramBotPluginSettings {
	botToken: string;
	chatId: string;
	downloadPath: string;
}

const DEFAULT_SETTINGS: TelegramBotPluginSettings = {
	botToken: '',
	chatId: '',
	downloadPath: '',
}

type Reply = string | null;
type HandlerResult = {
	processed: boolean;
	answer: Reply;
};
type CommandHandler = (processed_before: boolean) => Promise<HandlerResult>;
type TextHandler = (text: string, processed_before: boolean) => Promise<HandlerResult>;
type FileHandler = (file: TFile, processed_before: boolean, caption?: string) => Promise<HandlerResult>;

interface ITelegramBotPluginAPIv1 {
	addCommandHandler(cmd: string, handler: CommandHandler, unit_name: string): void;
	addTextHandler(handler: TextHandler, unit_name: string): void;
	addFileHandler(handler: FileHandler, unit_name: string, mime_type?:string): void;

	sendMessage(text: string): Promise<void>;
	
}
 

class TelegramBotAdapter implements ITelegramBotPluginAPIv1 {
	private _app: App;
	private _bot: Bot;
	private _nodeAPI: NodeTelegramAPI;
	private readonly _chat_id: string;
	private readonly _vault_path: string;
	private readonly _download_path: string;
	private _command_handlers: Map<string,{ handler: CommandHandler, unit: string }[]>;
	private _text_handlers: { handler: TextHandler, unit: string }[];
	private _file_handlers: Map<string, { handler: FileHandler, unit: string}[]>;

	private esc(text: string): string {
		return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
	}

	private getFileMimeType(msg: Message): string | undefined {
		if (msg.document) {
			return msg.document.mime_type;
		} else if (msg.animation) {
			return msg.animation.mime_type;
		} else if (msg.audio) {
			return msg.audio.mime_type;
		} else if (msg.photo) {
			return "image/jpeg";
		} else if (msg.video) {
			return msg.video.mime_type;
		} else if (msg.voice) {
			return msg.voice.mime_type;
		} else if (msg.video_note) {
			return "video/mp4";
		} else {
			return undefined;
		}		
	}

	private isGrammyFile(file: any): file is GrammyFile {
		return file && typeof file.download === 'function';
	}

	constructor(app: App, bot: Bot, nodeAPI: NodeTelegramAPI, chat_id: string, vault_path: string, download_path: string) {
		console.log("TelegramBotAdapter:constructor")
		this._app = app;
		this._bot = bot;
		this._nodeAPI = nodeAPI;
		this._chat_id = chat_id
		this._vault_path = vault_path;
		this._download_path = download_path;
		this._command_handlers = new Map();
		this._text_handlers = [];
		this._file_handlers = new Map();

		this._bot.on("::bot_command", async (ctx: Context) => {
			console.log("TelegramBotAdapter ::bot_command")
			try {
				if (String(ctx.chatId) !== this._chat_id) {
					return;
				}
				const cmd = ctx.message?.text?.slice(1);
				console.log("TelegramBotAdapter: cmd=",cmd)
				if (!cmd) {
					console.error("No cmd")
					return;
				} 

				const items = this._command_handlers.get(cmd);
				if (!items) {
					console.log(`There are no handlers for command ${cmd}`)
					return;
				}
				let processed_before: boolean = false;
				for (let i = 0; i < items.length; i++) {
					const element = items[i];
					const reply: HandlerResult = await element.handler(processed_before);
					processed_before = processed_before || reply.processed;
					if (reply.answer) {
						ctx.reply(`*${this.esc(element.unit)}:*\n${this.esc(reply.answer)}`, {
							parse_mode: "MarkdownV2"
						});
					}					
				}

			} catch (error) {
				console.error(`Unexpected error: ${error}`)
    			await ctx.reply('❌ Internal error');
			}
		});

		this._bot.on("message:file", async (ctx: Context) => {

			async function handle(self: TelegramBotAdapter, specific_handlers: { handler: FileHandler; unit: string; }[], obsidian_file: TFile, caption: string | undefined, processed_before: boolean) {
				for (let i = 0; i < specific_handlers.length; i++) {
					const element = specific_handlers[i];
					const reply: HandlerResult = await element.handler(obsidian_file, processed_before, caption);
					processed_before = processed_before || reply.processed;
					if (reply.answer) {
						ctx.reply(`*${self.esc(element.unit)}:*\n${self.esc(reply.answer)}`, {
							parse_mode: "MarkdownV2"
						});
					}
				}
				return processed_before;
			}

			try {
				if (String(ctx.chatId) !== this._chat_id) {
					return;
				}

				if (!ctx.msg) {
					console.error("Message is undefined");
					return;
				}
				const msg = ctx.msg;
				const mime_type = this.getFileMimeType(msg);
				console.log(`mime type: ${mime_type}`)

				if (!mime_type) {
					console.error("Can't determine mime type of a file");
					return;
				}

				const specific_handlers = this._file_handlers.get(mime_type);
				const all_files_handlers = this._file_handlers.get('');

				if (!specific_handlers && !all_files_handlers) {
					console.log(`There are no handlers for file with type ${mime_type}`);
					return;
				}

				const caption = ctx.message?.caption;
				const file = await ctx.getFile();
				if (!this.isGrammyFile(file)) {
					throw TypeError("type of file should be FileX");
				}
				const file_name = moment().format('YYYY-MM-DD-HH-mm-ss-') + file.file_path?.replace(/\//g, '-')
				const download_dir = path.join(this._vault_path, this._download_path);
				if (!fs.existsSync(download_dir)) {
					fs.mkdirSync(download_dir, { recursive: true });
				}
  				const download_path = await file.download(path.join(this._vault_path,  this._download_path, file_name));
				const path_in_vault = download_path.slice(this._vault_path.length+1).replace(/\\/g,'/');
				const obsidian_file = this._app.vault.getFileByPath(path_in_vault);

				if (!obsidian_file) {
					throw TypeError(`Couldn't get file ${path_in_vault} from vault`);
				}
				
				let processed_before: boolean = false;

				if (specific_handlers) {
					processed_before = await handle(this, specific_handlers, obsidian_file, caption, processed_before);
				}

				if (all_files_handlers) {
					processed_before = await handle(this, all_files_handlers, obsidian_file, caption, processed_before);
				}

			} catch (error) {
				console.error(`Unexpected error: ${error}`)
    			await ctx.reply('❌ Internal error');
			}
		});

		this._bot.on("message:text", async (ctx: Context) => {
			try {
				if (String(ctx.chatId) !== this._chat_id) {
					return;
				}
				const text = ctx.message?.text!;
				console.log("TelegramBotAdapter: message:text=",text)
				if (this._text_handlers.length === 0) {
					console.log(`There are no handlers for text messages`)
					return;
				}
				let processed_before: boolean = false;
				for (let i = 0; i < this._text_handlers.length; i++) {
					const element = this._text_handlers[i];
					const reply: HandlerResult = await element.handler(text, processed_before);
					processed_before = processed_before || reply.processed;
					if (reply.answer) {
						ctx.reply(`*${this.esc(element.unit)}:*\n${this.esc(reply.answer)}`, {
							parse_mode: "MarkdownV2"
						});
					}					
				}
			} catch (error) {
				console.error(`Unexpected error: ${error}`)
    			await ctx.reply('❌ Internal error');
			}
		});
	}
	
	addCommandHandler(cmd: string, handler: CommandHandler, unit_name: string): void {
		const item_to_add = {handler: handler, unit: unit_name};
		if (this._command_handlers.has(cmd)) {
			this._command_handlers.get(cmd)?.push(item_to_add);
			return;
		}
		this._command_handlers.set(cmd, [ item_to_add ]);		
	}

	addTextHandler(handler: TextHandler, unit_name: string): void {
		this._text_handlers.push({handler: handler, unit: unit_name});		
	}

	addFileHandler(handler: FileHandler, unit_name: string, mime_type?: string): void {
		const item_to_add = {handler: handler, unit: unit_name};

		if (!mime_type) {
			mime_type = '';
		}

		if (this._file_handlers.has(mime_type)) {
			this._file_handlers.get(mime_type)?.push(item_to_add);
			return;
		}
		this._file_handlers.set(mime_type, [ item_to_add ]);

		console.log(this._file_handlers)
	}

	async sendMessage(text: string): Promise<void> {
		try {
			// Use Node.js API instead of Grammy to avoid browser limitations
			await this._nodeAPI.sendMessage(this._chat_id, this.esc(text), {
				parse_mode: 'MarkdownV2'
			});
		} catch (error) {
			console.error('Failed to send message via Node.js API:', error);
			// Fallback to Grammy if Node.js API fails
			await this._bot.api.sendMessage(this._chat_id, this.esc(text), {
				parse_mode: 'MarkdownV2'
			});
		}
	}
} 


export default class TelegramBotPlugin extends Plugin {
	settings: TelegramBotPluginSettings;
	private _bot: Bot;
	private _api: TelegramBotAdapter;

	public getAPIv1(): ITelegramBotPluginAPIv1 {
		return this._api;
	}

	async onload() {
		console.log("TelegramBotPlugin startup...");
		await this.loadSettings();
		this.addSettingTab(new TelegramBotSettingTab(this.app, this));

		if (!this.settings.botToken) {
			new Notice("Telegram Bot: Please set a valid bot token in settings and restart the plugin");
			console.warn("Bot token is not set");
			return;
		}

		if (!this.isValidBotToken(this.settings.botToken)) {
			new Notice("Telegram Bot: Invalid bot token format. Please check your token in settings.");
			console.warn("Bot token format is invalid");
			return;
		}

		await this.resetBot();
		console.log("TelegramBotPlugin succesfully loaded");
	}

	async resetBot() {
		this.shutdownBot();
		
		// Wait a bit longer to ensure any existing polling is fully stopped
		await new Promise(resolve => setTimeout(resolve, 1000));

		// Trim and validate bot token format
		const trimmedToken = this.settings.botToken.trim();
		if (trimmedToken !== this.settings.botToken) {
			console.log('Trimming whitespace from bot token');
			this.settings.botToken = trimmedToken;
			await this.saveSettings();
		}
		
		if (!this.isValidBotToken(this.settings.botToken)) {
			new Notice("Invalid bot token format. Please check your bot token in settings.");
			console.error("Invalid bot token format:", this.settings.botToken ? "[REDACTED]" : "[EMPTY]");
			return;
		}

		type FileFlavorContext = FileFlavor<Context>;
		
		// Try creating bot with minimal configuration
		console.log('Creating Grammy bot instance...');
		this._bot = new Bot<FileFlavorContext>(this.settings.botToken);
		console.log('Bot created with default config');
		
		console.log('Bot instance created, token starts with:', this.settings.botToken.substring(0, 15) + '...');
		
		// Configure bot to handle webhook cleanup properly
		console.log('Configuring bot for long polling...');
		
		// Override global fetch to use Node.js for Telegram API
		const nodeAPI = new NodeTelegramAPI(this.settings.botToken);
		(global as any).fetch = async (url: string, options?: any) => {
			if (url.includes('api.telegram.org')) {
				const method = url.split('/').pop() || '';
				const data = options?.body ? JSON.parse(options.body) : undefined;
				const result = await nodeAPI.makeRequest(method, data);
				return { 
					ok: true, 
					status: 200,
					json: async () => ({ ok: true, result }),
					text: async () => JSON.stringify({ ok: true, result })
				} as Response;
			}
			return fetch(url, options);
		};
		
		this._bot.api.config.use(hydrateFiles(this._bot.token));

		this._bot.command("start", async (ctx: Context) => {
			try {
				if (this.settings.chatId === String(ctx.chatId)) {
					ctx.reply(`Already working! `);
					return;
				}
				if (this.settings.chatId !== "") {
					console.warn("This bot discoverd by ");
					console.warn(ctx.from);
					return;
				}
				this.settings.chatId = String(ctx.chatId!);
				await this.saveSettings();
				ctx.reply(`Hi, ${ctx.from?.first_name}! Ready to work with you 😎`)
			} catch (error) {
				console.error(`Unexpected error: ${error}`)
			}
		});

		let adapter = this.app.vault.adapter;
		
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new TypeError('this.app.vault.adapter should be instanceof FileSystemAdapter!');
		}

		try {
			console.log('Starting Telegram bot authentication...');
			console.log('Bot ID from token:', this.settings.botToken.split(':')[0]);
			console.log('Token length:', this.settings.botToken.length);
			
			// Test authentication with the Grammy API proxy (now using Node.js)
			console.log('Testing authentication with Grammy API proxy (Node.js backend)...');
			
			try {
				const botInfo = await this._bot.api.getMe();
				console.log('Grammy API proxy authentication successful!', {
					id: botInfo.id,
					username: botInfo.username,
					first_name: botInfo.first_name
				});
				
				// Now start Grammy bot (should work since API calls are proxied to Node.js)
				console.log('Starting Grammy bot with conflict handling...');
				
				// Create adapter with Node.js API for reliable messaging
				const nodeAPI = new NodeTelegramAPI(this.settings.botToken);
				this._api = new TelegramBotAdapter(this.app, this._bot, nodeAPI, this.settings.chatId, adapter.getBasePath(), this.settings.downloadPath);
				
				// Handle potential 409 conflicts by cleaning up webhooks first
				try {
					console.log('Cleaning up any existing webhooks...');
					await nodeAPI.makeRequest('deleteWebhook');
					console.log('Webhook cleanup successful');
				} catch (webhookError) {
					console.log('Webhook cleanup not needed or failed:', webhookError.message);
				}
				
				// Start bot with retry logic for 409 conflicts
				let retryCount = 0;
				const maxRetries = 3;
				
				while (retryCount < maxRetries) {
					try {
						await this._bot.start();
						console.log("Telegram bot started successfully!");
						new Notice('Telegram bot connected successfully!');
						break;
					} catch (startError) {
						if (startError instanceof GrammyError && startError.error_code === 409) {
							retryCount++;
							console.log(`Bot conflict detected (409). Retry ${retryCount}/${maxRetries} after delay...`);
							
							if (retryCount < maxRetries) {
								// Wait longer before retry
								await new Promise(resolve => setTimeout(resolve, 2000 * retryCount));
								continue;
							} else {
								throw new Error('Failed to start bot after multiple retries due to conflicts. Please ensure no other bot instances are running.');
							}
						} else {
							throw startError;
						}
					}
				} 
				
			} catch (proxyError) {
				console.error('Grammy API proxy authentication failed:', proxyError);
				throw proxyError;
			}
		} catch (error) {
			console.error('Bot start error details:', error);
			
			// Check if it's a Grammy-specific error
			if (error instanceof GrammyError) {
				console.log('GrammyError details:', {
					error_code: error.error_code,
					description: error.description,
					method: error.method,
					parameters: error.parameters
				});
				
				if (error.error_code === 401) {
					new Notice(`Bot authentication failed: ${error.description || 'Invalid token'}`);
					console.error("401 Unauthorized Details:", {
						token_format_valid: this.isValidBotToken(this.settings.botToken),
						token_id: this.settings.botToken.split(':')[0],
						api_method: error.method
					});
				} else if (error.error_code === 409) {
					new Notice(`Bot conflict: ${error.description}. Another bot instance may be running. Please wait and try restarting.`);
					console.error("409 Conflict Details:", {
						description: error.description,
						method: error.method,
						suggestion: 'Wait for other bot instances to stop, then restart this plugin.'
					});
				} else if (error.error_code === 400) {
					new Notice(`Bad request: ${error.description}`);
				} else if (error.error_code === 429) {
					new Notice("Rate limited by Telegram. Please wait and try again.");
				} else {
					new Notice(`Telegram API error (${error.error_code}): ${error.description}`);
				}
			} else if (error instanceof HttpError) {
				new Notice("Network error connecting to Telegram. Check your internet connection.");
				console.error("HTTP Error details:", {
					message: error.message,
					error: error
				});
			} else if (error instanceof Error) {
				new Notice(`Bot initialization error: ${error.message}`);
				console.error("Generic error:", error.stack);
			} else {
				new Notice("Unknown error starting bot. Check console for details.");
				console.error("Unknown error type:", error);
			}
			this.shutdownBot();
		}
	}

	private isValidBotToken(token: string): boolean {
		if (!token || typeof token !== 'string') {
			console.log('Token validation failed: empty or not string');
			return false;
		}
		
		// Trim whitespace
		const trimmedToken = token.trim();
		if (trimmedToken !== token) {
			console.log('Token validation: found whitespace, trimming');
		}
		
		// Telegram bot tokens follow the format: {bot_id}:{bot_token}
		// bot_id is a number, bot_token is 34-35 characters of base64-like characters
		const tokenRegex = /^\d+:[A-Za-z0-9_-]{34,35}$/;
		const isValid = tokenRegex.test(trimmedToken);
		
		if (!isValid) {
			console.log('Token format validation failed');
			console.log('Token length:', trimmedToken.length);
			console.log('Contains colon:', trimmedToken.includes(':'));
			if (trimmedToken.includes(':')) {
				const parts = trimmedToken.split(':');
				console.log('Bot ID part:', parts[0], 'is number:', /^\d+$/.test(parts[0]));
				console.log('Token part length:', parts[1]?.length, 'expected: 34-35');
				console.log('Token part pattern:', /^[A-Za-z0-9_-]+$/.test(parts[1] || ''));
			}
		} else {
			console.log('Token validation passed');
		}
		
		return isValid;
	}

	shutdownBot() {		
		if (this._bot && this._bot.isRunning()) {
			console.log('Stopping existing bot instance...');
			this._bot.stop();
			console.log('Bot stopped successfully');
		}
		
		// Add a small delay to ensure the bot is fully stopped
		setTimeout(() => {
			console.log('Bot shutdown complete');
		}, 100);
	}

	onunload() {
		this.shutdownBot();
		console.log("TelegramBotPlugin unloaded");
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}


class TelegramBotSettingTab extends PluginSettingTab {
	plugin: TelegramBotPlugin;

	constructor(app: App, plugin: TelegramBotPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('bot token')
			.setDesc('bot token (format: 123456789:ABCdef1234567890...)')
			.addText(text => text
				.setPlaceholder('bot token')
				.setValue(this.plugin.settings.botToken)
				.onChange(async (value) => {
					this.plugin.settings.botToken = value.trim();
					await this.plugin.saveSettings();
				}));
				
		new Setting(containerEl)
			.setName('Restart Bot')
			.setDesc('Click to restart the bot after changing settings')
			.addButton(button => button
				.setButtonText('Restart Bot')
				.onClick(async () => {
					try {
						await this.plugin.resetBot();
						new Notice('Bot restarted successfully');
					} catch (error) {
						new Notice('Failed to restart bot. Check console for details.');
						console.error('Failed to restart bot:', error);
					}
				}));
		new Setting(containerEl)
			.setName('Download files path')
			.setDesc('Folder where to download files sending from bot users')
			.addText(text => text
				.setPlaceholder('some/path/in/your/vault')
				.setValue(this.plugin.settings.downloadPath)
				.onChange(async (value) => {
					this.plugin.settings.downloadPath = value;
					await this.plugin.saveSettings();
				}));
	}
}
