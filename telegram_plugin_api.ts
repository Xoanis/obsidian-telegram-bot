import { TFile } from 'obsidian';

export type Reply = string | null;
export type HandlerResult = {
	processed: boolean;
	answer: Reply;
};
export type CommandHandler = (args: string, processed_before: boolean) => Promise<HandlerResult>;
export type TextHandler = (text: string, processed_before: boolean) => Promise<HandlerResult>;
export type FileHandler = (file: TFile, processed_before: boolean, caption?: string) => Promise<HandlerResult>;

export type TelegramMessageKind =
	| 'command'
	| 'text'
	| 'photo'
	| 'voice'
	| 'video'
	| 'video_note'
	| 'audio'
	| 'document'
	| 'animation'
	| 'mixed'
	| 'unknown';

export interface TelegramFileDescriptor {
	fileId: string;
	uniqueId?: string;
	kind: TelegramMessageKind;
	mimeType?: string;
	size?: number;
	suggestedName: string;
	caption?: string;
}

export interface TelegramCommandDescriptor {
	name: string;
	args: string;
}

export interface TelegramMessageContext {
	messageId?: number;
	date?: number;
	kind: TelegramMessageKind;
	text?: string;
	caption?: string;
	command?: TelegramCommandDescriptor;
	files: TelegramFileDescriptor[];
	raw: unknown;
}

export interface SaveTelegramFileOptions {
	folder: string;
	fileName?: string;
	conflictStrategy?: 'rename' | 'replace' | 'error';
}

export interface TelegramInlineButton {
	text: string;
	callbackData: string;
}

export type TelegramInlineKeyboard = TelegramInlineButton[][];

export interface SendMessageOptions {
	inlineKeyboard?: TelegramInlineKeyboard;
}

export interface SentTelegramMessageRef {
	messageId: number;
}

export interface TelegramCallbackContext {
	messageId?: number;
	callbackId: string;
	data: string;
	raw: unknown;
}

export interface TelegramCallbackPayload {
	unit: string;
	action: string;
	token?: string;
	data?: Record<string, string>;
}

export type InputFocusMode = 'next-text' | 'next-message' | 'session';

export interface InputFocusState {
	unitName: string;
	mode: InputFocusMode;
	context?: Record<string, unknown>;
	expiresAt?: number;
}

export interface SetInputFocusOptions {
	mode?: InputFocusMode;
	context?: Record<string, unknown>;
	expiresInMs?: number;
}

export type TelegramMessageHandler = (
	message: TelegramMessageContext,
	processed_before: boolean,
) => Promise<HandlerResult>;

export type TelegramCallbackHandler = (
	callback: TelegramCallbackContext,
	processed_before: boolean,
) => Promise<HandlerResult>;

export type TelegramFocusedInputHandler = (
	message: TelegramMessageContext,
	focus: InputFocusState,
) => Promise<HandlerResult>;

export interface ITelegramBotPluginAPIv1 {
	addCommandHandler(cmd: string, handler: CommandHandler, unit_name: string): void;
	addTextHandler(handler: TextHandler, unit_name: string): void;
	addFileHandler(handler: FileHandler, unit_name: string, mime_type?: string): void;

	sendMessage(text: string): Promise<SentTelegramMessageRef>;

	/**
	 * Removes all handlers (command, text, file) associated with the specified unit name.
	 * Call this when a unit is unloaded or no longer needs to handle Telegram events.
	 */
	disposeHandlersForUnit(unit_name: string): void;
}

export interface ITelegramBotPluginAPIv2 {
	registerMessageHandler(
		handler: TelegramMessageHandler,
		unit_name: string,
	): void;

	registerCallbackHandler(
		handler: TelegramCallbackHandler,
		unit_name: string,
	): void;

	registerFocusedInputHandler(
		handler: TelegramFocusedInputHandler,
		unit_name: string,
	): void;

	setInputFocus(
		unit_name: string,
		options?: SetInputFocusOptions,
	): Promise<void>;

	clearInputFocus(unit_name?: string): Promise<void>;

	getInputFocus(): Promise<InputFocusState | null>;

	saveFileToVault(
		file: TelegramFileDescriptor,
		options: SaveTelegramFileOptions,
	): Promise<TFile>;

	sendMessage(
		text: string,
		options?: SendMessageOptions,
	): Promise<SentTelegramMessageRef>;

	editMessage(
		messageId: number,
		text: string,
		options?: SendMessageOptions,
	): Promise<void>;

	deleteMessage(messageId: number): Promise<void>;

	answerCallbackQuery(callbackId: string, text?: string): Promise<void>;

	encodeCallbackPayload(payload: TelegramCallbackPayload): string;
	decodeCallbackPayload(data: string): TelegramCallbackPayload | null;

	disposeHandlersForUnit(unit_name: string): void;
}
