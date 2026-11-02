export type RoomCandidateInputType = 'EXAM_NUMBER' | 'STUDENT_ID';

interface RoomCandidateReference {
  examNumber: string;
  studentId?: string | null;
  teamMemberStudentIds?: string | null;
}

export function resolveRoomCandidateInput(input: string, type: RoomCandidateInputType, candidates: RoomCandidateReference[]) {
  const identifiers = [...new Set(input.split(/[、,，;；\s]+/).filter(Boolean))];
  if (!identifiers.length) throw new Error(`请输入考生${type === 'STUDENT_ID' ? '学号' : '考号'}`);
  const matches = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const values = type === 'STUDENT_ID'
      ? [candidate.studentId || '', ...(candidate.teamMemberStudentIds || '').split(/[、,，;；\s]+/)]
      : [candidate.examNumber];
    for (const value of values.map(value => value.trim()).filter(Boolean)) {
      const numbers = matches.get(value) || new Set<string>();
      numbers.add(candidate.examNumber);
      matches.set(value, numbers);
    }
  }
  return [...new Set(identifiers.map(identifier => {
    const numbers = matches.get(identifier);
    const label = type === 'STUDENT_ID' ? '学号' : '考号';
    if (!numbers?.size) throw new Error(`未找到${label}为“${identifier}”的已导入考生，请检查编号或先导入考生`);
    if (numbers.size > 1) throw new Error(`${label}“${identifier}”对应多名考生，请改用考号添加`);
    return [...numbers][0];
  }))];
}
