(function (root) {
  root.createProctorNoticeInbox = function ({ read, acknowledge, render }) {
    let scope = '', queue = [], acknowledged = new Set(), reading = null, confirming = false;
    const show = error => render({ current: queue[0] || null, confirming, error: error || '' });
    return {
      clear() { scope = ''; queue = []; acknowledged = new Set(); reading = null; confirming = false; show(); },
      async poll(identity) {
        const key = `${identity.serverUrl}:${identity.sessionId}`;
        if (scope !== key) { scope = key; queue = []; acknowledged = new Set(); confirming = false; reading = null; show(); }
        if (reading) return;
        const context = {}; reading = context;
        try {
          const result = await read(identity);
          if (scope !== key || reading !== context) return;
          const pending = result.announcements.filter(item => !item.acknowledged && !acknowledged.has(item.id));
          for (const item of pending.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))) {
            if (!queue.some(current => current.id === item.id)) queue.push({ ...item, identity });
          }
          show();
        } catch { /* Keep unread notices visible and retry on the next heartbeat. */ }
        finally { if (reading === context) reading = null; }
      },
      async confirm() {
        if (confirming || !queue[0]) return;
        const current = queue[0], key = scope; confirming = true; show();
        try {
          await acknowledge(current.identity, current.id);
          if (scope !== key) return;
          acknowledged.add(current.id);
          // The API returns at most fifty notices. Retain bounded replay guards.
          if (acknowledged.size > 200) acknowledged.delete(acknowledged.values().next().value);
          queue = queue.filter(item => item.id !== current.id); confirming = false; show();
        } catch { if (scope === key) { confirming = false; show('确认未成功，请重试'); } }
      }
    };
  };
})(globalThis);
