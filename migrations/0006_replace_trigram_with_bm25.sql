-- 使用项目自身维护的分词数据计算 BM25，不依赖 pg_search 等搜索扩展。
-- 英文、数字和代码标识符保留完整技术词，并补充按分隔符拆出的子词；
-- 连续中文使用双字切分，使查询与文档能在没有中文分词扩展时稳定匹配。
CREATE OR REPLACE FUNCTION bm25_tokenize(input_text TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
DECLARE
  normalized_text TEXT := lower(input_text);
  matched TEXT[];
  technical_token TEXT;
  token_part TEXT;
  cjk_run TEXT;
  character_index INTEGER;
  tokens TEXT[] := ARRAY[]::TEXT[];
BEGIN
  FOR matched IN
    SELECT regexp_matches(
      normalized_text,
      '[a-z0-9]+[a-z0-9._/@:-]*',
      'g'
    )
  LOOP
    technical_token := regexp_replace(
      matched[1],
      '[._/@:-]+$',
      '',
      'g'
    );

    IF char_length(technical_token) >= 2 THEN
      tokens := array_append(tokens, technical_token);
    END IF;

    -- useChat.status 既保留整体，也补充 usechat 与 status，兼顾精确词和子词查询。
    FOR token_part IN
      SELECT value
      FROM regexp_split_to_table(technical_token, '[._/@:-]+') AS value
    LOOP
      IF char_length(token_part) >= 2 AND token_part <> technical_token THEN
        tokens := array_append(tokens, token_part);
      END IF;
    END LOOP;
  END LOOP;

  FOR matched IN
    SELECT regexp_matches(normalized_text, '[㐀-鿿豈-﫿]+', 'g')
  LOOP
    cjk_run := matched[1];

    IF char_length(cjk_run) = 1 THEN
      tokens := array_append(tokens, cjk_run);
    ELSE
      FOR character_index IN 1..char_length(cjk_run) - 1
      LOOP
        tokens := array_append(
          tokens,
          substring(cjk_run FROM character_index FOR 2)
        );
      END LOOP;
    END IF;
  END LOOP;

  RETURN tokens;
END
$$;

-- 生成列会立即为已有记忆计算词项；今后 retrieval_text 改变时也会自动更新，
-- 因此历史数据和新数据始终使用完全相同的 BM25 分词规则。
ALTER TABLE conversation_memories
ADD COLUMN IF NOT EXISTS bm25_terms TEXT[]
  GENERATED ALWAYS AS (bm25_tokenize(retrieval_text)) STORED,
ADD COLUMN IF NOT EXISTS bm25_document_length INTEGER
  GENERATED ALWAYS AS (cardinality(bm25_tokenize(retrieval_text))) STORED;

CREATE INDEX IF NOT EXISTS conversation_memories_bm25_terms_idx
ON conversation_memories
USING GIN (bm25_terms)
WHERE invalidated_at IS NULL;

-- 项目中的字符相似度召回已被 BM25 完全替换。先删除唯一的 trigram 索引，
-- 再移除扩展；不使用 CASCADE，避免误删项目外部可能存在的依赖对象。
DROP INDEX IF EXISTS conversation_memories_retrieval_text_trgm_idx;
DROP EXTENSION IF EXISTS pg_trgm;
