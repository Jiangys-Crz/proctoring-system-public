import type { CSSProperties } from 'react';

export const BOARD_RESULT_COLORS = { firstAc: '#1B5E20', frozen: '#1447E6', ac: '#4CAF50', wa: '#D32F2F' } as const;
export const BOARD_RESULT_STYLE = {
  '--board-first-ac': BOARD_RESULT_COLORS.firstAc,
  '--board-frozen': BOARD_RESULT_COLORS.frozen,
  '--board-ac': BOARD_RESULT_COLORS.ac,
  '--board-wa': BOARD_RESULT_COLORS.wa,
} as CSSProperties;
