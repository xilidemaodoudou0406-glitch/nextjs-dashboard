-- RAG 对话记忆使用 pgvector 保存语义向量。
-- messages 仍然是完整聊天记录的事实源；本表只是可以随时重建的检索索引。
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS conversation_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  source_user_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  source_assistant_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding VECTOR(1024) NOT NULL,
  embedding_model VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT conversation_memories_nonempty_content_check
    CHECK (length(btrim(content)) > 0),
  CONSTRAINT conversation_memories_distinct_source_check
    CHECK (source_user_message_id <> source_assistant_message_id),
  CONSTRAINT conversation_memories_assistant_unique
    UNIQUE (source_assistant_message_id)
);

-- 每次检索都先限制用户和对话，再计算向量距离。早期数据量较小时，
-- 这个普通索引配合精确余弦检索更简单；数据量明显增长后再评估 HNSW。
CREATE INDEX IF NOT EXISTS conversation_memories_scope_idx
ON conversation_memories(user_id, chat_id, created_at DESC);

