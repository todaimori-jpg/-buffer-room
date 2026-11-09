// BUFFER 1.2.0: self-contained browser script.
(()=>{
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


const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const formatBytes = n => !n ? '0 MB' : n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(n > 10485760 ? 0 : 1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
const formatTime = n => { n = Math.floor(n || 0); return n >= 3600 ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2,'0')}:${String(n % 60).padStart(2,'0')}` : `${Math.floor(n / 60)}:${String(n % 60).padStart(2,'0')}`; };
let videos = [], config = {}, view = 'library', filter = 'all', search = '', pumping = false, toastTimer, wakeLock, playingId, lastPositionSave = 0;
const active = new Map(), deleting = new Set(), posters = new Map();

function toast(message) {
  $('#toast').textContent = message; $('#toast').classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 5500);
}
function showDialog(id) { const dialog = $(`#${id}`); if (!dialog.open) dialog.showModal(); }
function closeDialog(id) { $(`#${id}`).close(); }
async function refresh() { videos = (await allVideos()).sort((a,b) => b.created - a.created); render(); }
async function update(video, changes) {
  Object.assign(video, changes);
  if (!deleting.has(video.id)) { await saveVideo(video); await refresh(); }
}
function imageFor(video) {
  if (!video.poster) return '';
  if (!posters.has(video.id)) posters.set(video.id, URL.createObjectURL(video.poster));
  return posters.get(video.id);
}
function render() {
  document.body.classList.toggle('has-videos', videos.length > 0);
  const ready = videos.filter(v => v.status === 'ready').length;
  const pending = videos.length - ready;
  $('#nav-count').textContent = videos.length; $('#queue-count').textContent = pending;
  $('#ready-count').textContent = ready; $('#pending-count').textContent = pending;
  $('#footer-ready').textContent = `${ready} video${ready === 1 ? '' : 's'} ready offline`;
  $('#network').classList.toggle('offline', !navigator.onLine);
  $('#network span').textContent = navigator.onLine ? 'Online' : 'Offline';
  $('#connection-banner').hidden = !!config.server;
  $('#library-section').hidden = view === 'storage'; $('#storage-section').hidden = view !== 'storage';
  $('#library-title').textContent = view === 'queue' ? 'Your queue' : 'Your library';
  $$('.nav-btn').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $$('.filter').forEach(button => button.classList.toggle('active', button.dataset.filter === filter));
  const visible = videos.filter(v => (view !== 'queue' || v.status !== 'ready') && (filter !== 'ready' || v.status === 'ready') && (filter !== 'unfinished' || v.status !== 'ready') && `${v.title} ${v.author || ''}`.toLowerCase().includes(search));
  $('#library-count').textContent = String(visible.length).padStart(2, '0');
  $('#empty').hidden = videos.length > 0 || !!search || view === 'queue';
  $('#no-results').hidden = visible.length > 0 || !$('#empty').hidden;
  $('#no-results').textContent = view === 'queue' && pending === 0 ? 'All caught up. Your offline videos are in the library.' : 'No videos match this view.';
  $('#cards').innerHTML = visible.map(v => {
    const ready = v.status === 'ready', busy = ['preparing','caching'].includes(v.status);
    const percent = v.size ? Math.min(100, Math.floor((v.bytes || 0) / v.size * 100)) : 0;
    const labels = {ready:'Ready offline', preparing: v.stage || 'Preparing on server…', caching:`Caching on this device · ${percent}%`, queued:config.server ? 'Waiting in queue' : 'Waiting for server connection', paused:`Paused${v.bytes ? ' · ' + percent + '% cached' : ''}`, error:'Needs attention'};
    const poster = imageFor(v);
    const primary = ready ? (v.position > 1 ? 'Resume watch' : 'Watch video') : busy ? 'Pause' : v.status === 'queued' ? 'Start now' : v.bytes ? 'Resume caching' : 'Retry';
    return `<article class="video-card" data-id="${escape(v.id)}"><div class="card-image ${ready ? 'playable' : ''}" ${ready ? `role="button" tabindex="0" aria-label="Play ${escape(v.title)}" data-action="play"` : ''}>${poster ? `<img src="${poster}" alt="">` : '<span class="card-placeholder" aria-hidden="true">Ⅱ</span>'}${ready ? '<span class="card-play" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="m6 3 11 7-11 7z"/></svg></span>' : ''}${v.duration ? `<span class="duration-chip">${formatTime(v.duration)}</span>` : ''}</div><div class="card-info"><h3 class="card-title">${escape(v.title)}</h3><p class="card-source">${escape(v.author || (v.source === 'youtube' ? 'YouTube' : v.source === 'demo' ? 'BUFFER test clip' : 'Imported video'))}</p><div class="card-meta"><span class="${ready ? 'ready-label' : 'state-label'}">${ready ? '<i></i>' : ''}${escape(labels[v.status] || v.status)}</span><span class="card-size">${v.size ? formatBytes(v.size) : `${v.quality || 720}p`}</span></div>${!ready && v.size ? `<div class="progress-track" role="progressbar" aria-label="Cached on device" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill" style="width:${percent}%"></div></div>` : ''}${v.error ? `<p class="card-error">${escape(v.error)}</p>` : ''}<div class="card-buttons"><button class="small-button" data-action="${ready ? 'play' : busy ? 'pause' : 'retry'}" ${busy && v.source !== 'youtube' ? 'disabled' : ''}>${busy && v.source !== 'youtube' ? 'Importing…' : primary}${ready ? ' <svg class="arrow-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 15 15 5M5 5h10v10"/></svg>' : ''}</button><button class="remove-btn" data-action="remove" ${busy && v.source !== 'youtube' ? 'disabled' : ''} aria-label="Remove ${escape(v.title)}">×</button></div></div></article>`;
  }).join('');
  $('#storage-used').textContent = formatBytes(videos.reduce((sum,v) => sum + (v.bytes || 0), 0));
  $('#storage-videos').textContent = `${ready} complete · ${pending} in progress`;
  for (const [id, url] of posters) if (!videos.some(v => v.id === id)) { URL.revokeObjectURL(url); posters.delete(id); }
}
async function storageInfo() {
  const estimate = await navigator.storage?.estimate?.().catch(() => ({}));
  $('#storage-free').textContent = estimate?.quota ? formatBytes(Math.max(0, estimate.quota - (estimate.usage || 0))) : 'Not reported';
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  $('#persistence-status').textContent = persisted ? 'Persistent storage is enabled.' : 'Persistent storage is not enabled. Keep another copy of irreplaceable videos.';
}
async function checkSpace(bytes) {
  const estimate = await navigator.storage?.estimate?.().catch(() => ({}));
  if (estimate?.quota && estimate.quota - (estimate.usage || 0) < bytes + 8 * 1048576) throw new Error('Not enough browser storage. Remove a saved video or choose 360p.');
}
async function ensureWorker() {
  if (!('serviceWorker' in navigator)) throw new Error('Offline playback needs a browser with service workers. Open this app in Safari.');
  // A working installed controller must not depend on re-fetching its script.
  // Re-registering first can fail offline even though every video byte is local.
  if (navigator.serviceWorker.controller) {
    if (navigator.onLine) navigator.serviceWorker.register('/offline-v1.2.0.js',{scope:'/',updateViaCache:'none'}).catch(()=>{});
    return;
  }
  await navigator.serviceWorker.register('/offline-v1.2.0.js', {scope:'/',updateViaCache:'none'});
  await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('The offline player could not start. Reload while online and try again.')), 20000))]);
  if (!navigator.serviceWorker.controller) await Promise.race([
    new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, {once:true})),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Reload once to activate offline playback.')), 10000))
  ]);
}
async function api(path, {method='GET', body, signal, timeout=90000, raw=false, headers={}} = {}, override) {
  const settings = override || config;
  if (!settings.server) throw new Error('Connect your video server in Settings first.');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once:true});
  const timer = setTimeout(() => controller.abort(new Error('The server took too long to respond. Try again; it may be waking up.')), timeout);
  try {
    const response = await fetch(settings.server + path, {method, body: body === undefined ? undefined : JSON.stringify(body), headers:{...headers,...(body === undefined ? {} : {'Content-Type':'application/json'}),...(settings.key ? {'Authorization':`Bearer ${settings.key}`} : {})}, signal:controller.signal, credentials:settings.managed ? 'same-origin' : 'omit', redirect:'error', cache:'no-store'});
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.detail || detail.error || (response.status === 401 ? 'Connection key rejected. Check your server key in Settings.' : `Server returned ${response.status}.`));
    }
    // Read each bounded response while the timeout and caller cancellation are
    // still attached; resolving at headers would leave a stalled body unbounded.
    if (raw) return new Response(await response.arrayBuffer(), {status:response.status, headers:response.headers});
    return await response.json();
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Caching paused.', 'AbortError');
    if (controller.signal.aborted) throw new Error('The server timed out. Keep the app open and retry.');
    if (error instanceof TypeError) throw new Error('Could not reach the video server. Check its URL, allowed origin, and connection.');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
const wait = (ms, signal) => new Promise((resolve,reject) => {
  if (signal.aborted) return reject(new DOMException('Paused', 'AbortError'));
  const done = () => { signal.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(done, ms);
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('Paused','AbortError')); };
  signal.addEventListener('abort', abort, {once:true});
});
async function holdScreen() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {} }
async function releaseScreen() { try { await wakeLock?.release(); } catch {} wakeLock = null; }

async function cacheYouTube(video, signal) {
  await ensureWorker();
  await update(video, {status:'preparing', stage:'Preparing on server…', error:null});
  let remote;
  if (video.jobId && video.jobServer === config.server) {
    try { remote = await api(`/api/jobs/${video.jobId}`, {signal}); } catch (error) { if (signal.aborted) throw error; }
  }
  if (!remote || ['error','cancelled'].includes(remote.status)) {
    remote = await api('/api/jobs', {method:'POST', body:{url:video.url, quality:Number(video.quality)}, signal});
    await update(video, {jobId:remote.id, jobServer:config.server});
  }
  while (remote.status !== 'ready') {
    if (['error','cancelled'].includes(remote.status)) throw new Error(remote.error || 'The server could not prepare this video.');
    const percentage = remote.progress ? ` · ${Math.round(remote.progress)}%` : '';
    await update(video, {title:remote.title || video.title, author:remote.author || video.author, stage:(remote.stage || 'Preparing on server') + percentage});
    await wait(1800, signal);
    remote = await api(`/api/jobs/${video.jobId}`, {signal});
  }
  if (!Number.isSafeInteger(remote.size) || remote.size <= 0 || !remote.sha256) throw new Error('The server did not return a valid complete video.');
  if (video.fingerprint !== remote.sha256 || video.size !== remote.size) { await clearChunks(video.id); video.bytes = 0; }
  await update(video, {title:remote.title || video.title, author:remote.author || '', duration:remote.duration || 0, actualQuality:remote.height, size:remote.size, mime:'video/mp4', fingerprint:remote.sha256, status:'caching', error:null});
  const saved = await inspectVideo(video);
  await checkSpace(video.size - saved.bytes);
  await update(video, {bytes:saved.bytes});
  for (let index = saved.next; index < Math.ceil(video.size / CHUNK_SIZE); index++) {
    if (signal.aborted) throw new DOMException('Paused','AbortError');
    const start = index * CHUNK_SIZE, end = Math.min(start + CHUNK_SIZE, video.size) - 1;
    const response = await api(`/api/jobs/${video.jobId}/media`, {signal, raw:true, headers:{Range:`bytes=${start}-${end}`}, timeout:120000});
    if (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${start}-${end}/${video.size}`) throw new Error('The server returned an unexpected video range. Retry caching.');
    const data = await response.arrayBuffer();
    if (signal.aborted) throw new DOMException('Paused','AbortError');
    if (data.byteLength !== end - start + 1) throw new Error('The transfer was incomplete. Resume caching to try again.');
    await putChunk(video.id, index, data);
    await update(video, {bytes:end + 1});
  }
  if (!video.poster) {
    try {
      const response = await api(`/api/jobs/${video.jobId}/poster`, {signal, raw:true, timeout:15000});
      const poster = await response.blob();
      if (poster.size < 2000000 && /^image\/(jpeg|png|webp)$/.test(poster.type)) video.poster = poster;
    } catch (error) { if (signal.aborted) throw error; }
  }
  const result = await inspectVideo(video);
  if (!result.complete) throw new Error('Some video chunks are missing. Resume caching to finish.');
  await update(video, {status:'ready', bytes:video.size, stage:null, error:null});
  toast(`${video.title} is ready offline.`);
}
async function pump() {
  if (pumping || !config.server || (!config.key && !config.managed) || !navigator.onLine) return;
  pumping = true; await holdScreen();
  try {
    while (navigator.onLine) {
      const video = (await allVideos()).filter(v => v.source === 'youtube' && v.status === 'queued' && !deleting.has(v.id)).sort((a,b)=>a.created-b.created)[0];
      if (!video) break;
      const controller = new AbortController();
      const done = (async () => {
        try { await cacheYouTube(video, controller.signal); }
        catch (error) { if (!deleting.has(video.id)) await update(video, {status:error.name === 'AbortError' ? 'paused' : 'error', stage:null, error:error.name === 'AbortError' ? null : error.name === 'QuotaExceededError' ? 'Device storage is full. Remove a video, then resume.' : error.message}); }
      })();
      active.set(video.id, {controller, done});
      await done; active.delete(video.id);
    }
  } finally { pumping = false; await releaseScreen(); await storageInfo(); }
}

async function addLink(event) {
  event.preventDefault();
  const id = youtubeId($('#video-url').value);
  if (!id) { $('#url-error').textContent = 'Enter a valid YouTube video link, including https://.'; $('#video-url').focus(); return; }
  $('#url-error').textContent = '';
  const quality = Number(new FormData(event.currentTarget).get('quality'));
  if (videos.some(v => v.youtubeId === id && v.quality === quality)) { toast('That video is already in your room at this quality.'); return; }
  const video = {id:crypto.randomUUID(), youtubeId:id, url:`https://www.youtube.com/watch?v=${id}`, title:`YouTube video · ${id}`, quality, source:'youtube', status:'queued', created:Date.now(), bytes:0, position:0};
  await saveVideo(video); $('#video-url').value = ''; filter = 'all'; view = 'library'; await refresh();
  if (!config.server || (!config.key && !config.managed)) { toast('Link queued. Connect your server to start preloading.'); openSettings(); }
  else if (!navigator.onLine) toast('Link queued. Go online to cache the video.');
  else pump();
}
async function importVideo(file, source='import') {
  if (!file.size) throw new Error('This video file is empty.');
  const type = /^video\//.test(file.type) ? file.type : /\.webm$/i.test(file.name) ? 'video/webm' : /\.mov$/i.test(file.name) ? 'video/quicktime' : 'video/mp4';
  await checkSpace(file.size); await ensureWorker();
  const video = {id:crypto.randomUUID(), title:source === 'demo' ? 'A moment, offline' : file.name.replace(/\.[^.]+$/, ''), source, status:'caching', created:Date.now(), size:file.size, mime:type, bytes:0, position:0, duration:0};
  await saveVideo(video); await refresh();
  try {
    const media = document.createElement('video'), url = URL.createObjectURL(file);
    await new Promise(resolve => { const timer = setTimeout(resolve, 2500); media.onloadedmetadata = () => { video.duration = Number.isFinite(media.duration) ? media.duration : 0; clearTimeout(timer); resolve(); }; media.onerror = () => { clearTimeout(timer); resolve(); }; media.preload = 'metadata'; media.src = url; });
    media.removeAttribute('src'); media.load(); URL.revokeObjectURL(url);
    for (let index = 0; index < Math.ceil(file.size / CHUNK_SIZE); index++) {
      await putChunk(video.id, index, await file.slice(index * CHUNK_SIZE, (index+1) * CHUNK_SIZE).arrayBuffer());
      await update(video, {bytes:Math.min((index+1) * CHUNK_SIZE, file.size)});
    }
    if (!(await inspectVideo(video)).complete) throw new Error('The local import did not finish. Please import the video again.');
    await update(video, {status:'ready'}); toast(`${video.title} is ready offline.`);
  } catch (error) { await update(video, {status:'error', error:error.name === 'QuotaExceededError' ? 'Device storage is full. Remove a video, then import this file again.' : error.message}); }
  await storageInfo();
}
async function openVideo(id) {
  const video = await getVideo(id);
  if (!video || video.status !== 'ready') return;
  try {
    await ensureWorker();
    const check = await inspectVideo(video);
    if (!check.complete) { await update(video, {status:'paused', bytes:check.bytes, error:'Some cached data was removed. Resume caching while online.'}); throw new Error('This video is incomplete on this device.'); }
    const player = $('#player'); playingId = id;
    $('#player-title').textContent = video.title; $('#player-quality').textContent = `${video.actualQuality || video.quality ? (video.actualQuality || video.quality) + 'p · ' : ''}${formatBytes(video.size)}`; $('#player-error').textContent = '';
    player.src = `/offline-media/${encodeURIComponent(id)}`;
    player.onloadedmetadata = () => { if (video.position > 0 && video.position < player.duration - 1) player.currentTime = video.position; };
    player.onerror = () => { $('#player-error').textContent = 'This device could not play the cached video. Imported files need a codec supported by Safari; server-prepared videos use H.264/AAC MP4. You can also verify the saved video in Storage.'; };
    showDialog('player-dialog');
    player.play().catch(() => { /* Native controls remain available if autoplay is blocked. */ });
  } catch (error) { toast(error.message); }
}
async function savePosition(reset=false) {
  if (!playingId) return;
  const video = await getVideo(playingId);
  if (video?.status === 'ready') { video.position = reset ? 0 : $('#player').currentTime || 0; await saveVideo(video); }
}
async function closePlayer() {
  $('#player').pause(); await savePosition(); playingId = null;
  $('#player').removeAttribute('src'); $('#player').load(); closeDialog('player-dialog'); await refresh();
}
function confirmation(title, message) {
  $('#confirm-title').textContent = title; $('#confirm-message').textContent = message; showDialog('confirm-dialog');
  return new Promise(resolve => {
    const dialog = $('#confirm-dialog');
    const finish = value => { closeDialog('confirm-dialog'); $('#confirm-accept').onclick = null; $('#confirm-cancel').onclick = null; dialog.removeEventListener('cancel', cancel); resolve(value); };
    const cancel = event => { event.preventDefault(); finish(false); };
    $('#confirm-accept').onclick = () => finish(true); $('#confirm-cancel').onclick = () => finish(false); dialog.addEventListener('cancel', cancel, {once:true});
  });
}
async function cardAction(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const id = target.closest('[data-id]').dataset.id, video = await getVideo(id);
  if (!video) return;
  if (target.dataset.action === 'play') return openVideo(id);
  if (target.dataset.action === 'pause') { active.get(id)?.controller.abort(); return; }
  if (target.dataset.action === 'retry') {
    if (video.source !== 'youtube') { toast('Import the original file again to finish this video.'); $('#import-file').click(); return; }
    await update(video, {status:'queued', error:null});
    if (!config.server || (!config.key && !config.managed)) openSettings(); else if (!navigator.onLine) toast('Go online to resume caching.'); else pump();
  }
  if (target.dataset.action === 'remove' && await confirmation('Remove this video?', `“${video.title}” and its cached data will be removed from this device.`)) {
    deleting.add(id);
    const current = active.get(id); if (current) { current.controller.abort(); await current.done; }
    await removeVideo(id); deleting.delete(id); await refresh(); await storageInfo(); toast('Video removed from this device.');
  }
}

function openSettings() {
  if (config.managed) { $('#managed-result').textContent = ''; showDialog('managed-dialog'); return; }
  $('#server-url').value = config.server || (location.hostname.endsWith('.onrender.com') ? location.origin : '');
  $('#server-key').value = config.key || ''; $('#connection-result').textContent = ''; showDialog('settings-dialog');
}
function settingsFromForm() {
  const text = $('#server-url').value.trim().replace(/\/+$/, '');
  let url; try { url = new URL(text); } catch { throw new Error('Enter the HTTPS address of your video server.'); }
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use an HTTPS server origin, without a path, query, or password.');
  const key = $('#server-key').value.trim(); if (!key) throw new Error('Enter your server connection key.');
  return {server:url.origin, key};
}
async function testSettings(save=false) {
  const output = $('#connection-result'); output.classList.remove('error'); output.textContent = 'Connecting… A sleeping server can take a moment.';
  $('#test-connection').disabled = true; $('#settings-form button[type=submit]').disabled = true;
  try {
    const settings = settingsFromForm();
    const result = await api('/api/connection', {timeout:90000}, settings);
    if (!result.ok) throw new Error('Server check failed.');
    if (!result.dependencies_ready) throw new Error('The server is reachable, but its video tools are missing. Check the server deployment.');
    output.textContent = 'Connected. Your video server is ready.';
    if (save) { config = settings; await setSetting('connection', config); closeDialog('settings-dialog'); await refresh(); toast('Server connected. Queued links will start caching.'); pump(); }
  } catch (error) { output.classList.add('error'); output.textContent = error.message; }
  finally { $('#test-connection').disabled = false; $('#settings-form button[type=submit]').disabled = false; }
}
async function verifyLibrary() {
  const button = $('#verify'); button.disabled = true;
  let damaged = 0, checked = 0;
  try {
    for (const video of await allVideos()) if (video.status === 'ready') {
      const result = await inspectVideo(video); checked++;
      if (!result.complete) { damaged++; await update(video, {status:'paused', bytes:result.bytes, error:'Cached data is incomplete. Resume caching while online.'}); }
    }
    toast(damaged ? `${damaged} video${damaged === 1 ? ' needs' : 's need'} caching again.` : `${checked} saved video${checked === 1 ? '' : 's'} verified on this device.`);
  } finally { button.disabled = false; }
}
function bind() {
  $('#add-form').addEventListener('submit', event => addLink(event).catch(error => toast(error.message)));
  $('#video-url').addEventListener('input', () => $('#url-error').textContent = '');
  $('#paste').onclick = async () => { try { $('#video-url').value = await navigator.clipboard.readText(); $('#video-url').focus(); } catch { toast('Touch and hold the link field, then choose Paste.'); $('#video-url').focus(); } };
  $$('.nav-btn').forEach(button => button.onclick = () => { view = button.dataset.view; filter = 'all'; render(); if (view === 'storage') storageInfo(); });
  $$('.filter').forEach(button => button.onclick = () => { filter = button.dataset.filter; render(); });
  $('#search').oninput = event => { search = event.target.value.toLowerCase(); render(); };
  $('#cards').addEventListener('click', event => cardAction(event).catch(error => toast(error.message)));
  $('#cards').addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.card-image[data-action]')) { event.preventDefault(); cardAction(event).catch(error => toast(error.message)); } });
  $('#settings-open').onclick = openSettings; $('#connect-banner').onclick = openSettings;
  $('#settings-form').onsubmit = event => { event.preventDefault(); testSettings(true); };
  $('#test-connection').onclick = () => testSettings();
  $('#managed-check').onclick = async () => {
    const button = $('#managed-check'), output = $('#managed-result');
    button.disabled = true; output.textContent = 'Checking your video server…';
    try {
      const result = await api('/api/connection');
      output.textContent = result.ok && result.dependencies_ready ? 'Your video server is online and ready.' : 'The server is online, but its video tools need attention.';
    } catch (error) { output.textContent = error.message; }
    finally { button.disabled = false; }
  };
  $$('[data-close]').forEach(button => button.onclick = () => closeDialog(button.dataset.close));
  $('#help-open').onclick = () => showDialog('help-dialog');
  $('#import-button').onclick = () => $('#import-file').click();
  $('#import-file').onchange = async event => { const files = [...event.target.files]; event.target.value = ''; for (const file of files) { try { await importVideo(file); } catch(error) { toast(error.message); } } };
  $('#demo-button').onclick = async () => {
    const button = $('#demo-button'); button.disabled = true;
    try {
      const existing = videos.find(v => v.source === 'demo' && v.status === 'ready');
      if (existing) return openVideo(existing.id);
      await ensureWorker(); const response = await fetch('/demo.mp4');
      if (!response.ok) throw new Error('The test clip could not load. Try while online.');
      await importVideo(new File([await response.blob()], 'BUFFER-offline-test.mp4', {type:'video/mp4'}), 'demo');
    } catch(error) { toast(error.message); } finally { button.disabled = false; }
  };
  $('#verify').onclick = () => verifyLibrary().catch(error => toast(error.message));
  $('#protect-storage').onclick = async () => { const granted = await navigator.storage?.persist?.().catch(() => false); await storageInfo(); toast(granted ? 'Persistent storage is enabled.' : 'The browser did not grant persistent storage. Installing to your Home Screen may help.'); };
  $('#player-close').onclick = () => closePlayer();
  $('#player-dialog').addEventListener('cancel', event => { event.preventDefault(); closePlayer(); });
  $('#player').addEventListener('timeupdate', () => { if (Date.now()-lastPositionSave > 5000) { lastPositionSave = Date.now(); savePosition().catch(()=>{}); } });
  $('#player').addEventListener('ended', () => savePosition(true).catch(()=>{}));
  $('#fullscreen').onclick = async () => { try { const video = $('#player'); if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); else if (video.requestFullscreen) await video.requestFullscreen(); else toast('Use the fullscreen control on the video.'); } catch { toast('Use the fullscreen control on the video.'); } };
  window.addEventListener('online', () => { render(); pump(); });
  window.addEventListener('offline', () => { render(); for (const {controller} of active.values()) controller.abort(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && pumping) holdScreen(); if (document.visibilityState === 'hidden') savePosition().catch(()=>{}); });
}
async function init() {
  bind(); config = await getSetting('connection') || {};
  for (const video of await allVideos()) if (['preparing','caching'].includes(video.status)) { video.status = 'paused'; video.stage = null; await saveVideo(video); }
  await refresh(); await storageInfo();
  ensureWorker().catch(error => toast(error.message));
  if (navigator.onLine) {
    const timeout = new AbortController(), timer = setTimeout(()=>timeout.abort(),6000);
    try {
      const response = await fetch('/api/config',{cache:'no-store',signal:timeout.signal});
      if (response.ok && (await response.json()).managed) {
        config = {server:location.origin,managed:true};
        await setSetting('connection',config); await refresh();
      }
    } catch { /* Existing device configuration remains usable offline. */ }
    finally { clearTimeout(timer); }
  }
  pump();
}
init().catch(error => { $('#startup-error').hidden = false; $('#startup-error').textContent = `BUFFER could not open device storage: ${error.message} Try a normal Safari window with website storage enabled.`; });

})();
