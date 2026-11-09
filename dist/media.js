export function parseRange(header, size) {
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
export function youtubeId(input) {
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
