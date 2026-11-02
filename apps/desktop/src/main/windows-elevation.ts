import { execFile } from 'node:child_process';

export type ElevationStatus = 'elevated' | 'standard' | 'unavailable';
type ProbeRunner = typeof execFile;
export type ElevationLaunchResult = 'started' | 'cancelled' | 'failed';

/** A verified token belongs to this running main process. Starting more probe
 * children during every device scan cannot change that token, but antivirus
 * blocks and concurrent scans can make those children fail transiently. */
export function createWindowsElevationCheck(read: () => Promise<ElevationStatus>) {
  let confirmed = false;
  let pending: Promise<ElevationStatus> | null = null;
  return (): Promise<ElevationStatus> => {
    if (confirmed) return Promise.resolve('elevated');
    if (pending) return pending;
    pending = Promise.resolve().then(read).catch(() => 'unavailable' as const).then(status => {
      if (status === 'elevated') confirmed = true;
      return status;
    }).finally(() => { pending = null; });
    return pending;
  };
}

const clientChecks = new Map<string, () => Promise<ElevationStatus>>();
export function readClientWindowsElevation(executable: string): Promise<ElevationStatus> {
  const key = `${process.pid}:${executable}`;
  let check = clientChecks.get(key);
  if (!check) {
    check = createWindowsElevationCheck(() => readWindowsElevation(executable));
    clientChecks.set(key, check);
  }
  return check();
}

export function quoteWindowsArgument(value: string) {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

/** Arguments go to ShellExecuteExW directly, without a command shell or PowerShell. */
export function launchWindowsElevated(executable: string, client: string, appPath?: string, run: ProbeRunner = execFile): Promise<ElevationLaunchResult> {
  const args = [...(appPath ? [quoteWindowsArgument(appPath)] : []), '--proctor-elevated-relaunch'].join(' ');
  return new Promise(resolve => {
    run(executable, [client, args], { windowsHide: true, timeout: 120000 }, error => {
      if (!error) { resolve('started'); return; }
      const failure = error as Error & { code?: number | string; killed?: boolean; signal?: string };
      resolve(!failure.killed && !failure.signal && failure.code === 10 ? 'cancelled' : 'failed');
    });
  });
}

/** The bundled probe reads TOKEN_ELEVATION through the Windows API. A failed
 * probe must never be confused with a confirmed non-elevated token. */
export function readWindowsElevation(executable: string, run: ProbeRunner = execFile): Promise<ElevationStatus> {
  return new Promise(resolve => {
    run(executable, [String(process.pid)], { windowsHide: true, timeout: 10000 }, error => {
      if (!error) { resolve('elevated'); return; }
      const failure = error as Error & { code?: number | string; killed?: boolean; signal?: string };
      resolve(!failure.killed && !failure.signal && failure.code === 10 ? 'standard' : 'unavailable');
    });
  });
}
