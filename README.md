# Telegram Bot Plugin for Obsidian

![Obsidian](https://img.shields.io/badge/Obsidian-%23483699.svg?style=for-the-badge&logo=obsidian&logoColor=white)
![Telegram](https://img.shields.io/badge/Telegram-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white)

**Unified interface for Obsidian plugins to interact with Telegram**

This plugin provides a unified API that allows other Obsidian plugins to communicate through a single Telegram bot.

## Features

- 🚀 **Single entry point** for all Telegram-connected plugins
- 📁 **Controlled file persistence** through `saveFileToVault`
- 💬 **Unified inbound message model** for commands, text, callbacks, and files
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
4. Save settings
5. Send `/start` command to your bot in Telegram

## For Plugin Developers

Integrate Telegram capabilities into your plugin through the shared Telegram API:

```typescript
const telegramAPI = app.plugins.plugins['obsidian-telegram-bot-plugin']?.getAPI?.();

if (telegramAPI) {
  telegramAPI.registerMessageHandler(async (message, processedBefore) => {
    if (processedBefore) {
      return { processed: false, answer: null };
    }

    if (message.command?.name === "mycmd") {
      return { processed: true, answer: "Command processed!" };
    }

    if (message.text?.includes("hello")) {
      return { processed: true, answer: "Hi there!" };
    }

    if (message.files[0]?.mimeType === "application/pdf") {
      const saved = await telegramAPI.saveFileToVault(message.files[0], {
        folder: "Attachments",
        conflictStrategy: "rename",
      });

      return { processed: true, answer: `Saved ${saved.name}` };
    }

    return { processed: false, answer: null };
  }, "my-plugin");

  // Send messages
  await telegramAPI.sendMessage("Notification from my plugin!");

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
interface ITelegramBotPluginAPI {
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

  registerCallbackHandler(
    handler: (
      callback: TelegramCallbackContext,
      processedBefore: boolean
    ) => Promise<HandlerResult>,
    unitName: string
  ): void;

  registerFocusedInputHandler(
    handler: (
      message: TelegramMessageContext,
      focus: InputFocusState
    ) => Promise<HandlerResult>,
    unitName: string
  ): void;

  setInputFocus(unitName: string, options?: SetInputFocusOptions): Promise<void>;
  clearInputFocus(unitName?: string): Promise<void>;
  getInputFocus(): Promise<InputFocusState | null>;

  sendMessage(text: string, options?: SendMessageOptions): Promise<SentTelegramMessageRef>;
  sendDocument(
    file: TFile | string | ArrayBuffer | Uint8Array,
    options?: SendDocumentOptions
  ): Promise<SentTelegramMessageRef>;
  sendFile(
    file: TFile | string | ArrayBuffer | Uint8Array,
    options?: SendDocumentOptions
  ): Promise<SentTelegramMessageRef>;
  sendPhoto(file: TFile | string | ArrayBuffer | Uint8Array, options?: SendPhotoOptions): Promise<SentTelegramMessageRef>;
  sendAudio(file: TFile | string | ArrayBuffer | Uint8Array, options?: SendAudioOptions): Promise<SentTelegramMessageRef>;
  sendVideo(file: TFile | string | ArrayBuffer | Uint8Array, options?: SendVideoOptions): Promise<SentTelegramMessageRef>;
  sendAnimation(file: TFile | string | ArrayBuffer | Uint8Array, options?: SendAnimationOptions): Promise<SentTelegramMessageRef>;
  sendVoice(file: TFile | string | ArrayBuffer | Uint8Array, options?: SendVoiceOptions): Promise<SentTelegramMessageRef>;
  sendVideoNote(file: TFile | string | ArrayBuffer | Uint8Array, options?: SendVideoNoteOptions): Promise<SentTelegramMessageRef>;
  sendMediaGroup(items: TelegramMediaGroupItem[]): Promise<SentTelegramMessageRef[]>;
  sendLocation(
    location: { latitude: number; longitude: number },
    options?: SendLocationOptions
  ): Promise<SentTelegramMessageRef>;
  editMessage(messageId: number, text: string, options?: SendMessageOptions): Promise<void>;
  deleteMessage(messageId: number): Promise<void>;
  answerCallbackQuery(callbackId: string, text?: string): Promise<void>;
  encodeCallbackPayload(payload: TelegramCallbackPayload): string;
  decodeCallbackPayload(data: string): TelegramCallbackPayload | null;
  disposeHandlersForUnit(unitName: string): void;
}
```

The key idea is simple:

- one normalized message handler for commands, text, and files
- files arrive as descriptors before anything is saved to the vault
- the consumer plugin decides whether and where to persist the file

Example:

```typescript
const telegramAPI = app.plugins.plugins['obsidian-telegram-bot-plugin']?.getAPI?.();

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
telegramAPI?.registerMessageHandler(async (message, processed) => {
  if (processed || message.kind !== "voice" || message.files.length === 0) {
    return { processed: false, answer: null };
  }

  const file = await telegramAPI.saveFileToVault(message.files[0], {
    folder: "Voice Notes",
    conflictStrategy: "rename",
  });

  if (file.extension === "ogg") {
    const transcript = await transcribeAudio(file);
    await createNote(transcript);
    return { processed: true, answer: "Voice message transcribed!" };
  }

  return { processed: false, answer: null };
}, "voice-notes");
```

### Notification Plugin
```typescript
telegramAPI?.registerMessageHandler(async (message, processed) => {
  if (processed || message.command?.name !== "remind") {
    return { processed: false, answer: null };
  }

  await createReminder(message.command.args);
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
