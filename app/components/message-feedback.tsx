// components/message-feedback.tsx
'use client';

import { useState } from 'react';
import { ThumbsUp, ThumbsDown } from 'lucide-react'; // 图标库
import { addLikes } from '@/app/(chat)/action';
import { cn } from '@/app/lib/utils'; // 条件类名合并工具函数

export function MessageFeedback({ chatId, messageId }: { chatId: string; messageId: string }) {
    const [isLiked, setIsLiked] = useState<boolean | null>(null)
    const [isLoading, setIsLoading] = useState(false) 

    const handleLiked = async (like:boolean) => {
        if (isLoading) return // 防止重复点击
        // 乐观更新 
        // 这边涉及到usestate更新实际问题，去了解
        setIsLiked(like)
        setIsLoading(true)
        try {
            await addLikes(chatId, messageId, like)
        } catch (error) {
            console.log('点赞失败:', error)
        } finally {
            setIsLoading(false)
        }
    }

    return (
    <div className="flex gap-2 mt-2 text-gray-400">
      <button 
        onClick={() => handleLiked(true)} 
        className={cn("hover:text-green-500 transition-colors", isLiked === true && 'text-green-500')}
        disabled={isLoading}
      >
        <ThumbsUp size={14} />
      </button>
      {/* 暂时先只有点赞，没有踩的功能 */}
      {/* <button 
        onClick={() => handleLiked(false)} 
        className={cn("hover:text-red-500 transition-colors", isLiked === false && 'text-red-500')}
        disabled={isLoading}
      >
        <ThumbsDown size={14} />
      </button> */}
    </div>
  )
}