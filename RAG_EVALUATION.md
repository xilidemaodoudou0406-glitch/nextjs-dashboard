# RAG 离线评估说明

本项目优先评估“检索到了哪条来源消息”，而不是只让另一个 LLM 主观判断
最终回答。来源 ID 可以确定性验证召回、排序和分支隔离，生成答案的忠实度
评估应作为独立层加入。

## 用例格式

每个用例至少包含：

```ts
{
  id: 'branch-isolation-01',
  category: 'branch_isolation',
  expectedMemoryIds: ['当前分支允许召回的记忆 ID'],
  forbiddenMemoryIds: ['兄弟分支或锚点之后的记忆 ID'],
  retrievedMemoryIds: ['按实际检索顺序记录的记忆 ID'],
  latencyMs: 123,
}
```

指标由 `app/lib/ai/evaluation.ts` 的 `evaluateRetrievalCases()` 计算：

- `Recall@K`：正确来源是否进入候选集；
- `Precision@K`：前 K 条中有多少真正相关；
- `MRR`：第一条正确来源的排名；
- `branchLeakageRate`：包含禁止来源的用例比例，目标必须为 0；
- `noAnswerAccuracy`：没有相关历史时能否返回空结果；
- `averageLatencyMs`：检索阶段平均耗时。

## 建议数据集

至少准备 30 条，六类各 5 条：

1. 同义改写与普通语义召回；
2. 错误码、版本号、函数名等精确实体；
3. “它、这个、刚才”等上下文指代；
4. 超出最近上下文预算的旧事实；
5. 父对话锚点、兄弟分支和跨用户隔离；
6. 新旧事实冲突及历史中不存在答案的问题。

`/api/chat` 在非生产环境会输出不含用户原文的 `RAG retrieval trace`，其中包含
dense/keyword 候选 ID、最终选择、各阶段耗时和降级原因。先从日志整理真实
来源 ID，再固定为回归用例；不要为了得到好看的数字临时修改标签。

## 对比顺序

每次只改变一个变量：

```text
纯向量基线
→ 向量 + 关键词 + RRF
→ 增加条件式查询改写
→ 如果 Recall@10 高但 Precision@3 低，再增加独立 Reranker
```

Embedding 模型、评估数据和分支范围在同一轮对比中保持不变。只有当正确记忆
长期无法进入候选集，并排除查询和检索策略问题后，才比较新的 Embedding 模型。
