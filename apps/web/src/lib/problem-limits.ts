function numberWithUnit(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return { amount: value, unit: '' };
  if (typeof value !== 'string') return null;
  const match = value.trim().toLowerCase().replace(/\s+/g, '').match(/^(\d+(?:\.\d+)?)([a-z]*)$/);
  if (!match) return null;
  return { amount: Number(match[1]), unit: match[2] };
}

export function parseTimeLimitMs(value: unknown) {
  const parsed = numberWithUnit(value);
  if (!parsed || parsed.amount <= 0) return null;
  const multiplier = parsed.unit === 's' || parsed.unit === 'sec' || parsed.unit === 'secs'
    ? 1000
    : parsed.unit === 'm' || parsed.unit === 'min' || parsed.unit === 'mins'
      ? 60_000
      : 1;
  return Math.round(parsed.amount * multiplier);
}

export function parseMemoryLimitMb(value: unknown) {
  const parsed = numberWithUnit(value);
  if (!parsed || parsed.amount <= 0) return null;
  const multiplier = parsed.unit === 'g' || parsed.unit === 'gb' || parsed.unit === 'gib'
    ? 1024
    : parsed.unit === 'k' || parsed.unit === 'kb' || parsed.unit === 'kib'
      ? 1 / 1024
      : parsed.unit === 'b' || parsed.unit === 'byte' || parsed.unit === 'bytes'
        ? 1 / (1024 * 1024)
        : 1;
  return Math.max(1, Math.round(parsed.amount * multiplier));
}

export function problemLimits(config: Record<string, unknown>) {
  if (['objective', 'submit_answer'].includes(String(config.type || '').toLowerCase())) {
    return { timeLimitMs: null, memoryLimitMb: null };
  }
  // Match Hydro's defaults and case -> subtask -> global inheritance.
  const time = parseTimeLimitMs(config.timeLimit) ?? parseTimeLimitMs(config.time) ?? 1000;
  const memory = parseMemoryLimitMb(config.memoryLimit) ?? parseMemoryLimitMb(config.memory) ?? 256;
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const subtasks = Array.isArray(config.cases) && config.cases.length
    ? [{ cases: config.cases }] : Array.isArray(config.subtasks) ? config.subtasks : [];
  const caseLimits = subtasks.flatMap(value => {
    const subtask = record(value);
    const subtaskTime = parseTimeLimitMs(subtask.time) ?? time;
    const subtaskMemory = parseMemoryLimitMb(subtask.memory) ?? memory;
    return (Array.isArray(subtask.cases) ? subtask.cases : []).map(value => {
      const testcase = record(value);
      return {
        time: parseTimeLimitMs(testcase.time) ?? subtaskTime,
        memory: parseMemoryLimitMb(testcase.memory) ?? subtaskMemory,
      };
    });
  });
  return {
    timeLimitMs: parseTimeLimitMs(config.timeMax) ?? (caseLimits.length ? caseLimits.reduce((maximum, item) => Math.max(maximum, item.time), 0) : time),
    memoryLimitMb: parseMemoryLimitMb(config.memoryMax) ?? (caseLimits.length ? caseLimits.reduce((maximum, item) => Math.max(maximum, item.memory), 0) : memory),
  };
}
