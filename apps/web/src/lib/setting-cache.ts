/** Small, process-local cache for configuration, never sessions or permissions. */
export function createSettingCache<T>(ttlMs = 1_000) {
  let entry: { value: T; expiresAt: number } | undefined;
  let pending: Promise<T> | undefined;
  let generation = 0;
  return {
    async read(load: () => Promise<T>): Promise<T> {
      if (entry && entry.expiresAt > Date.now()) return structuredClone(entry.value);
      if (!pending) {
        const version = generation;
        const request = Promise.resolve().then(load).then(value => {
          if (generation === version) entry = { value: structuredClone(value), expiresAt: Date.now() + ttlMs };
          return value;
        }).finally(() => { if (pending === request) pending = undefined; });
        pending = request;
      }
      return structuredClone(await pending);
    },
    invalidate() {
      generation++;
      entry = undefined;
      pending = undefined;
    },
  };
}
