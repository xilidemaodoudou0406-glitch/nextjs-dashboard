-- 一个注册项会被父对话较早的分支继承，因此 examples 不能随着父对话后续
-- 记忆继续变化，否则锚点前创建的分支会通过注册表看到锚点后的内容。
-- 每个 chat/Key 只保留首次注册时的例子；后续值仍完整保存在记忆版本中。
UPDATE conversation_memory_keys AS key
SET examples = ARRAY[
  COALESCE(
    (
      SELECT memory.retrieval_text
      FROM conversation_memories AS memory
      WHERE memory.user_id = key.user_id
        AND memory.chat_id = key.chat_id
        AND memory.memory_key = key.memory_key
      ORDER BY memory.created_at ASC, memory.id ASC
      LIMIT 1
    ),
    key.examples[1]
  )
]
WHERE cardinality(key.examples) > 1;
