import { BOARD_RESULT_COLORS } from './boardResultColors';

export const BOARD_SCORE_LEVELS = [
  { max: 25, color: '#ffccc7', textColor: '#172131', label: '0–25%' },
  { max: 50, color: '#bae7ff', textColor: '#172131', label: '>25–50%' },
  { max: 75, color: '#d9f7be', textColor: '#172131', label: '>50–75%' },
  { max: Infinity, color: BOARD_RESULT_COLORS.ac, textColor: '#fff', label: '>75–100%' },
];

export function getBoardScoreLevel(score: number, maximum: number) {
  const percent = maximum > 0 ? score / maximum * 100 : 0;
  return BOARD_SCORE_LEVELS.find(level => percent <= level.max) || BOARD_SCORE_LEVELS[BOARD_SCORE_LEVELS.length - 1];
}
