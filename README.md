# chat-demo

English | [简体中文](README.zh-CN.md)

A pure-browser chat application powered by DeepSeek and compatible API services. The app has no application backend: the browser connects directly to the configured API service.

> This project is an open-source example for learning and engineering practice, modified from [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo). It is not an official DeepSeek product and is provided as-is, without any warranty.

Try it at [GitHub Pages](https://lzh20025.github.io/enhanced-chat-demo/). The app does not require a separate backend; you can also build and host the static files yourself.

## Getting started

Prepare Node.js 24 and pnpm (the GitHub Actions workflow uses pnpm 12.6.0):

```sh
git clone https://github.com/lzh20025/enhanced-chat-demo.git
cd enhanced-chat-demo
pnpm install
pnpm dev
```

Open http://localhost:8090.

To build the static site:

```sh
pnpm build
```

The output is written to `dist/`. Deploy it to a static web server or open `dist/index.html` directly. Opening the file directly requires browser and API support for storage and cross-origin requests from `file://` pages. Google sign-in does not support `file://` pages.

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, deep thinking, stop generation, and continuation where eligible.
- The DeepSeek provider supports smart search, link reading and source citations, attachments, voice input, read-aloud, and ASR/TTS speech features. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import/export.
- Memory, enabled by default: recent conversations are organized after replies and facts are extracted, with changes shown under replies and undoable. Sensitive facts require confirmation. View, add, edit, delete, or disable memory in Settings.
- Optional cloud sync through your own Google Drive to keep conversations, memory, and selected preferences consistent across devices. API keys, attachment originals, temporary conversations, and some device-only settings are not synced.

## Data and privacy

API keys and settings are stored in browser `localStorage`; conversations, memory, and original attachments are stored in IndexedDB. Local data is isolated by browser profile and site origin. Sending a message, uploading a file, using speech, or organizing memory sends relevant content directly from the browser to the configured AI service, where it is handled under that service's privacy policy.

History import and export use ZIP archives. Import validates the archive and, after confirmation, merges it with local history without replacing existing conversations or attachments. Export includes conversations, exportable image originals, and memory, but not API keys or app settings. Original attachments that are not images are not fully exported.

Settings → Data → Cloud sync is off by default. When enabled, it syncs conversations, memory, and preferences such as language, theme, model, effort, read-aloud voice, memory status, custom instructions, and per-provider models/base URLs. API keys, attachment originals, temporary conversations, and some device-only settings are excluded. Synced data moves directly between the browser and Google Drive.

Settings → Data → Delete all chats asks for confirmation, then clears local conversations, original attachments, and unsent drafts, stops ongoing replies, and returns to a new conversation. Memory entries and settings such as API keys are not deleted by this action. See the [privacy policy](https://lzh20025.github.io/enhanced-chat-demo/privacy.html) for details.

## Development

| Command       | Description                  |
| ------------- | ---------------------------- |
| `pnpm dev`    | Start the development server |
| `pnpm build`  | Build into `dist/`           |
| `pnpm type`   | Run TypeScript type checks   |
| `pnpm lint`   | Run oxlint                   |
| `pnpm test`   | Run unit tests with Vitest   |
| `pnpm format` | Format with oxfmt            |

Settings → Data lets you choose DeepSeek, Anthropic, OpenAI, Gemini, or a custom OpenAI-compatible service. DeepSeek is the default. Other providers offer basic chat, including thinking and effort settings, but do not expose this app's search, link-reading, attachment, speech, title-generation, or memory extensions. API key, base URL, and model settings are kept separately for each provider.

[rspack.config.ts](rspack.config.ts) uses `https://api.deepseek.com` by default. `createConfig({ apiOrigin, googleClientId, devServer })` can customize the API origin, Google OAuth client ID, and development server. To enable Google sync locally, copy `.env.example` to `.env.local` and set `GOOGLE_CLIENT_ID`. The client ID is a public identifier, not a secret. The build copies the privacy policy to `dist/privacy.html`.

DeepSeek uses `deepseek-flash` by default through Anthropic-compatible Messages/Files APIs. Speech features use ASR/TTS endpoints. Search, link reading, title generation, and memory depend on DeepSeek's extended APIs.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, and protocol types
    chat/              Conversations, message branches, storage, and history import/export
    memory/            Memory extraction, organization, and management
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
    sync/              Cloud sync and Google Drive
  utils/               Shared utilities
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
