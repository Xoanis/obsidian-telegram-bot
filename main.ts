import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { Bot, type Context, InlineKeyboard, GrammyError, HttpError } from "grammy";
import { Message, type File } from 'grammy/types';
import { type FileFlavor, hydrateFiles } from "@grammyjs/files";

import * as path from 'path';
import * as fs from 'fs';

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

	constructor(app: App, bot: Bot, chat_id: string, vault_path: string, download_path: string) {
		console.log("TelegramBotAdapter:constructor")
		this._app = app;
		this._bot = bot;
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
				let processed_before = false;
				for (let i = 0; i < items.length; i++) {
					const element = items[i];
					const reply = await element.handler(processed_before);
					processed_before = processed_before || reply.processed;
					if (reply.answer) {
						ctx.reply(`*${element.unit}:*\n${this.esc(reply.answer)}`, {
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
					const reply = await element.handler(obsidian_file, processed_before, caption);
					processed_before = processed_before || reply.processed;
					if (reply.answer) {
						ctx.reply(`*${element.unit}:*\n${self.esc(reply.answer)}`, {
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
				
				let processed_before = false;

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
				let processed_before = false;
				for (let i = 0; i < this._text_handlers.length; i++) {
					const element = this._text_handlers[i];
					const reply = await element.handler(text, processed_before);
					processed_before = processed_before || reply.processed;
					if (reply.answer) {
						ctx.reply(`*${element.unit}:*\n${this.esc(reply.answer)}`, {
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
		await this._bot.api.sendMessage(this._chat_id, this.esc(text), {
			parse_mode: 'MarkdownV2'			
		});
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
			new Notice("Set a valid bot token and restart plugin")
			console.warn("bot token is not set or not valid");
			return;
		}

		await this.resetBot();
		console.log("TelegramBotPlugin succesfully loaded");
	}

	async resetBot() {
		this.shutdownBot();

		type FileFlavorContext = FileFlavor<Context>;
		this._bot = new Bot<FileFlavorContext>(this.settings.botToken);
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

		console.log(adapter.getBasePath())

		this._api = new TelegramBotAdapter(this.app, this._bot, this.settings.chatId, adapter.getBasePath(), this.settings.downloadPath);

		this.registerEvent(this.app.vault.on('create', (file) => {
			console.log('a new file has entered the arena')
			console.log(file);
		}));

		this._bot.start();
	}

	shutdownBot() {		
		if (this._bot && this._bot.isRunning()) {
			this._bot.stop();
		} 
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
			.setDesc('bot token')
			.addText(text => text
				.setPlaceholder('bot token')
				.setValue(this.plugin.settings.botToken)
				.onChange(async (value) => {
					this.plugin.settings.botToken = value;
					await this.plugin.saveSettings();
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
