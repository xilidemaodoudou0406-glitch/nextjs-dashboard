import { describe, expect, it } from 'vitest'

import { buildBranchUrl } from './url'

describe('buildBranchUrl', () => {
  it('adds a persisted branch while preserving other query parameters', () => {
    expect(
      buildBranchUrl({
        pathname: '/chat/main-id',
        searchParams: new URLSearchParams('view=compact'),
        branchId: 'branch-id',
      }),
    ).toBe('/chat/main-id?view=compact&branch=branch-id')
  })

  it('replaces the active branch instead of appending a duplicate', () => {
    expect(
      buildBranchUrl({
        pathname: '/chat/main-id',
        searchParams: new URLSearchParams(
          'branch=old-branch&view=compact',
        ),
        branchId: 'new-branch',
      }),
    ).toBe('/chat/main-id?branch=new-branch&view=compact')
  })

  it('removes only the branch parameter when the panel closes', () => {
    expect(
      buildBranchUrl({
        pathname: '/chat/main-id',
        searchParams: new URLSearchParams(
          'branch=branch-id&view=compact',
        ),
        branchId: null,
      }),
    ).toBe('/chat/main-id?view=compact')
  })
})
