import { isXcpcLeaderboard, type LeaderboardRow } from './leaderboard';

export function leaderboardExportTable(rows: LeaderboardRow[], rule: string, boardKey: string, problems: Array<{ label: string; title: string }>) {
  const xcpc = isXcpcLeaderboard(rule);
  const hideProblems = rule === 'GPLT' && boardKey === 'team';
  const header = ['序号', '排名', '学院', boardKey === 'team' || xcpc ? '队伍名称 / 姓名' : '姓名', '队伍成员', '参赛标识',
    ...(xcpc ? ['解决题目', '总罚时（分钟）'] : ['总分']),
    ...(!hideProblems ? problems.map(problem => `${problem.label} · ${problem.title}`) : []), '奖项'];
  const data = rows.map((row, index) => [index + 1, row.rank === -1 || row.isStar ? '*' : row.rank,
    row.institution || '', row.displayName || row.username, row.members || '', [row.isGirl ? '女生队伍' : '', row.isStar ? '打星参赛' : ''].filter(Boolean).join('、'),
    ...(xcpc ? [row.solved, Math.floor(row.penalty / 60)] : [row.score]),
    ...(!hideProblems ? problems.map((_, problemIndex) => {
      const cell = row.cells?.[problemIndex];
      if (!xcpc) return cell?.score ?? row.problemScores[problemIndex] ?? '';
      if (cell?.accepted ?? row.problemScores[problemIndex] === 1) return `+ ${(cell?.wrong || 0) + 1}/${Math.floor((cell?.seconds || 0) / 60)}`;
      if (cell?.pending) return `? ${cell.pending}`;
      if (cell?.wrong) return `- ${cell.wrong}`;
      return '';
    }) : []),
    !row.isStar && row.medal ? ({ Gold: '金奖', Silver: '银奖', Bronze: '铜奖' }[row.medal]) : '',
  ]);
  return [header, ...data];
}
