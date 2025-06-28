# Telegram Bot Plugin for Obsidian

![Obsidian](https://img.shields.io/badge/Obsidian-%23483699.svg?style=for-the-badge&logo=obsidian&logoColor=white)
![Telegram](https://img.shields.io/badge/Telegram-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white)

**Unified interface for Obsidian plugins to interact with Telegram**

This plugin provides a unified API that allows other Obsidian plugins to communicate through a single Telegram bot.

## Features

- 🚀 **Single entry point** for all Telegram-connected plugins
- 📁 **Automatic downloading** of files from Telegram to Obsidian vault
- 💬 **Support** for text messages, commands, and files

## Installation

1. Go to "Community plugins" in Obsidian settings
2. Search for "Telegram Bot Plugin"
3. Install the plugin
4. Enable the plugin

## Configuration

1. Get a bot token from [@BotFather](https://t.me/BotFather)
2. Open plugin settings in Obsidian
3. Enter your bot token
4. Specify download path for files (default: vault root)
5. Save settings
6. Send `/start` command to your bot in Telegram

## For Plugin Developers

Integrate Telegram capabilities into your plugin using our API:

```typescript
// Get API instance
const telegramAPI = app.plugins.plugins['telegram-bot']?.getAPIv1();

if (telegramAPI) {
  // Register command handler
  telegramAPI.addCommandHandler("mycmd", async (processedBefore) => {
    if (processedBefore) return { processed: false, answer: null };
    return { processed: true, answer: "Command processed!" };
  }, "my-plugin");

  // Register text handler
  telegramAPI.addTextHandler(async (text, processedBefore) => {
    if (text.includes("hello") && !processedBefore) {
      return { processed: true, answer: "Hi there!" };
    }
    return { processed: false, answer: null };
  }, "my-plugin");

  // Register file handler
  telegramAPI.addFileHandler(async (file, processedBefore, caption) => {
    if (file.extension === "pdf" && !processedBefore) {
      return { processed: true, answer: "PDF processed!" };
    }
    return { processed: false, answer: null };
  }, "my-plugin", "application/pdf");

  // Send messages
  telegramAPI.sendMessage("Notification from my plugin!");
}
```

### Available API Methods

```typescript
interface ITelegramBotPluginAPIv1 {
  // Register command handler
  addCommandHandler(
    cmd: string, 
    handler: (processedBefore: boolean) => Promise<HandlerResult>,
    unitName: string
  ): void;
  
  // Register text message handler
  addTextHandler(
    handler: (text: string, processedBefore: boolean) => Promise<HandlerResult>,
    unitName: string
  ): void;
  
  // Register file handler
  addFileHandler(
    handler: (file: TFile, processedBefore: boolean, caption?: string) => Promise<HandlerResult>,
    unitName: string,
    mimeType?: string
  ): void;
  
  // Send message to Telegram
  sendMessage(text: string): Promise<void>;
}
```

## Usage Examples

### Voice Message Transcription Plugin
```typescript
telegramAPI.addFileHandler(async (file, processed, caption) => {
  if (file.extension === "ogg" && !processed) {
    const transcript = await transcribeAudio(file);
    await createNote(transcript);
    return { processed: true, answer: "Voice message transcribed!" };
  }
  return { processed: false, answer: null };
}, "voice-notes", "audio/ogg");
```

### Notification Plugin
```typescript
telegramAPI.addCommandHandler("remind", async (processed) => {
  if (processed) return { processed: false, answer: null };
  
  // Reminder creation logic
  await createReminder();
  
  return { processed: true, answer: "Reminder set!" };
}, "reminder-plugin");
```

## Development & Contribution

Contributions are welcome! Here's how:

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

Distributed under the 0BSD license. See [LICENSE](LICENSE) for details.

---

**Note**: This plugin is under active development. The API may change between versions. It's recommended to pin the version when using in other plugins.