import type { TranslationMessage } from '../../i18n/index.js'
import type { ApiErrorKind } from '../api/client.js'
import type { ExternalProviderId } from '../providers.js'
import type {
  ChatModel,
  Effort,
  MessageUsage,
  ServerToolBlock,
  StopDetails,
  StopReason,
  TextCitation,
} from '../api/types.js'

/**
 * 消息附件。id 是本地标识（IndexedDB files 表的主键，原件按它存储，所有引用同一 id 的消息共用一份），
 * 导入的附件沿用导出产物里的文件 ID；本地没有原件的附件只展示文件名，不进入请求。
 * serverId 是 Files API 返回的 file_id，导入的数据或尚未上传成功的文件为 null，发送前补传。
 */
export type FileAttachment = {
  id: string
  serverId: string | null
  /** 当前 serverId 对应的上传图片已确认符合长边限制。旧记录缺少此字段。 */
  imageSizeChecked?: boolean
  name: string
  size: number
  /** 附件类别；导入时沿用归档的 is_image，不由 MIME 识别结果决定。 */
  isImage: boolean
  /** 具体 MIME；导入时没有原件或无法识别的为空字符串，不影响图片身份。 */
  mimeType: string
}

/** 本地消息的分支关系；字段缺省时按线性消息列表处理。 */
type MessageBranch = {
  parentId?: string | null
  /** 当前选中的下一条消息；切换版本时保留每条分支原有的选择。 */
  selectedChildId?: string
}

export type UserMessage = MessageBranch & {
  id: string
  role: 'user'
  content: string
  files: FileAttachment[]
  createdAt: number
  /**
   * 回答后从这轮及之前的对话里提取出的记忆改动，显示在这条提问当前可见的回答下方，可撤销。
   * 挂在提问上而不是回答上：重新生成、续写都会替换回答，提示不能跟着丢。只保存在本地，不进入导出归档。
   */
  memoryChanges?: MemoryChange[]
}

/** 思考块：thinking_delta 累积，签名随 signature_delta 到达；历史轮次的思考服务端会丢弃，不回传 */
export type ThinkingPart = {
  type: 'thinking'
  thinking: string
  signature?: string
  /** content_block_start 的时间；没有事件时间的历史块缺省 */
  startedAt?: number
  /** content_block_stop（或回复结束）的时间 */
  endedAt?: number
  /** 仅有耗时、没有事件时间时保存秒数。 */
  elapsedSeconds?: number
}

/** 文本块：text_delta 累积，citations_delta 追加引用 */
export type TextPart = {
  type: 'text'
  text: string
  citations?: TextCitation[]
  /** 服务端提示文案，仅用于展示，不作为模型回答参与上下文或续写。 */
  isTemplate?: boolean
}

/** 服务端工具调用与结果块按协议原样保存；历史请求只回传 read_link 调用与结果 */
export type ReplyBlock = ThinkingPart | TextPart | ServerToolBlock

/**
 * pending：已发出请求，还没收到事件；streaming：正在接收；
 * done：收到 message_stop；stopped：用户停止或页面关闭；error：请求或流出错
 */
export type ReplyStatus = 'pending' | 'streaming' | 'done' | 'stopped' | 'error'

/** 记忆条目的分类，对应记忆块里的小节 */
export type MemoryCategory = 'basics' | 'ongoing' | 'preferences' | 'people' | 'other'

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'basics',
  'ongoing',
  'preferences',
  'people',
  'other',
]

/** 记忆条目来自哪次对话 */
export type MemorySource = { sessionId: string; title: string; at: number }

/**
 * 一条记忆：关于用户的一件事，单行。
 * 后台整理只能改写、删除、合并 origin 为 auto 的条目；用户添加、编辑、确认过或明确要求记住的是 user，由代码保护。
 * pending 是等用户确认的敏感内容：确认前不注入、不导出、不参与整理。
 */
export type MemoryItem = {
  id: string
  text: string
  category: MemoryCategory
  origin: 'auto' | 'user'
  status: 'saved' | 'pending'
  sources: MemorySource[]
  createdAt: number
  updatedAt: number
  /** 合并进这条的其他条目 id：旧的改动提示据此找到合并后的条目 */
  aliases?: string[]
}

/**
 * 一次提取对记忆的改动。at 是改动的时间，也是改动后条目的 updatedAt：条目之后没再变过才允许撤销；
 * 早于上次清空记忆的改动不再显示。removed 带着删除前的整条记忆，撤销时原样放回；full 表示记忆已满，没能记下。
 */
export type MemoryChange =
  | { kind: 'added' | 'asked'; itemId: string; text: string; at: number }
  | { kind: 'updated'; itemId: string; text: string; previous: string; at: number }
  | { kind: 'removed'; itemId: string; text: string; item: MemoryItem; at: number }
  | { kind: 'full'; text: string; at: number }

/** 回答参考的一段过往对话 */
export type MemoryChat = {
  /** 对应的会话，用于「不再参考这段对话」；较早保存的回答没有 */
  sessionId?: string
  title: string
  updatedAt: number
  /** 用户原话节选；摘要生成于记录原话之前的旧数据为空字符串 */
  excerpt: string
}

export type AssistantMessage = MessageBranch & {
  id: string
  role: 'assistant'
  createdAt: number
  /** 未记录模型时为 null，续写使用当前默认模型。 */
  model: ChatModel | null
  /** 回答来自 DeepSeek 以外的服务商时记录；此时 model 为 null，实际模型见 providerModel */
  provider?: ExternalProviderId
  providerModel?: string
  /** 请求时是否开启深度思考 */
  thinking?: boolean
  /** 请求时的思考强度；未记录时不传，服务端按默认强度处理 */
  effort?: Effort
  /** 旧版开关记录的搜索状态；缺省表示声明 deepseek_web_search，由模型按需搜索 */
  search?: boolean
  /** 本轮请求的系统信息快照；各回答版本独立保存，续写沿用。历史消息中缺省的快照保持为空。 */
  latestReminder?: string
  /**
   * 最近一次请求追加在 system 末尾的记忆块原文（`<memory>…</memory>`），用于追溯这条回答参考了哪些记忆。
   * 记忆关闭或没有内容时缺省；只保存在本地，不进入导出归档。
   */
  memory?: string
  /**
   * 记忆块里「近期对话」各条对应的用户原话节选，顺序与记忆块一致。
   * 模型看到的是摘要；来源面板展示用户自己说过的话，所以另存一份。旧消息没有这个字段。
   */
  memoryChats?: MemoryChat[]
  /** 记忆块里的编号对应的记忆条目 id（m3 → 条目 id），来源面板按它操作；较早的回答没有，按原文查找 */
  memoryIds?: Record<string, string>
  /**
   * 模型在回答末尾报出的、这次实际用到的编号（记忆块里的 m1、m2…，以及自定义指令的 i1），来源面板只展示这些。
   * 空数组表示明确没用到；缺省表示没有收到报告（旧消息、回答被中断或模型没照做）。
   */
  memoryUsed?: string[]
  /**
   * 这次请求带上的自定义指令原文；模型报出指令的编号（i1，记在 memoryUsed 里）时，来源面板展示它。
   * 没有指令时缺省；只保存在本地，不进入导出归档。
   */
  instructions?: string
  /** 是否允许作为续写前缀；仍需满足回复状态与内容限制。 */
  prefix: boolean
  status: ReplyStatus
  /** 可识别的内容块按接收顺序排列；续写产生的块追加在已有块之后 */
  blocks: ReplyBlock[]
  stopReason?: StopReason
  stopDetails?: StopDetails
  /** 最近一次请求的用量，续写后更新 */
  usage?: MessageUsage
  error?: {
    /** upload：发送前补传附件失败，请求没有发出 */
    kind: ApiErrorKind | 'upload'
    message: string
    status?: number
    localMessage?: TranslationMessage
    /** 仅 upload：重新上传是否可能成功（网络、限流、服务端繁忙）；过大、格式不支持为 false */
    retryable?: boolean
  }
}

export type Message = UserMessage | AssistantMessage

export type Session = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 包含所有分支的消息，按创建顺序存储。 */
  messages: Message[]
  /** undefined 表示线性消息列表；null 表示空会话。 */
  rootMessageId?: string | null
  /** 临时对话：不参考记忆，内容也不会被记住。创建时决定，之后不变。 */
  temporary?: boolean
}

/** 会话列表元数据；消息只在打开会话时加载。 */
export type SessionSummary = Pick<Session, 'id' | 'title' | 'createdAt' | 'updatedAt' | 'temporary'>

/** 显式提取字段，避免将完整会话的消息带进列表。 */
export const toSessionSummary = (session: SessionSummary): SessionSummary => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  ...(session.temporary ? { temporary: true } : {}),
})
