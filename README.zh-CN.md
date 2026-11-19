# chat-demo

[English](README.md) | 简体中文

基于 DeepSeek API 的静态聊天示例。无需应用后端，浏览器直接请求配置的 API 服务。

点击 [在线体验](https://deepseek-ai.github.io/chat-demo/) 即可使用，也可以前往 [Releases](https://github.com/deepseek-ai/deepseek-chat-demo/releases) 下载压缩包，解压后双击 `index.html` 在本地使用，无需安装或构建。首次使用时，请在设置中填写 API Key。

## 运行

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

打开 http://localhost:8090 。

生成静态产物：

```sh
pnpm build
```

产物位于 `dist/`，可部署到静态服务器，也可直接打开 `dist/index.html`。直接打开时，浏览器和 API 服务需允许 `file://` 页面的存储与跨域请求。

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。
- 记忆：回答后几秒内记下关于你的事（回答下方提示、可撤销），新对话开始时自动参考；敏感内容先问再记。可在设置中查看、添加、删除和关闭；临时对话不参考也不写入记忆；记忆随历史一起导出。说明见[记忆](src/services/memory/README.md)。
- 云端同步：可选，通过你自己的 Google Drive 在设备间同步会话、记忆和偏好设置。应用没有自己的账号，登录的是 Google 账号；API Key 不会离开本机。说明见[云端同步](src/services/sync/README.md)。

## 数据

API Key 和设置保存在浏览器 localStorage，会话及附件原件保存在 IndexedDB，本地数据按浏览器用户配置和站点源（origin）隔离。发送对话、上传附件和使用语音功能时，相应内容会提交给配置的 API 服务。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后与本地会话合并：只添加本地没有的会话，已有会话和附件保持不变；导出包含会话、本地可用的图片原件和记忆（记住的事与不再提及的清单），不包含 API Key、设置或非图片附件原件；导入的记忆与本地合并，跳过重复的内容。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 云端同步默认关闭。开启后，会话、记忆和偏好设置（语言、主题、模型、思考强度、朗读音色、记忆开关、自定义指令、各服务商的模型与接口地址）保存在你的 Google Drive 里应用专属的隐藏目录中（`drive.appdata` 权限：应用看不到你的其他文件），两台设备改了同一处时自动合并。API Key、附件原件和临时对话不会上传。构建时需要提供 Google OAuth Client ID：在 Google Cloud Console 创建「Web 应用」类型的 OAuth Client，把站点 origin（本地开发为 `http://localhost:8090`）加入 Authorized JavaScript origins，启用 Drive API，然后用 `GOOGLE_CLIENT_ID=<id>` 构建；没有配置时设置里显示为未配置。访问令牌约一小时过期，浏览器不一定能静默续期，届时需要点一次「重新连接」。

设置 → 数据管理 → 删除所有对话，会在确认后清空全部本地会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。API Key 和其他设置保留，已上传到 API 服务的文件不受影响。

## 开发

| 命令          | 用途                |
| ------------- | ------------------- |
| `pnpm dev`    | 启动开发服务器      |
| `pnpm build`  | 构建到 `dist/`      |
| `pnpm type`   | TypeScript 类型检查 |
| `pnpm lint`   | oxlint 检查         |
| `pnpm test`   | vitest 单元测试     |
| `pnpm format` | oxfmt 格式化        |

在「设置 → 数据管理」中可以把服务商切换为 Anthropic、OpenAI、Gemini（通过其 OpenAI 兼容接口）或任意 OpenAI 兼容服务，各自保存 API Key、接口地址和模型。这些服务商只提供基础对话（含深度思考与思考强度）；联网搜索、链接阅读、附件、语音、标题和记忆仅在使用 DeepSeek 时可用。

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`。`createConfig({ apiOrigin, googleClientId, devServer })` 支持自定义 API 地址、云端同步用的 Google OAuth Client ID（默认读环境变量 `GOOGLE_CLIENT_ID`）和开发服务器代理。

聊天默认使用 `deepseek-flash`，通过 Anthropic 兼容的 Messages / Files API 通信；语音使用 ASR / TTS 接口。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE 与协议类型
    chat/              会话、消息分支、本地存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
