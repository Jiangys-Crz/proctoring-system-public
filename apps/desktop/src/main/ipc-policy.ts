import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isClientPage(url: string, rendererFile: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' && path.resolve(fileURLToPath(parsed)) === path.resolve(rendererFile);
  } catch {
    return false;
  }
}

export function isTrustedClientFrame(senderId: number, ownerId: number | undefined, isMainFrame: boolean, url: string, rendererFile: string) {
  return senderId === ownerId && isMainFrame && isClientPage(url, rendererFile);
}

export function canRetryRequest(method = 'GET') {
  // An unread response does not mean the server failed to commit a write.
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}
