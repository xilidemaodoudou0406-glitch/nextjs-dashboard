'use client'

import { useEffect, useRef, useState } from 'react'
import { GitBranch, RotateCcw, X } from 'lucide-react'

import {
  createBranchOnFirstSubmit,
  findBranchByAnchor,
  readBranchConversation,
} from '../branch-actions'
import BranchChat from './branch-chat'
import BranchComposer from './branch-composer'
import { getMessageText, type ChatMessage } from '@/app/lib/ai/message'
import type {
  BranchAnchorLookup,
  BranchConversation,
  BranchFirstMessage,
} from '@/app/lib/branches/types'

interface Props {
  anchorMessage: ChatMessage
  modelId: string
  onClose: () => void
  parentChatId: string
}

type PanelState =
  | { kind: 'loading' }
  | { kind: 'draft'; lookup: BranchAnchorLookup }
  | {
      kind: 'ready'
      conversation: BranchConversation
      pendingFirstMessage?: BranchFirstMessage
    }
  | { kind: 'error'; message: string }

function getUnexpectedErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : '分支暂时无法加载，请稍后重试'
}

/**
 * 分支面板的流程控制器。
 *
 * 它负责把“点击锚点”推进为 loading、draft、ready 或 error：
 * 点击时只查询；只有 draft 中第一次提交才创建；已有分支则直接读取。
 * BranchChat 被单独挂载，因此分支的 messages、status、error 和 stop 都不会
 * 与主对话共享。
 */
export default function BranchPanel({
  anchorMessage,
  modelId,
  onClose,
  parentChatId,
}: Props) {
  const [state, setState] = useState<PanelState>({ kind: 'loading' })
  const [reloadVersion, setReloadVersion] = useState(0)
  const pendingFirstMessageRef = useRef<BranchFirstMessage | null>(null)
  const titleId = `branch-panel-title-${anchorMessage.id}`

  useEffect(() => {
    let isCurrent = true // 防竞态标签

    /**
     * 打开面板时先执行只读查找。
     * branch 为 null 进入草稿；否则继续读取隔离后的分支上下文。
     */
    const loadBranch = async () => {
      setState({ kind: 'loading' })

      try {
        // 先查找锚点对应的分支记录，可能还没创建。有则返回摘要等。
        const lookupResult = await findBranchByAnchor({
          parentChatId,
          anchorMessageId: anchorMessage.id,
        })
        if (!isCurrent) return

        if (!lookupResult.ok) {
          setState({
            kind: 'error',
            message: lookupResult.error.message,
          })
          return
        }

        if (!lookupResult.data.branch) {
          setState({ kind: 'draft', lookup: lookupResult.data })
          return
        }

        // 获得锚点处的inheritedMessages、branchMessages、锚点消息本身、该分支的具体信息（描述该分支是谁）
        const conversationResult = await readBranchConversation({
          parentChatId,
          branchId: lookupResult.data.branch.id,
        })
        if (!isCurrent) return

        if (!conversationResult.ok) {
          setState({
            kind: 'error',
            message: conversationResult.error.message,
          })
          return
        }

        const pendingFirstMessage =
          pendingFirstMessageRef.current ?? undefined
        pendingFirstMessageRef.current = null
        setState({
          kind: 'ready',
          conversation: conversationResult.data,
          pendingFirstMessage,
        })
      } catch (error) {
        if (isCurrent) {
          setState({
            kind: 'error',
            message: getUnexpectedErrorMessage(error),
          })
        }
      }
    }

    void loadBranch()

    // 用户切换锚点或关闭面板后，旧请求即使晚返回也不能覆盖新面板。
    return () => {
      isCurrent = false
    }
  }, [anchorMessage.id, parentChatId, reloadVersion])

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClose])

  /**
   * 草稿的第一次提交入口。
   *
   * 同一段草稿在网络重试时复用 messageId；创建成功后立即读取数据库上下文，
   * 再把首条消息交给 BranchChat 触发 AI，保证 UI、请求和数据库 ID 一致。
   * 返回字符串表示创建失败，BranchDraft 会保留原输入供用户重试。
   */
  const submitFirstMessage = async (
    content: string,
  ): Promise<string | null> => {
    const previousPending = pendingFirstMessageRef.current
    const firstMessage =
      previousPending?.content === content
        ? previousPending
        : { id: crypto.randomUUID(), content }
    pendingFirstMessageRef.current = firstMessage

    try {
      const createResult = await createBranchOnFirstSubmit({
        parentChatId,
        anchorMessageId: anchorMessage.id,
        firstMessage,
      })

      if (!createResult.ok) return createResult.error.message

      // 从这里开始分支和首条消息已经持久化，即使后续读取失败也不退回“未创建”语义。
      setState({ kind: 'loading' })
      const conversationResult = await readBranchConversation({
        parentChatId,
        branchId: createResult.data.id,
      })

      if (!conversationResult.ok) {
        setState({
          kind: 'error',
          message: conversationResult.error.message,
        })
        return null
      }

      pendingFirstMessageRef.current = null
      setState({
        kind: 'ready',
        conversation: conversationResult.data,
        pendingFirstMessage: firstMessage,
      })
      return null
    } catch (error) {
      return getUnexpectedErrorMessage(error)
    }
  }

  const anchorPreview =
    state.kind === 'draft'
      ? state.lookup.anchorPreview
      : getMessageText(anchorMessage).slice(0, 120)
  const inheritedMessageCount =
    state.kind === 'draft'
      ? state.lookup.inheritedMessageCount
      : state.kind === 'ready'
        ? state.conversation.inheritedMessages.length
        : null

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/30 lg:static lg:z-auto lg:flex-none lg:bg-transparent"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="flex h-full w-full flex-col border-l border-gray-200 bg-white shadow-2xl lg:w-[420px] xl:w-[480px]"
        role="dialog"
      >
        <header className="border-b border-gray-200 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <GitBranch
                aria-hidden="true"
                className="shrink-0 text-blue-600"
                size={18}
              />
              <h2 className="truncate font-semibold text-gray-900" id={titleId}>
                分支对话
              </h2>
            </div>
            <button
              aria-label="关闭分支对话"
              className="rounded-md p-1.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              onClick={onClose}
              type="button"
            >
              <X aria-hidden="true" size={18} />
            </button>
          </div>

          <div className="mt-3 rounded-lg bg-blue-50 p-3">
            <p className="text-xs font-medium text-blue-700">
              基于这条回答
            </p>
            <p className="mt-1 line-clamp-3 text-sm text-gray-700">
              {anchorPreview || '正在读取锚点内容…'}
            </p>
            {inheritedMessageCount !== null && (
              <p className="mt-2 text-xs text-gray-500">
                已继承主对话截至此处的 {inheritedMessageCount} 条消息
              </p>
            )}
          </div>
        </header>

        {state.kind === 'loading' && (
          <div
            aria-live="polite"
            className="flex flex-1 items-center justify-center text-sm text-gray-500"
          >
            正在加载分支…
          </div>
        )}

        {state.kind === 'error' && (
          <div
            className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
            role="alert"
          >
            <p className="text-sm text-red-600">{state.message}</p>
            <button
              className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 transition hover:bg-gray-50"
              onClick={() => setReloadVersion((version) => version + 1)}
              type="button"
            >
              <RotateCcw aria-hidden="true" size={15} />
              重新加载
            </button>
          </div>
        )}

        {state.kind === 'draft' && (
          <BranchDraft onSubmit={submitFirstMessage} />
        )}

        {state.kind === 'ready' && (
          <BranchChat
            conversation={state.conversation}
            modelId={modelId}
            pendingFirstMessage={state.pendingFirstMessage}
          />
        )}
      </section>
    </div>
  )
}

function BranchDraft({
  onSubmit,
}: {
  onSubmit: (content: string) => Promise<string | null>
}) {
  const [input, setInput] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (content: string) => {
    setIsCreating(true)
    setError(null)
    const submitError = await onSubmit(content)

    // 创建成功后组件会切换为 BranchChat；失败时保留输入并解锁。
    if (submitError) {
      setError(submitError)
      setIsCreating(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 items-center justify-center p-6 text-center">
        <div>
          <p className="text-sm font-medium text-gray-700">
            这是一个临时草稿
          </p>
          <p className="mt-1 text-xs leading-5 text-gray-500">
            只有发送第一个问题后才会创建数据库分支。
          </p>
        </div>
      </div>

      {error && (
        <p
          className="mx-3 mb-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          role="alert"
        >
          {error}
        </p>
      )}

      <BranchComposer
        autoFocus
        isBusy={isCreating}
        onChange={setInput}
        onSubmit={(content) => {
          void submit(content)
        }}
        value={input}
      />
    </div>
  )
}
