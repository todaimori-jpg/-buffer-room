import {getVideo, getChunk, CHUNK_SIZE} from './db.js';
import {parseRange} from './media.js';
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
export async function offlineResponse(request, id) {
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
