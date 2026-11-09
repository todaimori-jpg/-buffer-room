export const DB_NAME = 'buffer-room-v1';
export const CHUNK_SIZE = 2 * 1024 * 1024;
let connection;
export function openDB() {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('videos', {keyPath: 'id'});
      db.createObjectStore('chunks', {keyPath: ['videoId', 'index']});
      db.createObjectStore('settings', {keyPath: 'key'});
    };
    request.onerror = () => { connection = null; reject(request.error); };
    request.onblocked = () => { connection = null; reject(new Error('Close other BUFFER tabs and try again.')); };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); connection = null; };
      resolve(request.result);
    };
  });
  return connection;
}
export async function operation(store, mode, callback) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = callback(tx.objectStore(store));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error || new Error('Could not access device storage.'));
    tx.onabort = () => reject(tx.error || new Error('Storage operation interrupted.'));
  });
}
export const allVideos = () => operation('videos', 'readonly', s => s.getAll());
export const getVideo = id => operation('videos', 'readonly', s => s.get(id));
export const saveVideo = video => operation('videos', 'readwrite', s => s.put(video));
export const getChunk = (videoId, index) => operation('chunks', 'readonly', s => s.get([videoId, index]));
export const putChunk = (videoId, index, data) => operation('chunks', 'readwrite', s => s.put({videoId, index, data}));
export const getSetting = async key => (await operation('settings', 'readonly', s => s.get(key)))?.value;
export const setSetting = (key, value) => operation('settings', 'readwrite', s => s.put({key, value}));
export async function clearChunks(id) {
  return operation('chunks', 'readwrite', s => s.delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])));
}
export async function removeVideo(id) {
  await clearChunks(id);
  await operation('videos', 'readwrite', s => s.delete(id));
}
export async function inspectVideo(video) {
  const expected = Math.ceil(video.size / CHUNK_SIZE);
  if (!video.size || !Number.isSafeInteger(expected)) return {complete: false, bytes: 0, next: 0};
  let bytes = 0;
  for (let i = 0; i < expected; i++) {
    const chunk = await getChunk(video.id, i);
    const size = Math.min(CHUNK_SIZE, video.size - i * CHUNK_SIZE);
    if (!chunk || chunk.data.byteLength !== size) return {complete: false, bytes, next: i};
    bytes += size;
  }
  return {complete: bytes === video.size, bytes, next: expected};
}
