/**
 * 构造分支面板对应的 URL，同时保留页面上其他查询参数。
 *
 * 持久化分支才拥有 branchId，因此草稿面板不会调用这个函数写入
 * `branch`。传入 null 表示关闭面板，只移除 branch 参数。
 */
export function buildBranchUrl({
  pathname,
  searchParams,
  branchId,
}: {
  pathname: string
  searchParams: Pick<URLSearchParams, 'toString'>
  branchId: string | null
}): string {
  const nextSearchParams = new URLSearchParams(searchParams.toString())

  if (branchId) {
    nextSearchParams.set('branch', branchId)
  } else {
    nextSearchParams.delete('branch')
  }

  const query = nextSearchParams.toString()
  return query ? `${pathname}?${query}` : pathname
}
