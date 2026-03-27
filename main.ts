import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath, requestUrl } from 'obsidian';
import { Bot, type Context, InlineKeyboard } from "grammy";
import { Message, type File } from 'grammy/types';
import { type FileFlavor, hydrateFiles } from "@grammyjs/files";

import * as path from 'path';
import * as fs from 'fs';
import { escapeTelegramMarkdownV2 } from './src/utils/telegram-markdown.js';
import {
	ITelegramBotPluginAPIv1,
	ITelegramBotPluginAPIv2,
	CommandHandler,
	HandlerResult,
	TextHandler,
	FileHandler,
	TelegramMessageContext,
	TelegramMessageHandler,
	TelegramFileDescriptor,
	SaveTelegramFileOptions,
	TelegramCallbackContext,
	TelegramCallbackHandler,
	TelegramFocusedInputHandler,
	InputFocusState,
	SetInputFocusOptions,
	TelegramCallbackPayload,
	SendMessageOptions,
	SendDocumentOptions,
	SendFileOptions,
	SendPhotoOptions,
	SendAudioOptions,
	SendVideoOptions,
	SendAnimationOptions,
	SendVoiceOptions,
	SendVideoNoteOptions,
	TelegramMediaGroupItem,
	TelegramLocation,
	SendLocationOptions,
	SentTelegramMessageRef,
	TelegramOutboundFile,
} from './telegram_plugin_api';

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

interface LegacyCommandEnvelope {
	type: 'command';
	command: string;
	args: string;
}

interface LegacyTextEnvelope {
	type: 'text';
	text: string;
}

interface LegacyFileEnvelope {
	type: 'file';
	mimeType: string;
	caption?: string;
	getFile: () => Promise<TFile>;
}

type LegacyEnvelope = LegacyCommandEnvelope | LegacyTextEnvelope | LegacyFileEnvelope;

interface TelegramEventEnvelope {
	message: TelegramMessageContext;
	legacy?: LegacyEnvelope;
}

interface StoredFocusState extends InputFocusState {
}

interface OutboundBinaryFile {
	fileName: string;
	bytes: Uint8Array;
}

const DEFAULT_SETTINGS: TelegramBotPluginSettings = {
	botToken: '',
	chatId: '',
	downloadPath: '',
}

class TelegramBotAdapter implements ITelegramBotPluginAPIv1, ITelegramBotPluginAPIv2 {
	private _app: App;
	private _bot: Bot;
	private readonly _download_path: string;
	private readonly _get_chat_id: () => string;
	private _command_handlers: Map<string,{ handler: CommandHandler, unit: string }[]>;
	private _text_handlers: { handler: TextHandler, unit: string }[];
	private _file_handlers: Map<string, { handler: FileHandler, unit: string}[]>;
	private _message_handlers: { handler: TelegramMessageHandler, unit: string }[];
	private _callback_handlers: { handler: TelegramCallbackHandler, unit: string }[];
	private _focused_input_handlers: { handler: TelegramFocusedInputHandler, unit: string }[];
	private _input_focus: StoredFocusState | null;

	private esc(text: string): string {
		return escapeTelegramMarkdownV2(text);
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

	private mimeTypeMatches(pattern: string, mimeType: string): boolean {
		if (pattern === mimeType) {
			return true;
		}

		const [patternType, patternSubType] = pattern.split('/');
		const [type, subType] = mimeType.split('/');

		if (!patternType || !patternSubType || !type || !subType) {
			return false;
		}

		// Support both "type/*" and "*/*" wildcard patterns.
		if (patternType === '*' && patternSubType === '*') {
			return true;
		}

		if (patternType === type && patternSubType === '*') {
			return true;
		}

		return false;
	}

	private isGrammyFile(file: any): file is GrammyFile {
		return file && typeof file.download === 'function';
	}

	constructor(app: App, bot: Bot, get_chat_id: () => string, download_path: string) {
		console.log("TelegramBotAdapter:constructor")
		this._app = app;
		this._bot = bot;
		this._get_chat_id = get_chat_id;
		this._download_path = download_path;
		this._command_handlers = new Map();
		this._text_handlers = [];
		this._file_handlers = new Map();
		this._message_handlers = [];
		this._callback_handlers = [];
		this._focused_input_handlers = [];
		this._input_focus = null;

		this._bot.on("::bot_command", async (ctx: Context) => {
			console.log("TelegramBotAdapter ::bot_command")
			try {
				if (!this.isAuthorizedContext(ctx)) {
					return;
				}
				this.clearExpiredFocus();
				await this.clearInputFocus();
				const text = ctx.message?.text ?? "";
				const [cmd, ...cmdArgs] = text.slice(1).trim().split(/\s+/);
				const args = cmdArgs.join(" ");
				console.log("TelegramBotAdapter: cmd=", cmd, "args=", args);
				if (!cmd) {
					console.error("No cmd")
					return;
				} 

				await this.dispatchEnvelope(ctx, {
					message: this.toCommandMessageContext(ctx, cmd, args),
					legacy: {
						type: 'command',
						command: cmd,
						args: args,
					},
				});

			} catch (error) {
				console.error(`Unexpected error: ${error}`)
				await ctx.reply('❌ Internal error');
			}
		});

		this._bot.on("message:file", async (ctx: Context) => {
			try {
				if (!this.isAuthorizedContext(ctx)) {
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

				const caption = ctx.message?.caption;
				const descriptor = this.toFileDescriptor(msg, caption);
				const fileMessage = this.toFileMessageContext(msg, caption, descriptor);
				const focus = this.getValidFocus();
				if (focus && focus.mode !== 'next-text') {
					const processed = await this.dispatchFocusedInputHandlers(
						ctx,
						fileMessage,
						focus,
					);
					if (processed) {
						if (focus.mode !== 'session') {
							await this.clearInputFocus(focus.unitName);
						}
						return;
					}
				}
				let legacyFilePromise: Promise<TFile> | null = null;
				await this.dispatchEnvelope(ctx, {
					message: fileMessage,
					legacy: {
						type: 'file',
						mimeType: mime_type,
						caption: caption,
						getFile: async () => {
							if (!legacyFilePromise) {
								legacyFilePromise = this.downloadLegacyFile(descriptor);
							}
							return legacyFilePromise;
						},
					},
				});

			} catch (error) {
				console.error(`Unexpected error: ${error}`)
    			await ctx.reply('❌ Internal error');
			}
		});

		this._bot.on("message:text", async (ctx: Context) => {
			try {
				if (!this.isAuthorizedContext(ctx)) {
					return;
				}
				this.clearExpiredFocus();
				const text = ctx.message?.text!;
				if (text.trim().startsWith('/')) {
					return;
				}
				console.log("TelegramBotAdapter: message:text=",text)
				const focus = this.getValidFocus();
				if (focus) {
					const processed = await this.dispatchFocusedInputHandlers(
						ctx,
						this.toTextMessageContext(ctx, text),
						focus,
					);
					if (processed) {
						if (focus.mode !== 'session') {
							await this.clearInputFocus(focus.unitName);
						}
						return;
					}
				}
				await this.dispatchEnvelope(ctx, {
					message: this.toTextMessageContext(ctx, text),
					legacy: {
						type: 'text',
						text: text,
					},
				});
			} catch (error) {
				console.error(`Unexpected error: ${error}`)
				await ctx.reply('❌ Internal error');
			}
		});

		this._bot.on("callback_query:data", async (ctx: Context) => {
			try {
				if (!this.isAuthorizedContext(ctx)) {
					return;
				}
				this.clearExpiredFocus();
				const data = ctx.callbackQuery?.data;
				if (!data) {
					return;
				}

				const callback: TelegramCallbackContext = {
					messageId: ctx.callbackQuery.message?.message_id,
					callbackId: ctx.callbackQuery.id,
					data: data,
					raw: ctx.callbackQuery,
				};

				await this.dispatchCallbackHandlers(ctx, callback, false);
			} catch (error) {
				console.error(`Unexpected error: ${error}`);
				if (ctx.callbackQuery?.id) {
					await ctx.answerCallbackQuery({ text: '❌ Internal error' });
				}
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

	registerMessageHandler(handler: TelegramMessageHandler, unit_name: string): void {
		this._message_handlers.push({ handler: handler, unit: unit_name });
	}

	registerCallbackHandler(handler: TelegramCallbackHandler, unit_name: string): void {
		this._callback_handlers.push({ handler: handler, unit: unit_name });
	}

	registerFocusedInputHandler(handler: TelegramFocusedInputHandler, unit_name: string): void {
		this._focused_input_handlers.push({ handler: handler, unit: unit_name });
	}

	async setInputFocus(
		unit_name: string,
		options?: SetInputFocusOptions,
	): Promise<void> {
		const expiresAt = options?.expiresInMs
			? Date.now() + options.expiresInMs
			: undefined;
		this._input_focus = {
			unitName: unit_name,
			mode: options?.mode ?? 'next-text',
			context: options?.context,
			expiresAt: expiresAt,
		};
	}

	async clearInputFocus(unit_name?: string): Promise<void> {
		if (!this._input_focus) {
			return;
		}
		if (unit_name && this._input_focus.unitName !== unit_name) {
			return;
		}
		this._input_focus = null;
	}

	async getInputFocus(): Promise<InputFocusState | null> {
		this.clearExpiredFocus();
		return this._input_focus;
	}

	async saveFileToVault(
		file: TelegramFileDescriptor,
		options: SaveTelegramFileOptions,
	): Promise<TFile> {
		const telegramFile = await this._bot.api.getFile(file.fileId) as GrammyFile;
		if (!this.isGrammyFile(telegramFile)) {
			throw new TypeError("Couldn't hydrate Telegram file for download");
		}

		const normalizedFolder = normalizePath(options.folder);
		await this.ensureVaultFolder(normalizedFolder);
		const fileName = options.fileName?.trim() || file.suggestedName;
		const pathInVault = await this.resolveVaultPath(
			normalizedFolder,
			fileName,
			options.conflictStrategy ?? 'rename',
		);
		const fileBytes = await this.downloadTelegramFile(telegramFile, file.suggestedName);
		return this._app.vault.createBinary(pathInVault, fileBytes);
	}

	async sendMessage(
		text: string,
		options?: SendMessageOptions,
	): Promise<SentTelegramMessageRef> {
		const chatId = this.getAuthorizedChatIdOrThrow();

		const message = await this._bot.api.sendMessage(chatId, this.esc(text), {
			parse_mode: 'MarkdownV2',
			reply_markup: this.buildInlineKeyboard(options?.inlineKeyboard),
		});
		return { messageId: message.message_id };
	}

	async sendDocument(
		file: TelegramOutboundFile,
		options?: SendDocumentOptions,
	): Promise<SentTelegramMessageRef> {
		return this.sendOutboundMedia(
			'sendDocument',
			'document',
			file,
			options?.fileName,
			this.buildOutboundMediaFields(
				options?.caption,
				options?.inlineKeyboard,
				{
					disable_content_type_detection: options?.disableContentTypeDetection,
				},
			),
		);
	}

	async sendFile(
		file: TelegramOutboundFile,
		options?: SendFileOptions,
	): Promise<SentTelegramMessageRef> {
		return this.sendDocument(file, options);
	}

	async sendPhoto(
		file: TelegramOutboundFile,
		options?: SendPhotoOptions,
	): Promise<SentTelegramMessageRef> {
		try {
			return this.sendOutboundMedia(
				'sendPhoto',
				'photo',
				file,
				options?.fileName,
				this.buildOutboundMediaFields(
					options?.caption,
					options?.inlineKeyboard,
					{
						has_spoiler: options?.hasSpoiler,
					},
				),
			);
		} catch (error) {
			console.warn(
				`sendPhoto failed for ${this.describeOutboundFile(file, options?.fileName)}. Falling back to sendDocument. Reason: ${this.describeError(error)}`,
				error,
			);
			return this.sendOutboundMedia(
				'sendDocument',
				'document',
				file,
				options?.fileName,
				this.buildOutboundMediaFields(
					options?.caption,
					options?.inlineKeyboard,
				),
			);
		}
	}

	async sendAudio(
		file: TelegramOutboundFile,
		options?: SendAudioOptions,
	): Promise<SentTelegramMessageRef> {
		return this.sendOutboundMedia(
			'sendAudio',
			'audio',
			file,
			options?.fileName,
			this.buildOutboundMediaFields(
				options?.caption,
				options?.inlineKeyboard,
				{
					duration: options?.duration,
					performer: options?.performer,
					title: options?.title,
				},
			),
		);
	}

	async sendVideo(
		file: TelegramOutboundFile,
		options?: SendVideoOptions,
	): Promise<SentTelegramMessageRef> {
		return this.sendOutboundMedia(
			'sendVideo',
			'video',
			file,
			options?.fileName,
			this.buildOutboundMediaFields(
				options?.caption,
				options?.inlineKeyboard,
				{
					duration: options?.duration,
					width: options?.width,
					height: options?.height,
					supports_streaming: options?.supportsStreaming,
					has_spoiler: options?.hasSpoiler,
				},
			),
		);
	}

	async sendAnimation(
		file: TelegramOutboundFile,
		options?: SendAnimationOptions,
	): Promise<SentTelegramMessageRef> {
		return this.sendOutboundMedia(
			'sendAnimation',
			'animation',
			file,
			options?.fileName,
			this.buildOutboundMediaFields(
				options?.caption,
				options?.inlineKeyboard,
				{
					duration: options?.duration,
					width: options?.width,
					height: options?.height,
					has_spoiler: options?.hasSpoiler,
				},
			),
		);
	}

	async sendVoice(
		file: TelegramOutboundFile,
		options?: SendVoiceOptions,
	): Promise<SentTelegramMessageRef> {
		return this.sendOutboundMedia(
			'sendVoice',
			'voice',
			file,
			options?.fileName,
			this.buildOutboundMediaFields(
				options?.caption,
				options?.inlineKeyboard,
				{
					duration: options?.duration,
				},
			),
		);
	}

	async sendVideoNote(
		file: TelegramOutboundFile,
		options?: SendVideoNoteOptions,
	): Promise<SentTelegramMessageRef> {
		return this.sendOutboundMedia(
			'sendVideoNote',
			'video_note',
			file,
			options?.fileName,
			this.buildOutboundMediaFields(
				undefined,
				options?.inlineKeyboard,
				{
					duration: options?.duration,
					length: options?.length,
				},
			),
		);
	}

	async sendMediaGroup(
		items: TelegramMediaGroupItem[],
	): Promise<SentTelegramMessageRef[]> {
		if (items.length < 2 || items.length > 10) {
			throw new Error("Telegram media groups must contain from 2 to 10 items.");
		}

		const chatId = this.getAuthorizedChatIdOrThrow();
		const binaryItems = await Promise.all(
			items.map(async (item, index) => ({
				item,
				fileKey: `file${index}`,
				binaryFile: await this.createOutboundBinaryFile(item.file, item.fileName),
			})),
		);

		const formData = new FormData();
		formData.append('chat_id', chatId);
		formData.append(
			'media',
			JSON.stringify(binaryItems.map(({ item, fileKey }) => this.buildMediaGroupPayloadItem(item, fileKey))),
		);
		for (const { fileKey, binaryFile } of binaryItems) {
			formData.append(
				fileKey,
				new Blob([binaryFile.bytes]),
				binaryFile.fileName,
			);
		}

		const result = await this.callTelegramApiWithFormData<
			Array<{ message_id: number }>
		>('sendMediaGroup', formData);
		return result.map((message) => ({ messageId: message.message_id }));
	}

	async sendLocation(
		location: TelegramLocation,
		options?: SendLocationOptions,
	): Promise<SentTelegramMessageRef> {
		const chatId = this.getAuthorizedChatIdOrThrow();
		const message = await this._bot.api.sendLocation(
			chatId,
			location.latitude,
			location.longitude,
			{
				horizontal_accuracy: options?.horizontalAccuracy,
				live_period: options?.livePeriod,
				heading: options?.heading,
				proximity_alert_radius: options?.proximityAlertRadius,
				reply_markup: this.buildInlineKeyboard(options?.inlineKeyboard),
			},
		);
		return { messageId: message.message_id };
	}

	async editMessage(
		messageId: number,
		text: string,
		options?: SendMessageOptions,
	): Promise<void> {
		const chatId = this.getAuthorizedChatIdOrThrow();

		await this._bot.api.editMessageText(chatId, messageId, this.esc(text), {
			parse_mode: 'MarkdownV2',
			reply_markup: this.buildInlineKeyboard(options?.inlineKeyboard),
		});
	}

	async deleteMessage(messageId: number): Promise<void> {
		const chatId = this.getAuthorizedChatIdOrThrow();

		await this._bot.api.deleteMessage(chatId, messageId);
	}

	async answerCallbackQuery(callbackId: string, text?: string): Promise<void> {
		await this._bot.api.answerCallbackQuery(callbackId, text ? { text } : {});
	}

	encodeCallbackPayload(payload: TelegramCallbackPayload): string {
		return JSON.stringify(payload);
	}

	decodeCallbackPayload(data: string): TelegramCallbackPayload | null {
		try {
			const parsed = JSON.parse(data) as TelegramCallbackPayload;
			if (!parsed || typeof parsed.unit !== 'string' || typeof parsed.action !== 'string') {
				return null;
			}
			return parsed;
		} catch {
			return null;
		}
	}

	disposeHandlersForUnit(unit_name: string): void {
		console.log(`Disposing handlers for unit ${unit_name}`)
		for (const [cmd, handlers] of this._command_handlers.entries()) {
			this._command_handlers.set(cmd, handlers.filter(h => h.unit !== unit_name));
		}
		this._text_handlers = this._text_handlers.filter(h => h.unit !== unit_name);
		for (const [mime, handlers] of this._file_handlers.entries()) {
			this._file_handlers.set(mime, handlers.filter(h => h.unit !== unit_name));
		}
		this._message_handlers = this._message_handlers.filter(h => h.unit !== unit_name);
		this._callback_handlers = this._callback_handlers.filter(h => h.unit !== unit_name);
		this._focused_input_handlers = this._focused_input_handlers.filter(h => h.unit !== unit_name);
		if (this._input_focus?.unitName === unit_name) {
			this._input_focus = null;
		}
	}

	private isAuthorizedContext(ctx: Context): boolean {
		const chatId = this.getAuthorizedChatId();
		return chatId !== '' && String(ctx.chatId) === chatId;
	}

	private getAuthorizedChatId(): string {
		return this._get_chat_id().trim();
	}

	private getAuthorizedChatIdOrThrow(): string {
		const chatId = this.getAuthorizedChatId();
		if (!chatId) {
			throw new Error("Authorized chat is not configured.");
		}

		return chatId;
	}

	private clearExpiredFocus(): void {
		if (!this._input_focus?.expiresAt) {
			return;
		}
		if (this._input_focus.expiresAt <= Date.now()) {
			this._input_focus = null;
		}
	}

	private getValidFocus(): StoredFocusState | null {
		this.clearExpiredFocus();
		return this._input_focus;
	}

	private buildInlineKeyboardPayload(keyboard?: SendMessageOptions['inlineKeyboard']) {
		if (!keyboard || keyboard.length === 0) {
			return undefined;
		}

		return {
			inline_keyboard: keyboard.map((row) =>
				row.map((button) => ({
					text: button.text,
					callback_data: button.callbackData,
				})),
			),
		};
	}

	private buildInlineKeyboard(keyboard?: SendMessageOptions['inlineKeyboard']) {
		const payload = this.buildInlineKeyboardPayload(keyboard);
		if (!payload) {
			return undefined;
		}

		const inlineKeyboard = new InlineKeyboard();
		for (const row of payload.inline_keyboard) {
			for (const button of row) {
				inlineKeyboard.text(button.text, button.callback_data);
			}
			inlineKeyboard.row();
		}

		return inlineKeyboard;
	}

	private buildCaptionPayload(caption?: string): {
		caption?: string;
		parse_mode?: 'MarkdownV2';
	} {
		if (!caption) {
			return {};
		}

		return {
			caption: this.esc(caption),
			parse_mode: 'MarkdownV2',
		};
	}

	private buildOutboundMediaFields(
		caption?: string,
		inlineKeyboard?: SendMessageOptions['inlineKeyboard'],
		extraFields: Record<string, unknown> = {},
	): Record<string, unknown> {
		return {
			...this.buildCaptionPayload(caption),
			...extraFields,
			reply_markup: this.buildInlineKeyboardPayload(inlineKeyboard),
		};
	}

	private async createOutboundBinaryFile(
		file: TelegramOutboundFile,
		fileName?: string,
	): Promise<OutboundBinaryFile> {
		if (file instanceof TFile) {
			return this.createVaultBinaryFile(file, fileName);
		}

		if (typeof file === 'string') {
			return this.createVaultBinaryFile(this.requireVaultFile(file), fileName);
		}

		if (file instanceof Uint8Array) {
			return {
				bytes: file,
				fileName: this.resolveOutboundFileName(fileName),
			};
		}

		if (file instanceof ArrayBuffer) {
			return {
				bytes: new Uint8Array(file),
				fileName: this.resolveOutboundFileName(fileName),
			};
		}

		throw new TypeError("Unsupported outbound file payload.");
	}

	private async sendOutboundMedia(
		method: string,
		fieldName: string,
		file: TelegramOutboundFile,
		fileName: string | undefined,
		fields: Record<string, unknown>,
	): Promise<SentTelegramMessageRef> {
		const chatId = this.getAuthorizedChatIdOrThrow();
		const binaryFile = await this.createOutboundBinaryFile(file, fileName);
		return this.sendMultipartFileViaFetch(
			method,
			fieldName,
			chatId,
			binaryFile,
			fields,
		);
	}

	private async createVaultBinaryFile(
		file: TFile,
		fileName?: string,
	): Promise<OutboundBinaryFile> {
		const bytes = await this._app.vault.readBinary(file);
		return {
			bytes: new Uint8Array(bytes),
			fileName: this.resolveOutboundFileName(fileName, file.name),
		};
	}

	private requireVaultFile(pathInVault: string): TFile {
		const normalizedPath = normalizePath(pathInVault);
		const existing = this._app.vault.getAbstractFileByPath(normalizedPath);
		if (!(existing instanceof TFile)) {
			throw new Error(`Vault file not found: ${normalizedPath}`);
		}

		return existing;
	}

	private resolveOutboundFileName(
		fileName?: string,
		fallback?: string,
	): string {
		const normalized = fileName?.trim();
		if (normalized) {
			return normalized;
		}
		if (fallback) {
			return fallback;
		}

		throw new Error("fileName is required when sending raw binary data.");
	}

	private describeOutboundFile(
		file: TelegramOutboundFile,
		fileName?: string,
	): string {
		if (file instanceof TFile) {
			return file.path;
		}
		if (typeof file === 'string') {
			return file;
		}
		return fileName?.trim() || 'raw-binary-file';
	}

	private async sendMultipartFileViaFetch(
		method: string,
		fieldName: string,
		chatId: string,
		file: OutboundBinaryFile,
		fields: Record<string, unknown>,
	): Promise<SentTelegramMessageRef> {
		const formData = new FormData();
		formData.append('chat_id', chatId);
		formData.append(fieldName, new Blob([file.bytes]), file.fileName);
		this.appendFormDataFields(formData, fields);

		const result = await this.callTelegramApiWithFormData<{ message_id: number }>(
			method,
			formData,
		);
		return { messageId: result.message_id };
	}

	private buildMediaGroupPayloadItem(
		item: TelegramMediaGroupItem,
		fileKey: string,
	): Record<string, unknown> {
		const captionPayload = this.buildCaptionPayload(item.caption);

		switch (item.type) {
			case 'photo':
				return {
					type: 'photo',
					media: `attach://${fileKey}`,
					...captionPayload,
					has_spoiler: item.hasSpoiler,
				};
			case 'audio':
				return {
					type: 'audio',
					media: `attach://${fileKey}`,
					...captionPayload,
					duration: item.duration,
					performer: item.performer,
					title: item.title,
				};
			case 'video':
				return {
					type: 'video',
					media: `attach://${fileKey}`,
					...captionPayload,
					duration: item.duration,
					width: item.width,
					height: item.height,
					supports_streaming: item.supportsStreaming,
					has_spoiler: item.hasSpoiler,
				};
			case 'document':
				return {
					type: 'document',
					media: `attach://${fileKey}`,
					...captionPayload,
					disable_content_type_detection: item.disableContentTypeDetection,
				};
			default:
				throw new TypeError(`Unsupported media group item type: ${(item as { type: string }).type}`);
		}
	}

	private appendFormDataFields(
		formData: FormData,
		fields: Record<string, unknown>,
	): void {
		for (const [key, value] of Object.entries(fields)) {
			if (value === undefined || value === null) {
				continue;
			}

			if (typeof value === 'string') {
				formData.append(key, value);
				continue;
			}

			if (typeof value === 'number' || typeof value === 'boolean') {
				formData.append(key, String(value));
				continue;
			}

			formData.append(key, JSON.stringify(value));
		}
	}

	private async callTelegramApiWithFormData<T>(
		method: string,
		formData: FormData,
	): Promise<T> {
		const response = await fetch(
			`https://api.telegram.org/bot${this._bot.token}/${method}`,
			{
				method: 'POST',
				body: formData,
			},
		);

		let payload: { ok?: boolean; result?: T; description?: string } | null = null;
		try {
			payload = await response.json() as { ok?: boolean; result?: T; description?: string };
		} catch (error) {
			throw new Error(
				`Telegram API ${method} returned non-JSON response: ${this.describeError(error)}`,
			);
		}

		if (!response.ok || !payload?.ok || payload.result === undefined) {
			throw new Error(
				`Telegram API ${method} failed with HTTP ${response.status}: ${payload?.description ?? 'Unknown error'}`,
			);
		}

		return payload.result;
	}

	private async replyFromUnit(ctx: Context, unit: string, answer: string): Promise<void> {
		await ctx.reply(`*${this.esc(unit)}:*\n${this.esc(answer)}`, {
			parse_mode: "MarkdownV2"
		});
	}

	private async dispatchEnvelope(
		ctx: Context,
		envelope: TelegramEventEnvelope,
	): Promise<boolean> {
		if (envelope.legacy?.type === 'file') {
			const processedByLegacy = await this.dispatchLegacyHandlers(ctx, envelope.legacy, false);
			return this.dispatchMessageHandlers(
				ctx,
				envelope.message,
				processedByLegacy,
			);
		}

		let processed_before = await this.dispatchMessageHandlers(
			ctx,
			envelope.message,
			false,
		);

		if (!envelope.legacy) {
			return processed_before;
		}

		return this.dispatchLegacyHandlers(ctx, envelope.legacy, processed_before);
	}

	private async dispatchFocusedInputHandlers(
		ctx: Context,
		message: TelegramMessageContext,
		focus: StoredFocusState,
	): Promise<boolean> {
		const handlers = this._focused_input_handlers.filter(
			(item) => item.unit === focus.unitName,
		);
		if (handlers.length === 0) {
			return false;
		}

		let processed = false;
		for (let i = 0; i < handlers.length; i++) {
			const element = handlers[i];
			const reply = await element.handler(message, focus);
			processed = processed || reply.processed;
			if (reply.answer) {
				await this.replyFromUnit(ctx, element.unit, reply.answer);
			}
		}

		return processed;
	}

	private async dispatchMessageHandlers(
		ctx: Context,
		message: TelegramMessageContext,
		processed_before: boolean,
	): Promise<boolean> {
		for (let i = 0; i < this._message_handlers.length; i++) {
			const element = this._message_handlers[i];
			const reply = await element.handler(message, processed_before);
			processed_before = processed_before || reply.processed;
			if (reply.answer) {
				await this.replyFromUnit(ctx, element.unit, reply.answer);
			}
		}

		return processed_before;
	}

	private async dispatchCallbackHandlers(
		ctx: Context,
		callback: TelegramCallbackContext,
		processed_before: boolean,
	): Promise<boolean> {
		for (let i = 0; i < this._callback_handlers.length; i++) {
			const element = this._callback_handlers[i];
			const reply = await element.handler(callback, processed_before);
			processed_before = processed_before || reply.processed;
			if (reply.answer) {
				await this.answerCallbackQuery(callback.callbackId, reply.answer);
			}
		}

		if (!processed_before && callback.callbackId) {
			await this.answerCallbackQuery(callback.callbackId);
		}

		return processed_before;
	}

	private async dispatchLegacyHandlers(
		ctx: Context,
		legacy: LegacyEnvelope,
		processed_before: boolean,
	): Promise<boolean> {
		if (legacy.type === 'command') {
			return this.dispatchLegacyCommandHandlers(
				ctx,
				legacy.command,
				legacy.args,
				processed_before,
			);
		}

		if (legacy.type === 'text') {
			return this.dispatchLegacyTextHandlers(ctx, legacy.text, processed_before);
		}

		return this.dispatchLegacyFileHandlers(
			ctx,
			legacy.mimeType,
			legacy.getFile,
			legacy.caption,
			processed_before,
		);
	}

	private async dispatchLegacyCommandHandlers(
		ctx: Context,
		command: string,
		args: string,
		processed_before: boolean,
	): Promise<boolean> {
		const items = this._command_handlers.get(command);
		if (!items || items.length === 0) {
			console.log(`There are no handlers for command ${command}`);
			return processed_before;
		}

		for (let i = 0; i < items.length; i++) {
			const element = items[i];
			console.log(`Executing handler for command ${command} from unit ${element.unit}`);
			const reply: HandlerResult = await element.handler(args, processed_before);
			processed_before = processed_before || reply.processed;
			if (reply.answer) {
				await this.replyFromUnit(ctx, element.unit, reply.answer);
			}
			console.log(`Finished handler for command ${command} from unit ${element.unit}, processed_before=${processed_before}`);
		}

		return processed_before;
	}

	private async dispatchLegacyTextHandlers(
		ctx: Context,
		text: string,
		processed_before: boolean,
	): Promise<boolean> {
		if (this._text_handlers.length === 0) {
			console.log(`There are no handlers for text messages`);
			return processed_before;
		}

		for (let i = 0; i < this._text_handlers.length; i++) {
			const element = this._text_handlers[i];
			const reply: HandlerResult = await element.handler(text, processed_before);
			processed_before = processed_before || reply.processed;
			if (reply.answer) {
				await this.replyFromUnit(ctx, element.unit, reply.answer);
			}
		}

		return processed_before;
	}

	private async dispatchLegacyFileHandlers(
		ctx: Context,
		mimeType: string,
		getFile: () => Promise<TFile>,
		caption: string | undefined,
		processed_before: boolean,
	): Promise<boolean> {
		const exact_handlers = this._file_handlers.get(mimeType);
		const all_files_handlers = this._file_handlers.get('');
		const wildcard_handlers: { handler: FileHandler; unit: string }[] = [];

		for (const [pattern, handlers] of this._file_handlers.entries()) {
			if (!pattern || pattern === mimeType) {
				continue;
			}
			if (this.mimeTypeMatches(pattern, mimeType)) {
				wildcard_handlers.push(...handlers);
			}
		}

		if (!exact_handlers && wildcard_handlers.length === 0 && !all_files_handlers) {
			console.log(`There are no legacy file handlers for file with type ${mimeType}`);
			return processed_before;
		}

		const obsidian_file = await getFile();
		processed_before = await this.executeLegacyFileHandlers(
			ctx,
			exact_handlers,
			obsidian_file,
			caption,
			processed_before,
		);
		processed_before = await this.executeLegacyFileHandlers(
			ctx,
			wildcard_handlers,
			obsidian_file,
			caption,
			processed_before,
		);
		processed_before = await this.executeLegacyFileHandlers(
			ctx,
			all_files_handlers,
			obsidian_file,
			caption,
			processed_before,
		);

		return processed_before;
	}

	private async executeLegacyFileHandlers(
		ctx: Context,
		handlers: { handler: FileHandler; unit: string }[] | undefined,
		obsidian_file: TFile,
		caption: string | undefined,
		processed_before: boolean,
	): Promise<boolean> {
		if (!handlers || handlers.length === 0) {
			return processed_before;
		}

		for (let i = 0; i < handlers.length; i++) {
			const element = handlers[i];
			const reply = await element.handler(obsidian_file, processed_before, caption);
			processed_before = processed_before || reply.processed;
			if (reply.answer) {
				await this.replyFromUnit(ctx, element.unit, reply.answer);
			}
		}

		return processed_before;
	}

	private toCommandMessageContext(
		ctx: Context,
		cmd: string,
		args: string,
	): TelegramMessageContext {
		return {
			messageId: ctx.message?.message_id,
			date: ctx.message?.date,
			kind: 'command',
			text: ctx.message?.text,
			command: {
				name: cmd,
				args: args,
			},
			files: [],
			raw: ctx.msg,
		};
	}

	private toTextMessageContext(ctx: Context, text: string): TelegramMessageContext {
		return {
			messageId: ctx.message?.message_id,
			date: ctx.message?.date,
			kind: text.trim().startsWith('/') ? 'command' : 'text',
			text: text,
			files: [],
			raw: ctx.msg,
		};
	}

	private toFileMessageContext(
		msg: Message,
		caption: string | undefined,
		file: TelegramFileDescriptor,
	): TelegramMessageContext {
		return {
			messageId: msg.message_id,
			date: msg.date,
			kind: file.kind,
			text: caption,
			caption: caption,
			files: [file],
			raw: msg,
		};
	}

	private toFileDescriptor(
		msg: Message,
		caption: string | undefined,
	): TelegramFileDescriptor {
		if (msg.document) {
			return {
				fileId: msg.document.file_id,
				uniqueId: msg.document.file_unique_id,
				kind: 'document',
				mimeType: msg.document.mime_type,
				size: msg.document.file_size,
				suggestedName: msg.document.file_name ?? `document-${msg.message_id}`,
				caption: caption,
			};
		}
		if (msg.photo && msg.photo.length > 0) {
			const photo = msg.photo[msg.photo.length - 1];
			return {
				fileId: photo.file_id,
				uniqueId: photo.file_unique_id,
				kind: 'photo',
				mimeType: 'image/jpeg',
				size: photo.file_size,
				suggestedName: `photo-${msg.message_id}.jpg`,
				caption: caption,
			};
		}
		if (msg.voice) {
			return {
				fileId: msg.voice.file_id,
				uniqueId: msg.voice.file_unique_id,
				kind: 'voice',
				mimeType: msg.voice.mime_type,
				size: msg.voice.file_size,
				suggestedName: `voice-${msg.message_id}.${this.extensionFromMimeType(msg.voice.mime_type, 'ogg')}`,
				caption: caption,
			};
		}
		if (msg.video) {
			return {
				fileId: msg.video.file_id,
				uniqueId: msg.video.file_unique_id,
				kind: 'video',
				mimeType: msg.video.mime_type,
				size: msg.video.file_size,
				suggestedName: msg.video.file_name ?? `video-${msg.message_id}.${this.extensionFromMimeType(msg.video.mime_type, 'mp4')}`,
				caption: caption,
			};
		}
		if (msg.video_note) {
			return {
				fileId: msg.video_note.file_id,
				uniqueId: msg.video_note.file_unique_id,
				kind: 'video_note',
				mimeType: 'video/mp4',
				size: msg.video_note.file_size,
				suggestedName: `video-note-${msg.message_id}.mp4`,
				caption: caption,
			};
		}
		if (msg.audio) {
			return {
				fileId: msg.audio.file_id,
				uniqueId: msg.audio.file_unique_id,
				kind: 'audio',
				mimeType: msg.audio.mime_type,
				size: msg.audio.file_size,
				suggestedName: msg.audio.file_name ?? `audio-${msg.message_id}.${this.extensionFromMimeType(msg.audio.mime_type, 'mp3')}`,
				caption: caption,
			};
		}
		if (msg.animation) {
			return {
				fileId: msg.animation.file_id,
				uniqueId: msg.animation.file_unique_id,
				kind: 'animation',
				mimeType: msg.animation.mime_type,
				size: msg.animation.file_size,
				suggestedName: msg.animation.file_name ?? `animation-${msg.message_id}.${this.extensionFromMimeType(msg.animation.mime_type, 'gif')}`,
				caption: caption,
			};
		}

		throw new TypeError("Unsupported file message");
	}

	private extensionFromMimeType(mimeType: string | undefined, fallback: string): string {
		if (!mimeType || !mimeType.includes('/')) {
			return fallback;
		}

		const extension = mimeType.split('/')[1];
		return extension || fallback;
	}

	private async downloadLegacyFile(file: TelegramFileDescriptor): Promise<TFile> {
		return this.saveFileToVault(file, {
			folder: this._download_path,
			fileName: `${moment().format('YYYY-MM-DD-HH-mm-ss-')}${file.suggestedName.replace(/[\\/]/g, '-')}`,
			conflictStrategy: 'rename',
		});
	}

	private async ensureVaultFolder(folder: string): Promise<void> {
		if (!folder) {
			return;
		}

		let current = "";
		for (const part of folder.split('/')) {
			current = current ? `${current}/${part}` : part;
			if (!this._app.vault.getAbstractFileByPath(current)) {
				await this._app.vault.createFolder(current);
			}
		}
	}

	private async downloadTelegramFile(
		telegramFile: GrammyFile,
		suggestedName: string,
	): Promise<ArrayBuffer> {
		const errors: string[] = [];

		try {
			return await this.downloadTelegramFileViaFetch(telegramFile);
		} catch (error) {
			errors.push(`fetch download failed: ${this.describeError(error)}`);
			console.warn(`Telegram fetch download failed for ${suggestedName}:`, error);
		}

		try {
			return await this.downloadTelegramFileViaGrammY(telegramFile);
		} catch (error) {
			errors.push(`grammY download failed: ${this.describeError(error)}`);
			console.error(`Telegram grammY download failed for ${suggestedName}:`, error);
		}

		throw new Error(`Failed to download Telegram file "${suggestedName}". ${errors.join(' | ')}`);
	}

	private async downloadTelegramFileViaFetch(
		telegramFile: GrammyFile,
	): Promise<ArrayBuffer> {
		const url = telegramFile.getUrl();
		const response = await requestUrl({
			url,
			method: 'GET',
			throw: false,
		});
		if (response.status >= 400) {
			throw new Error(`HTTP ${response.status}`);
		}

		return response.arrayBuffer;
	}

	private async downloadTelegramFileViaGrammY(
		telegramFile: GrammyFile,
	): Promise<ArrayBuffer> {
		const tempPath = await telegramFile.download();
		try {
			const fileBuffer = await fs.promises.readFile(tempPath);
			return fileBuffer.buffer.slice(
				fileBuffer.byteOffset,
				fileBuffer.byteOffset + fileBuffer.byteLength,
			);
		} finally {
			await fs.promises.rm(path.dirname(tempPath), {
				recursive: true,
				force: true,
			});
		}
	}

	private describeError(error: unknown): string {
		const aggregate = this.asAggregateErrorLike(error);
		if (aggregate) {
			const nested = aggregate.errors
				.map((entry: unknown) => this.describeError(entry))
				.filter((entry) => entry.length > 0)
				.join('; ');
			return nested ? `${aggregate.message}: ${nested}` : aggregate.message;
		}
		if (error instanceof Error) {
			return error.message;
		}
		return String(error);
	}

	private asAggregateErrorLike(error: unknown): { message: string; errors: unknown[] } | null {
		if (!error || typeof error !== 'object') {
			return null;
		}

		const maybeAggregate = error as { message?: unknown; errors?: unknown };
		if (!Array.isArray(maybeAggregate.errors)) {
			return null;
		}

		return {
			message: typeof maybeAggregate.message === 'string' ? maybeAggregate.message : 'Aggregate error',
			errors: maybeAggregate.errors,
		};
	}

	private async resolveVaultPath(
		folder: string,
		fileName: string,
		conflictStrategy: 'rename' | 'replace' | 'error',
	): Promise<string> {
		const initialPath = normalizePath(folder ? `${folder}/${fileName}` : fileName);
		const existing = this._app.vault.getAbstractFileByPath(initialPath);
		if (!existing) {
			return initialPath;
		}
		if (conflictStrategy === 'error') {
			throw new Error(`File already exists: ${initialPath}`);
		}
		if (conflictStrategy === 'replace') {
			if (!(existing instanceof TFile)) {
				throw new Error(`Target path is not a file: ${initialPath}`);
			}
			await this._app.vault.delete(existing);
			return initialPath;
		}

		const extensionIndex = initialPath.lastIndexOf(".");
		const hasExtension = extensionIndex > initialPath.lastIndexOf("/");
		const base = hasExtension ? initialPath.slice(0, extensionIndex) : initialPath;
		const extension = hasExtension ? initialPath.slice(extensionIndex) : "";

		let counter = 1;
		let candidate = `${base} ${counter}${extension}`;
		while (this._app.vault.getAbstractFileByPath(candidate)) {
			counter += 1;
			candidate = `${base} ${counter}${extension}`;
		}
		return candidate;
	}
} 


export default class TelegramBotPlugin extends Plugin {
	settings: TelegramBotPluginSettings;
	private _bot: Bot;
	private _api: TelegramBotAdapter;

	public getAPIv1(): ITelegramBotPluginAPIv1 {
		return this._api;
	}

	public getAPIv2(): ITelegramBotPluginAPIv2 {
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

		this._api = new TelegramBotAdapter(
			this.app,
			this._bot,
			() => this.settings.chatId,
			this.settings.downloadPath,
		);
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
