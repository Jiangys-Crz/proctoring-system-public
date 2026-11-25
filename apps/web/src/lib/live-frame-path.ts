/** Older capture clients stored all sessions of a candidate under one key.
 * Those bytes cannot reliably be assigned to the session recorded in the row. */
export function isSharedLiveFramePath(value: string) {
  return /(?:^|\/)live\/live-(?:DESKTOP_SCREEN|DESKTOP_CAMERA|MOBILE_CAMERA)\.(?:jpe?g|webp)(?:[?#]|$)/i.test(value);
}
