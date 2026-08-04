'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { GitBranch, RotateCcw, Trash2, X } from 'lucide-react' // 图标

import {
  createBranchOnFirstSubmit,
  deleteBranch,
  findBranchByAnchor,
  readBranchConversation,
} from '../branch-actions'
import BranchChat, { type BranchChatHandle } from './branch-chat'
import BranchComposer from './branch-composer'
import { getMessageText, type ChatMessage } from '@/app/lib/ai/message'
import type {
  BranchAnchorLookup,
  BranchConversation,
  BranchFirstMessage,
} from '@/app/lib/branches/types'

export type BranchPanelSource =
  | { kind: 'anchor'; anchorMessage: ChatMessage }
  | { kind: 'branch'; branchId: string }

interface Props {
  modelId: string
  onBranchPersisted: (branchId: string) => void
  onClose: (anchorMessageId?: string) => void
  onDeleted: () => void
  parentChatId: string
  source: BranchPanelSource
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
  modelId,
  onBranchPersisted,
  onClose,
  onDeleted,
  parentChatId,
  source,
}: Props) {
  const [state, setState] = useState<PanelState>({ kind: 'loading' })
  const [reloadVersion, setReloadVersion] = useState(0)
  const [isBranchBusy, setIsBranchBusy] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const pendingFirstMessageRef = useRef<BranchFirstMessage | null>(null) // 用来存上次提交的 messageId 和内容是什么,useRef也可用于存数据
  const branchChatRef = useRef<BranchChatHandle>(null)
  const panelRef = useRef<HTMLElement>(null)
  const titleId = useId()
  const anchorMessage =
    source.kind === 'anchor' ? source.anchorMessage : null
  const branchId = source.kind === 'branch' ? source.branchId : null
  const anchorMessageId = anchorMessage?.id ?? null
  const resolvedAnchorMessageId =
    state.kind === 'ready'
      ? state.conversation.branch.anchorMessageId
      : anchorMessageId ?? undefined

  useEffect(() => {
    let isCurrent = true // 防竞态标签

    /**
     * 点击锚点和通过 URL 恢复使用两条明确的读取路径：
     * - anchor：只读查找，尚无分支时进入 draft；
     * - branchId：直接校验归属并恢复完整分支。
     *
     * 已有分支被找到后只把 ID 交给父组件写入 URL，随后由 branchId 路径
     * 统一读取。这样刷新、前进后退和点击打开不会形成三套恢复逻辑。
     */
    const loadBranch = async () => {
      setState({ kind: 'loading' })
      setDeleteError(null)
      setShowDeleteConfirm(false)

      try {
        if (branchId) {
          const conversationResult = await readBranchConversation({
            parentChatId,
            branchId,
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
          return
        }

        if (!anchorMessageId) {
          setState({ kind: 'error', message: '分支入口不存在' })
          return
        }

        // 先查找锚点对应的分支记录，可能还没创建。有则返回摘要等。
        const lookupResult = await findBranchByAnchor({
          parentChatId,
          anchorMessageId,
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

        onBranchPersisted(lookupResult.data.branch.id)
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
    // 清理函数（在组件卸载或是下次执行之前执行）
    return () => {
      isCurrent = false
    }
  }, [
    anchorMessageId,
    branchId,
    onBranchPersisted,
    parentChatId,
    reloadVersion,
  ])

  /**
   * 关闭分支时先停止仍在生成的请求。stop 完成后再卸载 BranchChat，
   * 可以让已有的部分回答走 interrupted 持久化，而不是在后台悄悄继续生成。
   */
  const requestClose = useCallback(async () => {
    if (isClosing) return

    setIsClosing(true)
    try {
      await branchChatRef.current?.stopGeneration()
    } finally {
      onClose(resolvedAnchorMessageId)
    }
  }, [isClosing, onClose, resolvedAnchorMessageId])

  // 移动端全屏面板打开时禁止背景页面继续滚动。
  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function' ||
      !window.matchMedia('(max-width: 1023px)').matches
    ) {
      return
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [])

  // 面板挂载后先把焦点移入 dialog，后续 Tab 键会被限制在面板内部。
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  /**
   * 草稿的第一次提交入口。
   *
   * 同一段草稿在网络重试时复用 messageId；创建成功后立即读取数据库上下文，
   * 再把首条消息交给 BranchChat 触发 AI，保证 UI、请求和数据库 ID 一致。
   * 返回字符串表示创建失败，BranchDraft 会保留原输入供用户重试。
   */
  const submitFirstMessage = async (
    content: string, // 跨组件获取过来的
  ): Promise<string | null> => {
    // 即待发送的首条消息（包含内容和id），可能是上次草稿的 messageId，也可能是新生成的
    const previousPending = pendingFirstMessageRef.current
    const firstMessage =
      previousPending?.content === content
        ? previousPending // 内容没变，复用上次的 messageId
        : { id: crypto.randomUUID(), content } // 新内容，生成新的 messageId
    pendingFirstMessageRef.current = firstMessage // 存起来id，以便下次重试时复用

    try {
      const createResult = await createBranchOnFirstSubmit({
        parentChatId,
        anchorMessageId: state.kind === 'draft'
          ? state.lookup.anchorMessageId
          : '',
        firstMessage,
      })

      if (!createResult.ok) return createResult.error.message

      // 从这里开始分支和首条消息已经持久化（写入了数据库）。把 branchId
      // 提升到父组件后会同步进 URL，再由统一的 branchId 路径读取上下文。
      setState({ kind: 'loading' })
      onBranchPersisted(createResult.data.id)
      return null
    } catch (error) {
      return getUnexpectedErrorMessage(error)
    }
  }
  //  锚点消息的前 120 字预览
  const anchorPreview =
    state.kind === 'draft'
      ? state.lookup.anchorPreview
      : state.kind === 'ready'
        ? getMessageText(state.conversation.anchorMessage).slice(0, 120)
        : anchorMessage
          ? getMessageText(anchorMessage).slice(0, 120)
          : ''
  // 继承的主对话消息数
  const inheritedMessageCount =
    state.kind === 'draft'
      ? state.lookup.inheritedMessageCount
      : state.kind === 'ready'
        ? state.conversation.inheritedMessages.length
        : null

  const deleteCurrentBranch = async () => {
    if (state.kind !== 'ready' || isBranchBusy || isDeleting) return

    setIsDeleting(true)
    setDeleteError(null)
    const result = await deleteBranch({
      parentChatId,
      branchId: state.conversation.branch.id,
    })

    if (!result.ok) {
      setDeleteError(result.error.message)
      setIsDeleting(false)
      return
    }

    onDeleted()
  }

  /**
   * dialog 的键盘边界：Escape 走统一关闭流程；Tab/Shift+Tab 在面板内循环。
   * 关闭完成后，主 Chat 仍负责把焦点还给原来的分支按钮。
   */
  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      void requestClose()
      return
    }

    if (event.key !== 'Tab' || !panelRef.current) return

    const focusableElements = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    )
    if (focusableElements.length === 0) return

    const first = focusableElements[0]
    const last = focusableElements.at(-1)!

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/30 lg:static lg:z-auto lg:flex-none lg:bg-transparent"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void requestClose()
      }}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="flex h-full w-full flex-col border-l border-gray-200 bg-white shadow-2xl lg:w-[420px] xl:w-[480px]"
        onKeyDown={handlePanelKeyDown}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
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
            <div className="flex items-center gap-1">
              {state.kind === 'ready' && (
                <button
                  aria-label="删除分支对话"
                  className="rounded-md p-1.5 text-gray-500 transition hover:bg-red-50 hover:text-red-600 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={isBranchBusy || isDeleting}
                  onClick={() => setShowDeleteConfirm(true)}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={17} />
                </button>
              )}
              <button
                aria-label="关闭分支对话"
                className="rounded-md p-1.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isClosing}
                onClick={() => void requestClose()}
                type="button"
              >
                <X aria-hidden="true" size={18} />
              </button>
            </div>
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

          {showDeleteConfirm && state.kind === 'ready' && (
            <div
              aria-label="确认删除分支"
              className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
              role="alertdialog"
            >
              <p>删除后分支消息无法恢复，主对话不会受到影响。</p>
              <div className="mt-2 flex gap-2">
                <button
                  className="rounded-md bg-red-600 px-3 py-1.5 text-white disabled:opacity-50"
                  disabled={isDeleting}
                  onClick={() => void deleteCurrentBranch()}
                  type="button"
                >
                  {isDeleting ? '正在删除…' : '确认删除'}
                </button>
                <button
                  className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-gray-700"
                  disabled={isDeleting}
                  onClick={() => setShowDeleteConfirm(false)}
                  type="button"
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {deleteError && (
            <p className="mt-2 text-sm text-red-600" role="alert">
              删除失败：{deleteError}
            </p>
          )}
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
            onBusyChange={setIsBranchBusy}
            pendingFirstMessage={state.pendingFirstMessage}
            ref={branchChatRef}
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
