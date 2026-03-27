export function escapeTelegramMarkdownV2(text) {
	return String(text).replace(/([\\_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}
