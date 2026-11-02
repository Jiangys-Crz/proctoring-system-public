import { contextBridge, ipcRenderer } from 'electron';
import type { ScreenControlDisplay } from '../main/screen-control';

// This sandboxed display page receives image data only; it has no command or
// network bridge, desktop token, exam credentials, or API to release the lock.
contextBridge.exposeInMainWorld('screenControlDisplay', {
  subscribe: (callback: (display: ScreenControlDisplay) => void) => {
    ipcRenderer.on('screen-control:display', (_event, display: ScreenControlDisplay) => callback(display));
    // Register the callback before requesting a replay; image downloads may
    // have completed before the page installed its subscription.
    ipcRenderer.send('screen-control:ready');
  }
});
