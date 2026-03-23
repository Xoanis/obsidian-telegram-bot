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

export type TelegramMessageHandler = (
	message: TelegramMessageContext,
	processed_before: boolean,
) => Promise<HandlerResult>;

export interface ITelegramBotPluginAPIv1 {
	addCommandHandler(cmd: string, handler: CommandHandler, unit_name: string): void;
	addTextHandler(handler: TextHandler, unit_name: string): void;
	addFileHandler(handler: FileHandler, unit_name: string, mime_type?: string): void;

	sendMessage(text: string): Promise<void>;

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

	saveFileToVault(
		file: TelegramFileDescriptor,
		options: SaveTelegramFileOptions,
	): Promise<TFile>;

	sendMessage(text: string): Promise<void>;

	disposeHandlersForUnit(unit_name: string): void;
}
