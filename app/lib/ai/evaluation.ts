export type RetrievalEvaluationCase = {
  id: string
  category:
    | 'semantic'
    | 'exact_entity'
    | 'coreference'
    | 'long_history'
    | 'branch_isolation'
    | 'temporal_conflict'
    | 'no_answer'
  expectedMemoryIds: string[]
  forbiddenMemoryIds?: string[]
  retrievedMemoryIds: string[]
  latencyMs?: number
}

export type RetrievalEvaluationReport = {
  caseCount: number
  recallAtK: number
  precisionAtK: number
  meanReciprocalRank: number
  branchLeakageRate: number
  noAnswerAccuracy: number
  averageLatencyMs: number | null
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * 根据人工标注的来源消息 ID 计算确定性检索指标。
 * 这里只评估“取回了什么”，不评价模型最终回答的文风或完整程度。
 */
export function evaluateRetrievalCases(
  cases: RetrievalEvaluationCase[],
  k = 5,
): RetrievalEvaluationReport {
  const safeK = Math.max(Math.trunc(k), 1)
  const answerableCases = cases.filter(
    (testCase) => testCase.expectedMemoryIds.length > 0,
  )
  const noAnswerCases = cases.filter(
    (testCase) => testCase.expectedMemoryIds.length === 0,
  )

  // Recall@K：应该召回的记忆中，有多少出现在前 K 条结果里。
  const recall = answerableCases.map((testCase) => {
    const retrieved = new Set(testCase.retrievedMemoryIds.slice(0, safeK))
    const relevantRetrieved = testCase.expectedMemoryIds.filter((id) =>
      retrieved.has(id),
    ).length
    return relevantRetrieved / testCase.expectedMemoryIds.length
  })

  // Precision@K：实际返回的前 K 条结果中，有多少是人工标注的相关记忆。
  const precision = answerableCases.map((testCase) => {
    const expected = new Set(testCase.expectedMemoryIds)
    const topK = testCase.retrievedMemoryIds.slice(0, safeK)
    if (topK.length === 0) return 0
    return topK.filter((id) => expected.has(id)).length / topK.length
  })

  // MRR 关注第一条正确结果的位置：排第 1 得 1 分，排第 2 得 1/2 分。
  const reciprocalRanks = answerableCases.map((testCase) => {
    const expected = new Set(testCase.expectedMemoryIds)
    const rank = testCase.retrievedMemoryIds.findIndex((id) => expected.has(id))
    return rank === -1 ? 0 : 1 / (rank + 1)
  })

  const casesWithForbiddenMemories = cases.filter(
    (testCase) => (testCase.forbiddenMemoryIds?.length ?? 0) > 0,
  )
  // forbiddenMemoryIds 用于标注兄弟分支、锚点之后或其他用户的禁止来源。
  const leakedCases = casesWithForbiddenMemories.filter((testCase) => {
    const forbidden = new Set(testCase.forbiddenMemoryIds)
    return testCase.retrievedMemoryIds.some((id) => forbidden.has(id))
  })

  const noAnswerCorrect = noAnswerCases.filter(
    (testCase) => testCase.retrievedMemoryIds.length === 0,
  ).length
  // 没有记录耗时的离线用例不会被强行按 0ms 计入平均值。
  const latencyValues = cases.flatMap((testCase) =>
    testCase.latencyMs === undefined ? [] : [testCase.latencyMs],
  )

  return {
    caseCount: cases.length,
    recallAtK: mean(recall),
    precisionAtK: mean(precision),
    meanReciprocalRank: mean(reciprocalRanks),
    branchLeakageRate:
      casesWithForbiddenMemories.length === 0
        ? 0
        : leakedCases.length / casesWithForbiddenMemories.length,
    noAnswerAccuracy:
      noAnswerCases.length === 0 ? 0 : noAnswerCorrect / noAnswerCases.length,
    averageLatencyMs:
      latencyValues.length === 0 ? null : mean(latencyValues),
  }
}
