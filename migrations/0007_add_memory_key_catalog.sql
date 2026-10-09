-- memory_key 继续使用 project.database 这样的语义化名称；本表是这些名称的
-- 持久化注册表，用 description 和少量示例帮助模型优先复用已有 Key。
CREATE TABLE IF NOT EXISTS conversation_memory_keys (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  source_assistant_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  memory_key VARCHAR(200) NOT NULL,
  description VARCHAR(500) NOT NULL,
  examples TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  embedding VECTOR(1024),
  embedding_model VARCHAR(100),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, chat_id, memory_key),
  CONSTRAINT conversation_memory_keys_key_format_check
    CHECK (
      memory_key ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*){1,5}$'
    ),
  CONSTRAINT conversation_memory_keys_description_check
    CHECK (length(btrim(description)) > 0),
  CONSTRAINT conversation_memory_keys_embedding_pair_check
    CHECK (
      (embedding IS NULL AND embedding_model IS NULL)
      OR
      (embedding IS NOT NULL AND embedding_model IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS conversation_memory_keys_scope_idx
ON conversation_memory_keys(user_id, chat_id, created_at ASC);

-- 把旧的语义化 memory_key 注册进目录。旧数据没有单独的 Key 描述和向量，
-- 先用 Key 自身作为描述并保留最近示例；数量较少时仍会全部交给模型判断。
WITH existing_keys AS (
  SELECT
    memory.user_id,
    memory.chat_id,
    memory.memory_key,
    (array_agg(
      memory.retrieval_text
      ORDER BY memory.created_at DESC, memory.id DESC
    ))[1:5] AS examples,
    MIN(memory.created_at) AS created_at,
    MAX(memory.created_at) AS updated_at,
    (array_agg(
      memory.source_assistant_message_id
      ORDER BY memory.created_at ASC, memory.id ASC
    ))[1] AS source_assistant_message_id
  FROM conversation_memories AS memory
  INNER JOIN chats AS chat
    ON chat.id = memory.chat_id
    AND chat.user_id = memory.user_id
  WHERE memory.memory_key IS NOT NULL
    AND memory.memory_key ~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*){1,5}$'
  GROUP BY
    memory.user_id,
    memory.chat_id,
    memory.memory_key
)
INSERT INTO conversation_memory_keys (
  user_id,
  chat_id,
  source_assistant_message_id,
  memory_key,
  description,
  examples,
  created_at,
  updated_at
)
SELECT
  user_id,
  chat_id,
  source_assistant_message_id,
  memory_key,
  memory_key,
  examples,
  created_at,
  updated_at
FROM existing_keys
ON CONFLICT (user_id, chat_id, memory_key) DO NOTHING;
