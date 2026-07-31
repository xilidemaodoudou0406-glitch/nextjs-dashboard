// components/message-feedback.tsx
'use client';

import { useState } from 'react';
import { ThumbsUp } from 'lucide-react'; // 图标库
import { addLikes } from '@/app/(chat)/action';
import { cn } from '@/app/lib/utils'; // 条件类名合并工具函数

export function MessageFeedback({ chatId, messageId }: { chatId: string; messageId: string }) {
    const [isLiked, setIsLiked] = useState<boolean | null>(null)
    const [isLoading, setIsLoading] = useState(false)
    const [feedbackError, setFeedbackError] = useState<string | null>(null)

    const handleLiked = async (like:boolean) => {
        if (isLoading) return // 防止重复点击
        // 先保存旧值，再做乐观更新。服务端失败时必须恢复，避免 UI 显示成功、
        // 数据库却没有更新的假状态。
        const previousLiked = isLiked
        setIsLiked(like)
        setIsLoading(true)
        setFeedbackError(null)
        try {
            const result = await addLikes(chatId, messageId, like)
            if (!result.ok) {
              setIsLiked(previousLiked)
              setFeedbackError(result.error.message)
            }
        } catch (error) {
            setIsLiked(previousLiked)
            setFeedbackError(
              error instanceof Error ? error.message : '点赞失败，请稍后重试',
            )
        } finally {
            setIsLoading(false)
        }
    }

    return (
    <div className="mt-2">
      <div className="flex gap-2 text-gray-400">
        <button
          onClick={() => handleLiked(true)}
          className={cn("hover:text-green-500 transition-colors", isLiked === true && 'text-green-500')}
          disabled={isLoading}
          aria-label="点赞"
          aria-pressed={isLiked === true}
        >
          <ThumbsUp size={14} />
        </button>
      </div>
      {/* 暂时先只有点赞，没有踩的功能 */}
      {/* <button 
        onClick={() => handleLiked(false)} 
        className={cn("hover:text-red-500 transition-colors", isLiked === false && 'text-red-500')}
        disabled={isLoading}
      >
        <ThumbsDown size={14} />
      </button> */}
      {feedbackError && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {feedbackError}
        </p>
      )}
    </div>
  )
}
