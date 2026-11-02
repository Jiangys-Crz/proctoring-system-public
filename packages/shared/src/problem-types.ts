const problemTypeNames: Readonly<Record<string, string>> = {
  default: '编程题',
  objective: '客观题',
  submit_answer: '提交答案题',
  output_only: '输出题',
  interaction: '交互题',
  communication: '通信题',
  answer: '答案题',
};

export function problemTypeLabel(problemType?: string) {
  const value = problemType || 'default';
  const type = value.toLowerCase();
  return Object.hasOwn(problemTypeNames, type) ? problemTypeNames[type] : value;
}
