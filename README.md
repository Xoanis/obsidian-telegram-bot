# Telegram Bot Plugin for Obsidian

![Obsidian](https://img.shields.io/badge/Obsidian-%23483699.svg?style=for-the-badge&logo=obsidian&logoColor=white)
![Telegram](https://img.shields.io/badge/Telegram-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white)

**Unified interface for Obsidian plugins to interact with Telegram**

This plugin provides a unified API that allows other Obsidian plugins to communicate through a single Telegram bot.

## Features

- 🚀 **Single entry point** for all Telegram-connected plugins
- 📁 **Automatic downloading** of files from Telegram to Obsidian vault
- 💬 **Support** for text messages, commands, and files
- 📤 **Outgoing media delivery** from other plugins to Telegram users

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
const telegramAPI = app.plugins.plugins['obsidian-telegram-bot-plugin']?.getAPIv1();

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

  // Send a vault document
  const report = app.vault.getAbstractFileByPath("Exports/report.pdf");
  if (report instanceof TFile) {
    await telegramAPI.sendDocument(report, {
      caption: "Latest report",
    });
  }

  // Send a photo
  const photo = app.vault.getAbstractFileByPath("Assets/cover.jpg");
  if (photo instanceof TFile) {
    await telegramAPI.sendPhoto(photo, {
      caption: "New cover",
    });
  }
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

  // Send document from vault path, TFile, or raw bytes
  sendDocument(
    file: TFile | string | ArrayBuffer | Uint8Array,
    options?: {
      caption?: string;
      fileName?: string;
      disableContentTypeDetection?: boolean;
      inlineKeyboard?: TelegramInlineKeyboard;
    }
  ): Promise<void>;

  // Backward-compatible alias for sendDocument
  sendFile(
    file: TFile | string | ArrayBuffer | Uint8Array,
    options?: {
      caption?: string;
      fileName?: string;
      inlineKeyboard?: TelegramInlineKeyboard;
    }
  ): Promise<void>;

  sendPhoto(file: TFile | string | ArrayBuffer | Uint8Array, options?: SendPhotoOptions): Promise<void>;
  sendAudio(file: TFile | string | ArrayBuffer | Uint8Array, options?: SendAudioOptions): Promise<void>;
  sendVideo(file: TFile | string | ArrayBuffer | Uint8Array, options?: SendVideoOptions): Promise<void>;
  sendAnimation(file: TFile | string | ArrayBuffer | Uint8Array, options?: SendAnimationOptions): Promise<void>;
  sendVoice(file: TFile | string | ArrayBuffer | Uint8Array, options?: SendVoiceOptions): Promise<void>;
  sendVideoNote(file: TFile | string | ArrayBuffer | Uint8Array, options?: SendVideoNoteOptions): Promise<void>;
  sendMediaGroup(items: TelegramMediaGroupItem[]): Promise<SentTelegramMessageRef[]>;
  sendLocation(
    location: { latitude: number; longitude: number },
    options?: SendLocationOptions
  ): Promise<void>;
}
```

### API v2

`ITelegramBotPluginAPIv2` adds a transport-oriented message model for plugins that need more control over Telegram payloads, especially files.

Highlights:

- one normalized message handler for commands, text, and files
- file descriptors are passed before anything is saved into the vault
- plugin decides where to persist the file
- `v1` remains available for backward compatibility

```typescript
interface ITelegramBotPluginAPIv2 {
  registerMessageHandler(
    handler: (
      message: TelegramMessageContext,
      processedBefore: boolean
    ) => Promise<HandlerResult>,
    unitName: string
  ): void;

  saveFileToVault(
    file: TelegramFileDescriptor,
    options: {
      folder: string;
      fileName?: string;
      conflictStrategy?: "rename" | "replace" | "error";
    }
  ): Promise<TFile>;

  sendMessage(text: string): Promise<void>;
  sendDocument(
    file: TFile | string | ArrayBuffer | Uint8Array,
    options?: SendDocumentOptions
  ): Promise<void>;
  sendFile(
    file: TFile | string | ArrayBuffer | Uint8Array,
    options?: SendDocumentOptions
  ): Promise<void>;
  sendPhoto(file: TFile | string | ArrayBuffer | Uint8Array, options?: SendPhotoOptions): Promise<void>;
  sendAudio(file: TFile | string | ArrayBuffer | Uint8Array, options?: SendAudioOptions): Promise<void>;
  sendVideo(file: TFile | string | ArrayBuffer | Uint8Array, options?: SendVideoOptions): Promise<void>;
  sendAnimation(file: TFile | string | ArrayBuffer | Uint8Array, options?: SendAnimationOptions): Promise<void>;
  sendVoice(file: TFile | string | ArrayBuffer | Uint8Array, options?: SendVoiceOptions): Promise<void>;
  sendVideoNote(file: TFile | string | ArrayBuffer | Uint8Array, options?: SendVideoNoteOptions): Promise<void>;
  sendMediaGroup(items: TelegramMediaGroupItem[]): Promise<SentTelegramMessageRef[]>;
  sendLocation(
    location: { latitude: number; longitude: number },
    options?: SendLocationOptions
  ): Promise<void>;
  disposeHandlersForUnit(unitName: string): void;
}
```

Example:

```typescript
const telegramAPI = app.plugins.plugins['obsidian-telegram-bot-plugin']?.getAPIv2?.();

telegramAPI?.registerMessageHandler(async (message, processedBefore) => {
  if (processedBefore) {
    return { processed: false, answer: null };
  }

  if (message.files.length === 0) {
    return { processed: false, answer: null };
  }

  const saved = await telegramAPI.saveFileToVault(message.files[0], {
    folder: "Attachments",
    conflictStrategy: "rename",
  });

  return {
    processed: true,
    answer: `Saved ${saved.name}`,
  };
}, "my-plugin");

const exportFile = app.vault.getAbstractFileByPath("Exports/daily-summary.md");
if (exportFile instanceof TFile) {
  await telegramAPI?.sendDocument(exportFile, {
    caption: "Daily summary export",
  });
}
```

Supported outbound methods:

- `sendDocument`
- `sendPhoto`
- `sendAudio`
- `sendVideo`
- `sendAnimation`
- `sendVoice`
- `sendVideoNote`
- `sendMediaGroup`
- `sendLocation`

Example media group:

```typescript
await telegramAPI?.sendMediaGroup([
  {
    type: "photo",
    file: "Exports/chart-1.png",
    caption: "Weekly charts",
  },
  {
    type: "photo",
    file: "Exports/chart-2.png",
  },
]);
```

Example location:

```typescript
await telegramAPI?.sendLocation(
  { latitude: 55.751244, longitude: 37.618423 },
  {
    inlineKeyboard: [[{ text: "Open dashboard", callbackData: "dashboard" }]],
  },
);
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
