'use client'

import { useEffect, useRef } from 'react'
import { Send, Square } from 'lucide-react'

interface Props {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  isBusy: boolean
  onStop?: () => void
  autoFocus?: boolean
}

/**
 * 分支专用的纯文本输入框。
 *
 * 它只处理键盘语义、空内容拦截和快速重复提交，不持有聊天消息；
 * 草稿创建和已存在分支都可以复用它，但具体发送行为由父组件决定。
 */
export default function BranchComposer({
  value,
  onChange,
  onSubmit,
  isBusy,
  onStop,
  autoFocus = false,
}: Props) {
  const submittingRef = useRef(false)

  useEffect(() => {
    if (!isBusy) submittingRef.current = false
  }, [isBusy])

  const submit = () => {
    const content = value.trim()
    if (!content || isBusy || submittingRef.current) return

    submittingRef.current = true
    onSubmit(content)
  }

  return (
    <form
      className="border-t border-gray-200 bg-white p-3"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="flex items-end gap-2">
        <textarea
          aria-label="分支问题"
          autoFocus={autoFocus}
          className="min-h-10 max-h-32 flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-gray-100"
          disabled={isBusy}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder="围绕这条回答继续提问..."
          rows={1}
          value={value}
        />

        {isBusy && onStop ? (
          <button
            aria-label="停止生成分支回答"
            className="inline-flex h-10 items-center gap-1 rounded-lg bg-red-500 px-3 text-sm text-white transition hover:bg-red-600"
            onClick={onStop}
            type="button"
          >
            <Square aria-hidden="true" size={14} />
            停止
          </button>
        ) : (
          <button
            aria-label="发送分支问题"
            className="inline-flex h-10 items-center gap-1 rounded-lg bg-blue-600 px-3 text-sm text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={isBusy || !value.trim()}
            type="submit"
          >
            <Send aria-hidden="true" size={15} />
            发送
          </button>
        )}
      </div>
      <p className="mt-1.5 text-xs text-gray-400">
        Enter 发送，Shift + Enter 换行
      </p>
    </form>
  )
}
