import { describe, expect, it } from 'vitest'

import { evaluateRetrievalCases } from './evaluation'

describe('RAG retrieval evaluation', () => {
  it('calculates retrieval quality, isolation and no-answer metrics', () => {
    const report = evaluateRetrievalCases(
      [
        {
          id: 'semantic-1',
          category: 'semantic',
          expectedMemoryIds: ['postgres'],
          retrievedMemoryIds: ['noise', 'postgres'],
          latencyMs: 100,
        },
        {
          id: 'branch-1',
          category: 'branch_isolation',
          expectedMemoryIds: ['branch-postgres'],
          forbiddenMemoryIds: ['sibling-mysql'],
          retrievedMemoryIds: ['branch-postgres'],
          latencyMs: 200,
        },
        {
          id: 'no-answer-1',
          category: 'no_answer',
          expectedMemoryIds: [],
          retrievedMemoryIds: [],
        },
      ],
      3,
    )

    expect(report.caseCount).toBe(3)
    expect(report.recallAtK).toBe(1)
    expect(report.precisionAtK).toBe(0.75)
    expect(report.meanReciprocalRank).toBe(0.75)
    expect(report.branchLeakageRate).toBe(0)
    expect(report.noAnswerAccuracy).toBe(1)
    expect(report.averageLatencyMs).toBe(150)
  })
})
