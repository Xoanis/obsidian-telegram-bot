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

export type TelegramOutboundFile = TFile | string | ArrayBuffer | Uint8Array;

export interface SendDocumentOptions extends SendMessageOptions {
	caption?: string;
	fileName?: string;
	disableContentTypeDetection?: boolean;
}

export interface SendPhotoOptions extends SendMessageOptions {
	caption?: string;
	fileName?: string;
	hasSpoiler?: boolean;
}

export interface SendAudioOptions extends SendMessageOptions {
	caption?: string;
	fileName?: string;
	duration?: number;
	performer?: string;
	title?: string;
}

export interface SendVideoOptions extends SendMessageOptions {
	caption?: string;
	fileName?: string;
	duration?: number;
	width?: number;
	height?: number;
	supportsStreaming?: boolean;
	hasSpoiler?: boolean;
}

export interface SendAnimationOptions extends SendMessageOptions {
	caption?: string;
	fileName?: string;
	duration?: number;
	width?: number;
	height?: number;
	hasSpoiler?: boolean;
}

export interface SendVoiceOptions extends SendMessageOptions {
	caption?: string;
	fileName?: string;
	duration?: number;
}

export interface SendVideoNoteOptions extends SendMessageOptions {
	fileName?: string;
	duration?: number;
	length?: number;
}

export interface TelegramMediaGroupBaseItem {
	file: TelegramOutboundFile;
	fileName?: string;
	caption?: string;
}

export interface TelegramPhotoGroupItem extends TelegramMediaGroupBaseItem {
	type: 'photo';
	hasSpoiler?: boolean;
}

export interface TelegramVideoGroupItem extends TelegramMediaGroupBaseItem {
	type: 'video';
	duration?: number;
	width?: number;
	height?: number;
	supportsStreaming?: boolean;
	hasSpoiler?: boolean;
}

export interface TelegramAudioGroupItem extends TelegramMediaGroupBaseItem {
	type: 'audio';
	duration?: number;
	performer?: string;
	title?: string;
}

export interface TelegramDocumentGroupItem extends TelegramMediaGroupBaseItem {
	type: 'document';
	disableContentTypeDetection?: boolean;
}

export type TelegramMediaGroupItem =
	| TelegramPhotoGroupItem
	| TelegramVideoGroupItem
	| TelegramAudioGroupItem
	| TelegramDocumentGroupItem;

export interface TelegramLocation {
	latitude: number;
	longitude: number;
}

export interface SendLocationOptions extends SendMessageOptions {
	horizontalAccuracy?: number;
	livePeriod?: number;
	heading?: number;
	proximityAlertRadius?: number;
}

export type SendFileOptions = SendDocumentOptions;

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
	sendDocument(
		file: TelegramOutboundFile,
		options?: SendDocumentOptions,
	): Promise<SentTelegramMessageRef>;
	sendFile(
		file: TelegramOutboundFile,
		options?: SendFileOptions,
	): Promise<SentTelegramMessageRef>;
	sendPhoto(
		file: TelegramOutboundFile,
		options?: SendPhotoOptions,
	): Promise<SentTelegramMessageRef>;
	sendAudio(
		file: TelegramOutboundFile,
		options?: SendAudioOptions,
	): Promise<SentTelegramMessageRef>;
	sendVideo(
		file: TelegramOutboundFile,
		options?: SendVideoOptions,
	): Promise<SentTelegramMessageRef>;
	sendAnimation(
		file: TelegramOutboundFile,
		options?: SendAnimationOptions,
	): Promise<SentTelegramMessageRef>;
	sendVoice(
		file: TelegramOutboundFile,
		options?: SendVoiceOptions,
	): Promise<SentTelegramMessageRef>;
	sendVideoNote(
		file: TelegramOutboundFile,
		options?: SendVideoNoteOptions,
	): Promise<SentTelegramMessageRef>;
	sendMediaGroup(
		items: TelegramMediaGroupItem[],
	): Promise<SentTelegramMessageRef[]>;
	sendLocation(
		location: TelegramLocation,
		options?: SendLocationOptions,
	): Promise<SentTelegramMessageRef>;

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

	sendDocument(
		file: TelegramOutboundFile,
		options?: SendDocumentOptions,
	): Promise<SentTelegramMessageRef>;

	sendFile(
		file: TelegramOutboundFile,
		options?: SendFileOptions,
	): Promise<SentTelegramMessageRef>;

	sendPhoto(
		file: TelegramOutboundFile,
		options?: SendPhotoOptions,
	): Promise<SentTelegramMessageRef>;

	sendAudio(
		file: TelegramOutboundFile,
		options?: SendAudioOptions,
	): Promise<SentTelegramMessageRef>;

	sendVideo(
		file: TelegramOutboundFile,
		options?: SendVideoOptions,
	): Promise<SentTelegramMessageRef>;

	sendAnimation(
		file: TelegramOutboundFile,
		options?: SendAnimationOptions,
	): Promise<SentTelegramMessageRef>;

	sendVoice(
		file: TelegramOutboundFile,
		options?: SendVoiceOptions,
	): Promise<SentTelegramMessageRef>;

	sendVideoNote(
		file: TelegramOutboundFile,
		options?: SendVideoNoteOptions,
	): Promise<SentTelegramMessageRef>;

	sendMediaGroup(
		items: TelegramMediaGroupItem[],
	): Promise<SentTelegramMessageRef[]>;

	sendLocation(
		location: TelegramLocation,
		options?: SendLocationOptions,
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
