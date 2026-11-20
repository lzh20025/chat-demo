# 云端同步

把会话、记忆和偏好设置同步到用户自己的存储，在多台设备间自动保持一致。应用没有自己的账号系统：连接的是存储服务商的账号（Google Drive、Dropbox，或用户自己的 WebDAV 服务器），数据只存在用户自己的空间里。

## 同步什么

| 种类 | 远端文件                           | 内容                                                                                 | 冲突时       |
| ---- | ---------------------------------- | ------------------------------------------------------------------------------------ | ------------ |
| 会话 | `sessions-<id>.json`，每个会话一个 | 完整的 `Session`，含全部分支                                                         | 按消息合并   |
| 记忆 | `memory-main.json`                 | 条目、元数据（不再提及等）、近期对话摘要                                             | 按条目合并   |
| 设置 | `settings-main.json`               | 语言、主题、模型、思考强度、朗读音色、记忆开关、自定义指令、各服务商的模型与接口地址 | 整份取较新的 |

不同步：API Key（任何服务商的）、附件原件、临时对话、记忆的活动记录，以及只属于单台设备的设置（当前选用的服务商、位置、侧边栏状态）。附件在其他设备上只有名字，和导入归档里的非图片附件表现一致。

每个文件是一个信封 `{ v, modifiedAt, data }`。每个种类另有一个 `<种类>.tombstones.json`，记录已删除条目的 key 和删除时间，其他设备据此在本地删除；记录保留 90 天。

## 结构：三个可插拔的接口

```
index.ts        装配与调度：注册内置实现，决定何时同步
engine.ts       引擎：只依赖下面三个接口
plan.ts         纯函数：比较本地、远端、删除记录，得出这一轮要做的事
 ├─ provider.ts    SyncProvider   服务商 = 授权 + 后端
 │   ├─ auth.ts       SyncAuth       登录、断开、取访问令牌
 │   └─ backend.ts    SyncBackend    远端文件的 list / read / stat / write / remove
 └─ collection.ts  SyncCollection 一种要同步的数据：列出本地条目、读写、合并

providers/googleDrive/   Google 登录（GIS 令牌模式）+ Drive appDataFolder
providers/dropbox/       Dropbox 登录（授权码 + PKCE，refresh token）+ App folder
providers/webdav/        WebDAV：用户填写文件夹地址、用户名和密码（connectFields）
providers/mock.ts        本地模拟后端，仅开发构建
collections/sessions.ts  会话；合并逻辑在 sessionMerge.ts
collections/memory.ts    记忆；合并逻辑在 memoryMerge.ts
collections/settings.ts  设置
```

引擎和设置界面都不认识具体的服务商或数据种类。

**新增一个服务商**（OneDrive、S3…）：实现 `SyncBackend`（五个方法）和 `SyncAuth`（不需要登录则为 `null`），组成一个 `SyncProvider`，在 `index.ts` 里 `registerSyncProvider`。它会自动出现在设置的「同步到」里。连接前要用户填写信息的（如 WebDAV 的地址和密码），在 `connectFields` 里声明，设置里会显示表单，填写的值传给 `SyncAuth.connect(values)`；`note` 是选中时显示的说明。授权要跳转到服务商页面再回来的（如 Dropbox），回来后设置会自动重新打开。

**新增一种要同步的数据**：实现 `SyncCollection`，在 `index.ts` 里 `registerSyncCollection`。本地改动时间和同步基线可以放在 IndexedDB 的 `syncMeta` 里（见 `chat/db.ts`），在数据写入的同一事务里更新。

## 怎么判断谁变了

`syncMeta` 为每个条目记三样东西：`modifiedAt`（本地最近一次改动）、`syncedAt`（上次同步时的 `modifiedAt`）、`syncedRev`（上次同步时远端文件的版本）。

- `modifiedAt !== syncedAt`：本地有改动；
- 远端当前版本 `!== syncedRev`：远端变了。

改动标记在 `chat/db.ts` 里与数据同一事务写入，而不是看 `Session.updatedAt`——重命名、回写记忆改动时 `updatedAt` 不变。同步写回的数据不产生改动标记。

| 本地   | 远端                 | 动作                                     |
| ------ | -------------------- | ---------------------------------------- |
| 有改动 | 没变 / 没有          | 上传                                     |
| 没改   | 变了                 | 下载                                     |
| 有改动 | 变了                 | 合并，结果写回本地并上传                 |
| 已删除 | 没变                 | 删除远端文件，记入删除记录               |
| 已删除 | 变了                 | 远端的改动晚于删除则恢复到本地，否则删除 |
| 没改   | 没有，且有删除记录   | 在本地删除                               |
| 没改   | 没有，也没有删除记录 | 重新上传（宁可多传，不删数据）           |

## 冲突怎么处理

全程自动，不弹窗。

- **会话**：消息是带 `id` 和 `parentId` 的分支树，按消息 id 取并集。两台设备各自新增的提问和回答挂在各自的父节点下，成为并列的版本，都保留。同一条回答两边不一样时，生成完的优先于被中断的。标题和「当前显示哪条分支」取最近改动的一方；它那边某条消息后面没有内容时沿用另一方的，所以新内容总能看到。
- **记忆**：条目按 id 取 `updatedAt` 较新的；删除和「清空全部记忆」都带时间，晚于条目最后变动的才生效（撤销删除放回的条目以放回时间为准）；「不再提及」「删除过的内容」取并集；两台设备各自记下的同一句话只留一条；摘要按对话取较新的。
- **设置**：整份取最近改动的一方。
- **写入竞争**：Drive 不支持条件写入。上传前会再查一次远端版本，与规划时不一致就放弃，下一轮按冲突重新合并。
- **删除记录的可靠性**：删除记录是多台设备共用的一个文件，写入可能失败，也可能被另一台设备同时写入的版本盖掉。所以本地的删除标记不会在删除远端文件后立刻清掉，而是留到之后某一轮在远端的删除记录里读到这一条为止；没读到就再补记一次。删除对话时，它的近期摘要也会留下删除标记并随记忆一起同步，不会留在云端。

写回本地时会在事务里核对条目没有在规划之后又被改动；正在生成回复、还没落盘的会话既不上传也不被覆盖，留到下一轮。

## 什么时候同步

启动后、本地有改动 5 秒后（连续改动合并成一轮）、页面可见时每 5 分钟、回到前台时，以及点「立即同步」。多个标签页通过 Web Locks 保证同时只有一个在同步。

## Google 登录

用 Google Identity Services 的令牌模式，全程在浏览器里完成，没有后端也没有 client secret。只申请 `drive.appdata`：应用只能读写自己在云端硬盘里的隐藏数据目录，看不到用户的其他文件。

配置：在 Google Cloud Console 创建「Web 应用」类型的 OAuth Client，把站点的 origin（本地开发是 `http://localhost:8090`）加入 Authorized JavaScript origins，并启用 Google Drive API；构建时通过环境变量 `GOOGLE_CLIENT_ID` 传入（或 `createConfig({ googleClientId })`）。没有配置时界面显示「未配置」，不会加载 Google 的脚本。

访问令牌只放在内存和 sessionStorage。换了 Google 账号或服务商时，全部同步基线作废，按首次同步处理（与新账号里已有的数据合并）。

## Dropbox 登录

授权码 + PKCE，全程在浏览器里完成，没有 client secret。申请 `token_access_type=offline` 拿到 refresh token，访问令牌是短期的，过期后在后台用普通的 `fetch` 换新的，不弹窗、不需要用户手势，所以连接一次就一直可用，直到用户断开或在 Dropbox 里撤销授权（这时进入 `expired`，主界面提示「继续同步」）。

连接时整页跳转到 Dropbox 的授权页，授权后回到应用所在的目录（如 `https://<user>.github.io/<repo>/`），地址里带着 `code` 和 `state`。应用启动时核对 `state`、用 `code` 和 PKCE verifier 换令牌，再把这两个参数从地址栏去掉；Service Worker 缓存页面时也去掉查询参数，一次性的 `code` 不会写进缓存。用跳转而不用弹窗：不依赖用户手势，手机上「添加到主屏幕」的应用里也能用。

refresh token 和账号放在 localStorage（和 API Key 一样只在本机，不参与同步），访问令牌放在 sessionStorage。断开时删除它们，并在 Dropbox 里撤销授权：撤销访问令牌会连同 refresh token 一起作废；当前标签页没有可用的访问令牌时，先用 refresh token 换一个再撤销。

配置：在 [Dropbox App Console](https://www.dropbox.com/developers/apps) 创建应用，选 **Scoped access** 和 **App folder**（只能访问 `Apps/<应用名>` 这一个文件夹）；在 Permissions 里勾选 `account_info.read`、`files.metadata.read`、`files.content.read`、`files.content.write`；在 OAuth 2 的 Redirect URIs 里登记站点所在的目录（本地开发是 `http://localhost:8090/`）。构建时通过环境变量 `DROPBOX_APP_KEY` 传入 App key（或 `createConfig({ dropboxAppKey })`）；App key 是公开标识，不是密钥。没有配置时界面显示「未配置」。

## WebDAV

用户在设置里填写文件夹地址、用户名和密码（建议用服务器生成的应用专用密码），连接时先 `PROPFIND` 确认能访问，文件夹不存在就 `MKCOL` 创建。之后用 HTTP Basic 访问：`PROPFIND Depth: 1` 列目录，`GET` / `PUT` / `DELETE` 读写，版本用 `ETag`（服务器不给时用修改时间和大小）。请求都带 `cache: 'no-store'`，避免浏览器缓存把其他设备刚写的文件挡住。凭据不会过期；服务器返回 401 / 403（改了密码、撤销了应用密码）时进入 `expired`，主界面提示，点「打开设置」重新填写（地址和用户名会预填）。

浏览器直接访问用户的服务器，所以服务器（或前面的反向代理）要允许本站的跨域请求，例如：

```
Access-Control-Allow-Origin: https://<user>.github.io
Access-Control-Allow-Methods: GET, PUT, DELETE, PROPFIND, MKCOL, OPTIONS
Access-Control-Allow-Headers: Authorization, Depth, Content-Type
Access-Control-Expose-Headers: ETag
```

预检请求（`OPTIONS`）要在认证之前直接返回 2xx。没有暴露 `ETag` 时每次上传后会多查一次版本。

## 开发与验证

- `pnpm test`：`__tests__/` 覆盖规划、引擎（内存后端 + 一个最简单的数据种类）、会话与记忆的合并、设置导出不含密钥。
- 开发构建的设置里可以把「同步到」切到「本地模拟」：远端文件存在本机的 `chat-demo-sync-mock` 数据库里，不需要 Google 账号。清空 `chat-demo` 数据库后再同步，相当于在一台新设备上恢复。

## 已知限制

- 浏览器端拿不到 refresh token，访问令牌约一小时过期，关掉标签页后也不保留。过期后会尝试静默续期；被浏览器拦截弹窗时状态变为「授权已过期」，自动同步暂停，主界面顶部提示，点「继续同步」（或设置里的「重新连接」）即可，同一个账号不需要重新选择。设置里选中 Google Drive 时会说明这个限制。
- 未通过 Google 验证的 OAuth 应用只有测试用户能登录；`file://` 打开的页面无法登录（Dropbox 同理，回调地址必须是登记过的 http(s) 地址）。
- Dropbox 的应用在 App Console 里处于开发状态时，能连接的用户数有限，公开使用前需要申请上线。
- WebDAV 依赖服务器的跨域配置，很多服务器默认不允许；密码以明文保存在本机 localStorage，和 API Key 一样。
- 上传前复查版本只能把覆盖窗口缩到一次请求之内；极端情况下后写者仍会覆盖前者（Drive 保留文件的历史版本）。
- 两台设备并发新增的内容表现为并列的分支，另一台设备的那条需要用分支切换查看。
- 判断删除与编辑的先后依赖各设备的时钟；时钟相差很大时，「删除后又编辑」的先后可能判断反。
- 消息级的删除不存在于数据模型里，也就不同步；会话只能整体删除。
