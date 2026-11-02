/** A browser releases Web Locks automatically when a tab closes or crashes. */
export function acquireCaptureLock(name: string): Promise<(() => void) | null> {
  if (!navigator.locks) return Promise.resolve(() => {});
  return new Promise((resolve, reject) => {
    void navigator.locks.request(`proctor-capture:${name}`, { ifAvailable: true }, async lock => {
      if (!lock) return resolve(null);
      await new Promise<void>(release => resolve(release));
    }).catch(reject);
  });
}
