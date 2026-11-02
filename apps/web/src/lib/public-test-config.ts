/** Hydro's human-readable problem number, configured by the deployment administrator. */
export function publicTestProblemId() {
  const id = process.env.PUBLIC_TEST_PROBLEM_ID?.trim() || 'A1';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(id)) {
    throw new Error('系统测试题号配置无效，请管理员检查 PUBLIC_TEST_PROBLEM_ID');
  }
  return id;
}
