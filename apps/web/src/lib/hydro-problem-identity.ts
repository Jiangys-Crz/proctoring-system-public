/** Hydro's pid is an editable display label. Only its numeric document ID may
 * identify a problem in mappings, imports, file reads, and judge submissions. */
export function hydroProblemDocId(problem: { docId?: unknown; id?: unknown }) {
  const id = String(problem.docId ?? problem.id ?? '');
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('评测服务未返回有效的 Hydro 内部 docId，请更新 Hydro 插件');
  return id;
}
