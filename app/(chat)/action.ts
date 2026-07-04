'use server'

import { auth } from "@/auth"
import postgres from "postgres"
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { error } from "console"

const sql = postgres(process.env.POSTGRES_URL!,{ ssl: 'require' })

export async function deleteChat (chatId:string) {
    const session = await auth()
    if (!session?.user?.id) throw new Error('未登录')
    
    // 验证身份
    const chats = await sql`
        SELECT user_id FROM chats WHERE id = ${chatId}
    `
    if (chats.length === 0) throw new Error('未找到对话')
    if (chats[0].user_id != session?.user?.id) throw new Error('未授权')

    // 删除(messages 表有 ON DELETE CASCADE,会自动连带删除)
    await sql`DELETE FROM chats WHERE id = ${chatId}`

    // 先不用深入了解 这个功能也是为了刷新页面
    revalidatePath('/')
}

export async function addLikes (chatId: string,messageId: string,isLike: boolean | null) {
    const session = await auth()
    if (!session?.user?.id) throw new Error('未登录')
    
    // 验证身份
    const chats = await sql`
        SELECT user_id FROM chats WHERE id = ${chatId}
    `
    if (chats.length === 0) throw new Error('未找到对话')
    if (chats[0].user_id != session?.user?.id) throw new Error('未授权')
    
    // 更新 likes 字段
    await sql`
        UPDATE messages
        SET likes = GREATEST(0, COALESCE(likes, 0) + CASE 
            WHEN ${isLike} = true THEN 1 
            WHEN ${isLike} = false THEN -1 
            ELSE 0 
        END)
        WHERE id = ${messageId};
    `
    }