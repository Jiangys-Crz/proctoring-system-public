'use client';

import { memo, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ContestDisplayCharts, ContestDisplayResponse } from '@/lib/contest-display-contract';
import styles from './DisplayChartScenes.module.css';

const chartNames = {
  problemDetailChart: 'Problem Submissions',
  problemComparisonChart: 'Submissions by Problem',
  problemSummaryChart: 'Attempts & Solutions by Problem',
  totalProblemsChart: 'Total Problem Submissions',
  languageSummaryChart: 'Attempts & Solutions by Language',
  judgementChart: 'Average Judgement Time by Problem',
  judgeQueueDepthChart: 'Judgement Queue Depth',
  scoreboardChart: 'Scoreboard Standing',
  historicalComparisonChart: 'Historical Comparison',
  testChart: 'Test Chart',
} as const;

type ChartDisplayScene = keyof typeof chartNames;
type Marker = 'square' | 'circle';
type Series = { name: string; values: readonly (number | null)[]; colors: readonly string[]; outlines: readonly string[]; marker?: Marker };
type Chart = {
  title: string;
  axis: string;
  series: Series[];
  labels: (string | undefined)[];
  bars?: boolean;
  stroke?: number;
  valueLabel?: (value: number) => string;
};
type ProblemSeries = ContestDisplayCharts['problems'][number];

const statusColors = { failed: '#f00000', pending: '#f6d900', solved: '#00e600', frozen: '#246bd0' };
const languageColors = ['#5c8add', '#ffdf36', '#c43a24'];
const rankColors = ['#ff0000', '#00ff00', '#0000ff', '#00ffff'];
const historyColors = ['#ff00ff', '#0000ff', '#ffff00', '#ff0000', '#00ff00'];
const repeatMs = 15_000;
const countLabel = (value: number) => value ? String(Math.round(value)) : '';
const timeLabel = (value: number) => value > 950 ? `${(value / 1000).toFixed(1)}s` : value ? `${Math.round(value)}ms` : '';

export function isChartDisplayScene(scene: string): scene is ChartDisplayScene {
  return Object.hasOwn(chartNames, scene);
}

function rgb(color: string) {
  const normalized = color.slice(1);
  const digits = normalized.length === 3 ? [...normalized].map(digit => digit + digit).join('') : normalized;
  return (digits.match(/.{2}/g) ?? []).map(pair => Number.parseInt(pair, 16));
}

function outline(channels: number[], alpha = 1) {
  const brighter = channels.some(channel => channel > 0)
    ? channels.map(channel => channel > 0 ? Math.min(255, Math.floor(Math.max(3, channel) / 0.7)) : 0)
    : [192, 192, 192];
  return `rgb(${brighter.join(' ')} / ${alpha})`;
}

function series(name: string, values: readonly (number | null)[], color: string, marker?: Marker): Series {
  return { name, values, colors: [color], outlines: [outline(rgb(color))], marker };
}

function pairedBars(labels: string[], colors: string[], values: [number[], number[]], names: [string, string], factor = 0.8) {
  const channels = colors.map(rgb);
  const muted = channels.map(color => color.map(channel => Math.floor(channel * factor)));
  const opacity = 200 / 255;
  return {
    bars: true, labels,
    series: [
      { name: names[0], colors, outlines: channels.map(color => outline(color)), values: values[0] },
      {
        name: names[1], values: values[1],
        colors: muted.map(color => `rgb(${color.join(' ')} / ${opacity})`),
        outlines: muted.map(color => outline(color, opacity)),
      },
    ],
  };
}

function sumBuckets(rows: readonly (readonly number[] | undefined)[]) {
  const length = Math.max(0, ...rows.map(row => row?.length ?? 0));
  return Array.from({ length }, (_, index) => rows.reduce((sum, row) => sum + (row?.[index] ?? 0), 0));
}

function hourLabels(length: number, stepSeconds: number) {
  const indexPerHour = 3_600 / stepSeconds;
  const labels = Array<string | undefined>(length);
  if (!Number.isFinite(indexPerHour) || indexPerHour <= 0) return labels;
  for (let hour = 1; Math.round(hour * indexPerHour) < length; hour++) {
    const index = Math.round(hour * indexPerHour);
    if (index > 0) labels[index] = hour === 1 ? '1 hour' : `${hour} hours`;
  }
  return labels;
}

function statusSeries(rows: ProblemSeries[], marker: Marker, prefix = '') {
  const buckets = (key: 'failed' | 'pending' | 'solved' | 'frozen') => sumBuckets(rows.map(row => row[key]));
  const name = (base: string) => prefix ? prefix + base.toLowerCase() : base;
  const result = [
    series(name('Failed submissions'), buckets('failed'), statusColors.failed, marker),
    series(name('Pending submissions'), buckets('pending'), statusColors.pending, marker),
    series(name('Solved submissions'), buckets('solved'), statusColors.solved, marker),
  ];
  const frozen = buckets('frozen');
  if (frozen.some(value => value > 0)) result.push(series(name('Frozen submissions'), frozen, statusColors.frozen, marker));
  return result;
}

function chartFor(
  scene: ChartDisplayScene,
  { problems, statistics, teams }: ContestDisplayResponse['contest'],
  charts: ContestDisplayCharts | undefined,
  problemId: string | null,
  problemIndex: number,
  time: number,
): Chart {
  const title = chartNames[scene];
  const emptyChart: Chart = { title, axis: '', series: [], labels: [] };
  const interval = charts?.intervalSeconds || 300;
  const submissionsAxis = `# of submissions every ${interval / 60} minutes`;
  const problemSeries = new Map(charts?.problems.map(row => [row.problemId, row]));
  const colors = problems.map(({ color }) => color && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color) ? color : '#000000');
  const labels = problems.map(problem => problem.label);
  switch (scene) {
    case 'problemDetailChart': {
      const problem = problems.find(item => item.id === problemId) ?? problems[problemIndex];
      if (!problem) return emptyChart;
      const problemTitle = `Problem ${problem.label} Submissions`;
      const counts = problemSeries.get(problem.id);
      if (!counts) return { ...emptyChart, title: problemTitle };
      return { title: problemTitle, axis: submissionsAxis, labels: hourLabels(counts.failed.length, interval), series: statusSeries([counts], 'square') };
    }
    case 'problemComparisonChart': {
      const comparisons = problems.flatMap((problem, index) => {
        const counts = problemSeries.get(problem.id);
        if (!counts) return [];
        const color = rgb(colors[index]).every(channel => !channel) ? '#404040' : colors[index];
        return series(`Problem ${problem.label}`, sumBuckets([counts.failed, counts.pending, counts.solved, counts.frozen]), color, 'square');
      });
      return { title, axis: submissionsAxis, labels: hourLabels(comparisons[0]?.values.length ?? 0, interval), series: comparisons };
    }
    case 'problemSummaryChart': {
      const results = new Map(statistics.map(item => [item.problemId, item]));
      const attempts = problems.map(problem => {
        const result = results.get(problem.id);
        return result ? result.accepted + result.rejected + result.pending : 0;
      });
      const solutions = problems.map(problem => results.get(problem.id)?.teamsAccepted ?? 0);
      return { title, axis: '# of submissions', ...pairedBars(labels, colors, [attempts, solutions], ['# of submissions', '# of solved submissions']) };
    }
    case 'totalProblemsChart': {
      if (!charts?.problems.length) return emptyChart;
      const totals = statusSeries(charts.problems, 'circle', '# of ');
      return { title, axis: submissionsAxis, labels: hourLabels(totals[0].values.length, interval), series: totals };
    }
    case 'languageSummaryChart': {
      const languages = charts?.languages;
      if (!languages?.length) return emptyChart;
      const languageLabels = languages.map(item => item.name);
      const colors = languages.map((_, index) => languageColors[index % languageColors.length]);
      const values: [number[], number[]] = [languages.map(item => item.attempts), languages.map(item => item.solved)];
      return { title, axis: '# of submissions', ...pairedBars(languageLabels, colors, values, ['# of submissions', '# of solutions'], 0.85) };
    }
    case 'judgementChart': {
      if (!charts?.problems.some(item => item.judgement)) return emptyChart;
      const solutions = problems.map(problem => problemSeries.get(problem.id)?.judgement?.solvedMs ?? 0);
      const attempts = problems.map(problem => problemSeries.get(problem.id)?.judgement?.failedMs ?? 0);
      return { title, axis: 'Time', valueLabel: timeLabel, ...pairedBars(labels, colors, [solutions, attempts], ['Solution Judgement Time', 'Attempt Judgement Time']) };
    }
    case 'judgeQueueDepthChart': {
      const queue = charts?.queueDepth;
      if (!queue?.values.length) return emptyChart;
      return {
        title, axis: 'Depth', stroke: 1, labels: hourLabels(queue.values.length, queue.stepSeconds || 1),
        series: [series('Queued Submissions', queue.values, statusColors.solved)],
      };
    }
    case 'scoreboardChart': {
      const names = new Map(teams.map(team => [team.id, team.name]));
      const ranks = (charts?.ranks ?? []).slice(0, rankColors.length).flatMap((item, index) => {
        const team = names.get(item.teamId);
        return team ? [series(team, item.values, rankColors[index])] : [];
      });
      return { title, axis: 'Rank', labels: hourLabels(ranks[0]?.values.length ?? 0, interval), series: ranks };
    }
    case 'historicalComparisonChart': {
      const history = charts?.history;
      if (!history?.past.length) return emptyChart;
      const past = history.past.slice(0, historyColors.length - 1);
      const comparisons = past.map(({ label, values }, index) => series(label, values, historyColors[index]));
      comparisons.push(series('Current', history.current, historyColors[past.length]));
      const length = Math.max(history.current.length, ...past.map(({ values }) => values.length));
      return { title, axis: '# of solutions', labels: hourLabels(length, interval), series: comparisons };
    }
    case 'testChart': {
      const labels = [...'ABCDEFGHI'];
      const values = labels.map((_, index) => 30 + Math.sin(index - time / 5000) * 15 + Math.sin(time / 10_000) * 12);
      const colors = labels.map((_, index) => languageColors[index % languageColors.length]);
      return {
        title, axis: 'Widgets', bars: true, labels, valueLabel: value => value.toFixed(1),
        series: [{ name: 'Widgets', values, colors, outlines: colors.map(color => outline(rgb(color))) }],
      };
    }
  }
}

function useChartSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1920, height: 1080 });
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    const measure = () => {
      const { clientWidth: width, clientHeight: height } = frame;
      if (width && height) setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

function maximumFor(chart: Chart) {
  let highest = 0;
  for (const { values } of chart.series) {
    for (const value of values) highest = Math.max(highest, value ?? 0);
  }
  return Math.max(1, Math.ceil(highest * (chart.bars ? 1.1 : 1.01)));
}

function lineSections(values: Series['values'], x: (index: number) => number, y: (value: number) => number) {
  const sections: string[] = [];
  let segment: string[] = [];
  values.forEach((value, index) => {
    if (value !== null) {
      segment.push(`${x(index).toFixed(2)},${y(value).toFixed(2)}`);
    } else if (segment.length) {
      sections.push(segment.join(' '));
      segment = [];
    }
  });
  if (segment.length) sections.push(segment.join(' '));
  return sections;
}

function fitLegendName(name: string, width: number, measure: (text: string) => number) {
  if (measure(name) <= width) return name;
  const characters = Array.from(name);
  while (characters.length && measure(characters.join('') + '…') > width) characters.pop();
  return characters.join('') + '…';
}

const ChartCanvas = memo(function ChartCanvas({ chart, elapsed, width, height }: { chart: Chart; elapsed: number; width: number; height: number }) {
  const clipId = useId();
  const [initialElapsed] = useState(elapsed);
  const titleSize = Math.max(9, Math.floor(height * 0.04125));
  const labelSize = Math.max(8, Math.floor(height * 0.03375));
  const labelHeight = Math.ceil(labelSize * 1.15);
  const measure = useMemo(() => {
    if (typeof document === 'undefined') return (value: string) => value.length * labelSize * 0.56;
    const canvas = document.createElement('canvas').getContext('2d');
    if (!canvas) return (value: string) => value.length * labelSize * 0.56;
    canvas.font = `${labelSize}px Helvetica, Arial, sans-serif`;
    return (value: string) => canvas.measureText(value).width;
  }, [labelSize]);

  const scale = useMemo(() => maximumFor(chart), [chart]);
  const step = Math.max(1, Math.floor(scale / 20) * 5);
  const ticks = Array.from({ length: Math.floor(scale / step) + 1 }, (_, index) => step * index);
  const left = Math.ceil(measure(String(ticks.at(-1)))) + labelHeight + 20;
  const top = Math.ceil(titleSize * 1.15) + 25;
  const right = width - labelHeight - 15;
  const bottom = height - Math.ceil(labelSize * 0.8) - 18;
  const barWidth = (right - left) / Math.max(1, chart.labels.length);
  const x = (index: number) => chart.bars
    ? left + (index + 0.5) * barWidth
    : left + index * (right - left) / Math.max(1, chart.labels.length - 1);
  const y = (value: number) => (top - bottom) * value / scale;
  const legendHeight = chart.series.length * (labelHeight + 10) + 10;
  const widestSeriesName = Math.max(0, ...chart.series.map(item => measure(item.name)));
  const legendTextWidth = Math.max(0, Math.min(width - 2 * labelHeight - 45, widestSeriesName));
  const legendWidth = legendTextWidth + labelHeight + 30;
  const legendX = width - (width - right) / 2 - legendWidth;
  const legendY = top + (width - right) / 2;
  const delay = { '--chart-offset': `${-initialElapsed}ms` } as CSSProperties;

  return <svg className={styles.chart} role="img" aria-label={chart.title} viewBox={`0 0 ${width} ${height}`} style={delay}>
    <text x={width / 2} y={titleSize + 5} textAnchor="middle" fontSize={titleSize} fontWeight="bold">{chart.title}</text>
    {chart.labels.length === 0 || right <= left || bottom <= top ? <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={labelSize}>No Data</text> : <>
      <text transform={`translate(${labelHeight},${height / 2}) rotate(-90)`} textAnchor="middle" fontSize={labelSize}>{chart.axis}</text>
      <g fontSize={labelSize}>
        {ticks.map(value => <g key={value}>
          <line className={value ? styles.grid : styles.baseline} x1={left} x2={right} y1={bottom + y(value)} y2={bottom + y(value)} />
          <text x={left - 7} y={bottom + y(value) + labelSize * 0.42} textAnchor="end">{value}</text>
        </g>)}
        {chart.labels.map((label, index) => label && <text key={index} x={x(index)} y={height - 10} textAnchor="middle"
          textLength={chart.bars && measure(label) > barWidth * 0.94 ? barWidth * 0.94 : undefined}
          lengthAdjust="spacingAndGlyphs">{label}</text>)}
      </g>
      {chart.bars ? <>
        <g transform={`translate(0 ${bottom})`}>
          <g className={styles.bars} aria-hidden>
            {chart.series.map(({ name, values, colors, outlines }, seriesIndex) => <g key={name}>
              {values.map((value, index) => {
                const single = chart.series.length === 1;
                const width = barWidth * (single ? 0.8 : 0.7);
                const center = x(index) + (single ? 0 : barWidth * (seriesIndex === 0 ? 0.1 : -0.1));
                return <rect key={index} className={styles.bar} x={center - width / 2} y={y(value ?? 0)} width={width} height={-y(value ?? 0)}
                  fill={colors[index]} stroke={outlines[index]} strokeWidth="2" />;
              })}
            </g>)}
          </g>
        </g>
        <g className={styles.values} fontSize={labelSize} textAnchor="middle" aria-hidden>
          {chart.series.map(({ name, values }, seriesIndex) => <g key={name}>
            {values.map((value, index) => {
              const offset = chart.series.length === 1 ? 0 : barWidth * (seriesIndex === 0 ? 0.1 : -0.1);
              if (value === null) return null;
              return <text className={styles.barValue} key={index} x={x(index) + offset} y={bottom + y(value) - 6}>{(chart.valueLabel ?? countLabel)(value)}</text>;
            })}
          </g>)}
        </g>
      </> : <>
        <defs><clipPath id={clipId}>
          <rect className={styles.lineClip} x={left - 4} y={top - 4} width={right - left + 8} height={bottom - top + 8} />
        </clipPath></defs>
        <g clipPath={`url(#${clipId})`} aria-hidden>
          {chart.series.map(({ colors, values, marker }, seriesIndex) => <g key={seriesIndex}>
            {lineSections(values, x, value => bottom + y(value)).map((points, index) => (
              <polyline key={index} points={points} fill="none" stroke={colors[0]} strokeWidth={chart.stroke ?? 3} />
            ))}
            {marker && values.map((value, index) => value === null ? null : marker === 'square'
              ? <rect key={index} x={x(index) - 2} y={bottom + y(value) - 2} width="5" height="5" fill={colors[0]} />
              : <circle key={index} cx={x(index)} cy={bottom + y(value)} r="3.5" fill={colors[0]} />)}
          </g>)}
        </g>
      </>}
      {chart.series.length > 1 && <g transform={`translate(${Math.max(0, legendX)} ${legendY})`} className={styles.legend} fontSize={labelSize} aria-hidden>
        <rect className={styles.legendBackground} width={legendWidth} height={legendHeight} />
        {chart.series.map(({ name, colors, outlines }, index) => {
          const label = fitLegendName(name, legendTextWidth, measure);
          return <g key={index} transform={`translate(10 ${10 + index * (labelHeight + 10)})`}>
            {label !== name && <title>{name}</title>}
            <rect width={labelHeight} height={labelHeight} fill={colors[0]} stroke={outlines[0]} strokeWidth="2" />
            <text x={labelHeight + 10} y={labelHeight - 3}>{label}</text>
          </g>;
        })}
      </g>}
    </>}
  </svg>;
}, (previous, next) => previous.chart === next.chart && previous.width === next.width && previous.height === next.height);

export function DisplayChartScene({ scene, data, elapsed }: { scene: ChartDisplayScene; data: ContestDisplayResponse; elapsed: number }) {
  const { ref, size } = useChartSize();
  const { contest, charts, settings: { problemId } } = data;
  const autoProblem = scene === 'problemDetailChart' && !problemId;
  const problemIndex = autoProblem ? Math.floor(elapsed / repeatMs) % Math.max(1, contest.problems.length) : 0;
  const frameTime = scene === 'testChart' ? Math.floor(elapsed / 800) * 800 : 0;
  const chart = useMemo(() => chartFor(scene, contest, charts, problemId, problemIndex, frameTime), [charts, contest, frameTime, problemId, problemIndex, scene]);
  return <div ref={ref} className={styles.frame}>
    <ChartCanvas key={`${data.startedAt}:${scene}:${problemIndex}:${chart.title}`} chart={chart}
      elapsed={autoProblem ? elapsed % repeatMs : elapsed} {...size} />
  </div>;
}
