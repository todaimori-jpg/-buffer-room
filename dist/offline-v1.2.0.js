// BUFFER 1.2.0: self-contained classic service worker.
'use strict';
const DB_NAME = 'buffer-room-v1';
const CHUNK_SIZE = 2 * 1024 * 1024;
let connection;
function openDB() {
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
async function operation(store, mode, callback) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = callback(tx.objectStore(store));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error || new Error('Could not access device storage.'));
    tx.onabort = () => reject(tx.error || new Error('Storage operation interrupted.'));
  });
}
const allVideos = () => operation('videos', 'readonly', s => s.getAll());
const getVideo = id => operation('videos', 'readonly', s => s.get(id));
const saveVideo = video => operation('videos', 'readwrite', s => s.put(video));
const getChunk = (videoId, index) => operation('chunks', 'readonly', s => s.get([videoId, index]));
const putChunk = (videoId, index, data) => operation('chunks', 'readwrite', s => s.put({videoId, index, data}));
const getSetting = async key => (await operation('settings', 'readonly', s => s.get(key)))?.value;
const setSetting = (key, value) => operation('settings', 'readwrite', s => s.put({key, value}));
async function clearChunks(id) {
  return operation('chunks', 'readwrite', s => s.delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])));
}
async function removeVideo(id) {
  await clearChunks(id);
  await operation('videos', 'readwrite', s => s.delete(id));
}
async function inspectVideo(video) {
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

function parseRange(header, size) {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  if (!header) return {start: 0, end: size - 1, partial: false};
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
    end = Math.min(end, size - 1);
  }
  return start >= size || start > end ? null : {start, end, partial: true};
}
function youtubeId(input) {
  let url;
  try { url = new URL(input.trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const hosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'];
  let id;
  if (host === 'youtu.be') id = url.pathname.split('/')[1];
  else if (hosts.includes(host)) {
    const parts = url.pathname.split('/');
    id = url.pathname === '/watch' ? url.searchParams.get('v') : ['shorts', 'embed', 'live'].includes(parts[1]) ? parts[2] : null;
  }
  return /^[\w-]{11}$/.test(id || '') ? id : null;
}

const CACHE = 'buffer-shell-v1.2.0';
const SHELL = ['/', '/index.html', '/styles.css', '/app-v1.2.0.js', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];
self.addEventListener('install', event => {
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    for(const path of SHELL){
      const response=await fetch(new Request(path,{cache:'reload',credentials:'same-origin'}));
      if(!response.ok || response.redirected)throw new Error('The offline app could not cache '+path);
      if(path.endsWith('.js') && !/javascript|ecmascript/i.test(response.headers.get('Content-Type')||''))throw new Error('The offline script was replaced by a sign-in or error page.');
      await cache.put(path,response);
    }
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('buffer-shell-') && k !== CACHE).map(k => caches.delete(k)))),
    self.clients.claim()
  ]));
});
async function offlineResponse(request, id) {
  const video = await getVideo(id);
  if (!video || video.status !== 'ready') return new Response('Video is not fully cached on this device.', {status: 404});
  const range = parseRange(request.headers.get('Range'), video.size);
  if (!range) return new Response(null, {status: 416, headers: {'Content-Range': `bytes */${video.size}`}});
  const headers = {
    'Content-Type': video.mime || 'video/mp4',
    'Content-Length': String(range.end - range.start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${video.size}`;
  if (request.method === 'HEAD') return new Response(null, {status: range.partial ? 206 : 200, headers});
  let position = range.start;
  let cancelled = false;
  const stream = new ReadableStream({
    async pull(controller) {
      if (cancelled) return;
      if (position > range.end) { controller.close(); return; }
      try {
        const index = Math.floor(position / CHUNK_SIZE);
        const chunk = await getChunk(id, index);
        if (cancelled) return;
        if (!chunk) throw new Error('A cached chunk is missing. Verify the library and cache again.');
        const offset = position % CHUNK_SIZE;
        const length = Math.min(chunk.data.byteLength - offset, range.end - position + 1);
        if (length <= 0) throw new Error('Cached video is incomplete.');
        controller.enqueue(new Uint8Array(chunk.data, offset, length));
        position += length;
      } catch (error) { if (!cancelled) controller.error(error); }
    },
    cancel() { cancelled = true; }
  });
  return new Response(stream, {status: range.partial ? 206 : 200, headers});
}
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/offline-media/')) {
    const id = url.pathname.split('/')[2];
    event.respondWith(offlineResponse(event.request, id)); return;
  }
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(response => response.ok ? response : caches.match('/index.html')).catch(() => caches.match('/index.html')));
  } else if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(event.request, {ignoreSearch: true}).then(cached => cached || fetch(event.request)));
  }
});

