// app/create-tables/route.ts
import postgres from 'postgres'
import { env } from '@/app/lib/env'

const sql = postgres(env.POSTGRES_URL, { ssl: 'require' })

export async function GET() {
  try {
    // 对话表
    //这里的意思是让数据库来执行下面这段sql语句
    await sql`
      CREATE TABLE IF NOT EXISTS chats (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL DEFAULT '新对话',
        parent_chat_id UUID,
        branch_from_message_id UUID,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `
    
    // 消息表
    await sql`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'completed'
          CHECK (status IN ('completed', 'interrupted')),
        likes INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `

    // 兼容旧表：如果 likes 列没有默认值，补上
    try {
      await sql`ALTER TABLE messages ALTER COLUMN likes SET DEFAULT 0`
    } catch {
      // 列不存在或已设置过，忽略
    }

    // 兼容已经存在的 messages 表；历史消息都视为完整消息。
    await sql`
      ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS status VARCHAR(20)
    `
    await sql`
      UPDATE messages
      SET status = 'completed'
      WHERE status IS NULL OR status NOT IN ('completed', 'interrupted')
    `
    await sql`
      ALTER TABLE messages
      ALTER COLUMN status SET DEFAULT 'completed',
      ALTER COLUMN status SET NOT NULL
    `
    await sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'messages_status_check'
            AND conrelid = 'messages'::regclass
        ) THEN
          ALTER TABLE messages
          ADD CONSTRAINT messages_status_check
          CHECK (status IN ('completed', 'interrupted'));
        END IF;
      END
      $$
    `

    // 阶段二：主对话和分支继续复用 chats，只通过下面两个字段表达来源关系。
    await sql`
      ALTER TABLE chats
      ADD COLUMN IF NOT EXISTS parent_chat_id UUID,
      ADD COLUMN IF NOT EXISTS branch_from_message_id UUID
    `
    await sql`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chats_parent_chat_id_fkey'
            AND conrelid = 'chats'::regclass
        ) THEN
          ALTER TABLE chats
          ADD CONSTRAINT chats_parent_chat_id_fkey
          FOREIGN KEY (parent_chat_id)
          REFERENCES chats(id)
          ON DELETE CASCADE;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chats_branch_from_message_id_fkey'
            AND conrelid = 'chats'::regclass
        ) THEN
          ALTER TABLE chats
          ADD CONSTRAINT chats_branch_from_message_id_fkey
          FOREIGN KEY (branch_from_message_id)
          REFERENCES messages(id)
          ON DELETE CASCADE;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chats_branch_relation_pair_check'
            AND conrelid = 'chats'::regclass
        ) THEN
          ALTER TABLE chats
          ADD CONSTRAINT chats_branch_relation_pair_check
          CHECK (
            (parent_chat_id IS NULL AND branch_from_message_id IS NULL)
            OR
            (parent_chat_id IS NOT NULL AND branch_from_message_id IS NOT NULL)
          );
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chats_parent_not_self_check'
            AND conrelid = 'chats'::regclass
        ) THEN
          ALTER TABLE chats
          ADD CONSTRAINT chats_parent_not_self_check
          CHECK (parent_chat_id IS NULL OR parent_chat_id <> id);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'chats_branch_from_message_id_key'
            AND conrelid = 'chats'::regclass
        ) THEN
          ALTER TABLE chats
          ADD CONSTRAINT chats_branch_from_message_id_key
          UNIQUE (branch_from_message_id);
        END IF;
      END
      $$
    `
    await sql`
      CREATE INDEX IF NOT EXISTS chats_parent_chat_id_idx
      ON chats(parent_chat_id)
    `
    
    return Response.json({ message: '聊天相关表创建成功' })
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 })
  }
}
