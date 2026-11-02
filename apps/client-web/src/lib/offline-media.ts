export interface QueuedMediaUpload {
  id: string;
  blob: Blob;
  filename: string;
  fields: Record<string, string>;
  token: string;
  apiBase: string;
  createdAt: number;
}

const DATABASE = 'cwnupaa-proctor-browser-offline';
const STORE = 'uploads';

export function queuedMediaToken(item: QueuedMediaUpload, current: { apiBase: string; sessionId: string; token: string }) {
  return (item.apiBase || current.apiBase) === current.apiBase && item.fields.sessionId === current.sessionId && current.token
    ? current.token : item.token;
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('浏览器录像补传队列打开失败'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = operation(transaction.objectStore(STORE));
      // A successful put request can still be rolled back (for example, disk quota).
      // Only consider the evidence saved once the transaction has committed.
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error || new Error('浏览器录像补传队列保存失败'));
      transaction.onerror = () => reject(transaction.error || new Error('浏览器录像补传队列读写失败'));
      request.onerror = () => reject(request.error || new Error('浏览器录像补传队列读写失败'));
    });
  } finally {
    database.close();
  }
}

export function queueMediaUpload(item: Omit<QueuedMediaUpload, 'id' | 'createdAt'>) {
  const id = item.fields.uploadId || `${Date.now()}-${crypto.randomUUID()}`;
  return withStore('readwrite', (store) =>
    store.put({
      ...item,
      fields: { ...item.fields, uploadId: id },
      id,
      createdAt: Date.now()
    })
  );
}

export function listMediaUploads() {
  return withStore<QueuedMediaUpload[]>('readonly', (store) => store.getAll());
}

export function deleteMediaUpload(id: string) {
  return withStore('readwrite', (store) => store.delete(id));
}
