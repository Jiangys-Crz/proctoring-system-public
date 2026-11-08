export function parseCsvLine(line: string) {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ',' && !quoted) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

export function parseCsvRecords(text: string) {
  const records: string[][] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && /[\r\n]/.test(text[index])) {
      records.push(parseCsvLine(text.slice(start, index)));
      if (text[index] === '\r' && text[index + 1] === '\n') index += 1;
      start = index + 1;
    }
  }
  if (quoted) throw new Error('表格内容存在未闭合的引号，请检查文件格式');
  records.push(parseCsvLine(text.slice(start)));
  return records.filter(cells => cells.some(cell => cell !== ''));
}

export function parseCandidateCsv(text: string) {
  const [headers, ...records] = parseCsvRecords(text);
  if (!headers) return [];
  const rows = records.map((cells) => {
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] || '';
    });
    const memberOrderText = row['成员次序'] || row['成员顺序'] || row.memberOrder;
    return {
      name: row['姓名'] || row.name || undefined,
      studentId: row['学号'] || row.studentId || undefined,
      school: row['学校'] || row['大学'] || row['高校'] || row.school || row['学院'] || undefined,
      college: row['学院'] || row.college || undefined,
      major: row['专业'] || row.major || undefined,
      gender: row['性别'] || row.gender || undefined,
      gradeYear: row['年级'] || row.gradeYear || undefined,
      className: row['行政班级'] || row['班级'] || row.className || undefined,
      advisor: row['指导老师'] || row.advisor || undefined,
      groupName: row['参赛组别'] || row['队伍类型'] || row['组别'] || row.groupName || undefined,
      teamName: row['队伍名称'] || row.teamName || undefined,
      teamMembers: row['队伍成员姓名'] || row['队伍成员'] || row.teamMembers || undefined,
      teamMemberStudentIds: row['队伍成员学号'] || row['队伍成员对应学号'] || row.teamMemberStudentIds || undefined,
      memberOrder: memberOrderText?.trim() ? Number(memberOrderText) : undefined,
      examNumber: row['考号'] || row['比赛账号'] || row.examNumber || '',
      password: row['密码'] || row['比赛密码'] || row.password || '',
      seatNo: row['座位号'] || row.seatNo || '',
      roomName: row['考室'] || row['考室名称'] || row.roomName || undefined,
      isTeamLeader: ['是', 'true', '1'].includes((row['是否队长'] || row.isTeamLeader || '').toLowerCase()),
      ranked: !['否', 'false', '0'].includes((row['是否排名'] || row['是否参与排名'] || row.ranked || '是').toLowerCase())
    };
  });
  const teamRows = new Map<string, typeof rows>();
  for (const row of rows) if (row.teamName) teamRows.set(row.teamName, [...(teamRows.get(row.teamName) || []), row]);
  for (const group of teamRows.values()) {
    const legacyLeader = group.find(row => row.isTeamLeader) || group[0]; let nextMember = 2;
    for (const row of group) {
      row.memberOrder ??= row === legacyLeader ? 1 : nextMember++;
      row.isTeamLeader = row.memberOrder === 1;
    }
  }
  return rows;
}

/** Team-account imports may contain one row per member in legacy exports. */
export function mergeTeamCandidateRows(rows: ReturnType<typeof parseCandidateCsv>) {
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.teamName || row.examNumber;
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  const split = (value: string) => value.split(/[、,，;；\s]+/).map(item => item.trim()).filter(Boolean);
  return [...groups.values()].map(unsorted => {
    const group = [...unsorted].sort((a,b) => (a.memberOrder || 1) - (b.memberOrder || 1));
    if (group.some(row => row.memberOrder !== undefined) && !group.some(row => row.memberOrder === 1)) throw new Error(`队伍 ${group[0].teamName || ''} 缺少 1 号队长`);
    const credential = group.find(row => row.memberOrder === 1) || group[0];
    if (!credential.examNumber || !credential.password) throw new Error(`队伍 ${credential.teamName || ''} 的 1 号队长须填写考号和密码`);
    if (group.some(row => row !== credential && (row.examNumber || row.password))) throw new Error(`队伍 ${credential.teamName || ''} 共用账号时只有 1 号队长填写考号和密码`);
    const orders = group.map((row, index) => row.memberOrder || index + 1);
    if (new Set(orders).size !== orders.length) throw new Error(`队伍 ${credential.teamName || ''} 成员次序重复`);
    const roomNames = [...new Set(group.map(row => row.roomName?.trim()).filter(Boolean))];
    if (roomNames.length > 1) throw new Error(`队伍 ${credential.teamName || credential.examNumber} 的考室必须一致`);
    const names = group.flatMap(row => row.teamMembers ? split(row.teamMembers) : row.name ? [row.name] : []);
    const studentIds = group.flatMap(row => row.teamMemberStudentIds ? split(row.teamMemberStudentIds) : row.studentId ? [row.studentId] : []);
    return { ...credential, name: credential.name || names[0], studentId: credential.studentId || studentIds[0], roomName: roomNames[0], teamMembers: names.join('、'), teamMemberStudentIds: studentIds.join('、'),
      teamRoster: group.flatMap((row,index) => { const { teamMembers: legacyNames, teamMemberStudentIds: legacyIds, ...member } = row; delete (member as Record<string, unknown>).teamRoster; const memberNames = legacyNames ? split(legacyNames) : [row.name || '']; const memberIds = legacyIds ? split(legacyIds) : [row.studentId || '']; return memberNames.map((name, offset) => ({ ...member, name, studentId: memberIds[offset], memberOrder: orders[index] + offset, examNumber: offset ? '' : row.examNumber, password: offset ? '' : row.password, isTeamLeader: orders[index] + offset === 1 })); }), memberOrder: 1, isTeamLeader: true };
  });
}
