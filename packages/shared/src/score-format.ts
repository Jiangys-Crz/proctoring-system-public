const scoreFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: false,
});

export function formatScore(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? scoreFormat.format(value) : '—';
}
