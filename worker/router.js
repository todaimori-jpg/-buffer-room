// ASSETS is embedded by scripts/embed-assets.mjs. Runtime secrets are supplied
// by Sites; no backend key is ever included in a client asset or source file.
const API_PATH = /^\/api\/(?:health|connection|jobs(?:\/[0-9a-f]{32}(?:\/(?:media|poster))?)?)$/;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS']);

function json(value, status=200) {
  return new Response(JSON.stringify(value), {status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/config' && request.method === 'GET') {
      return json({managed:!!(env.BUFFER_BACKEND_URL && env.BUFFER_BACKEND_KEY)});
    }
    if (url.pathname.startsWith('/api/')) {
      if (!API_PATH.test(url.pathname)) return json({detail:'Unknown API route.'},404);
      if (!METHODS.has(request.method)) return json({detail:'Method not allowed.'},405);
      if (!env.BUFFER_BACKEND_URL || !env.BUFFER_BACKEND_KEY) return json({detail:'The video server has not been connected yet.'},503);
      let backend;
      try {
        backend = new URL(env.BUFFER_BACKEND_URL);
        if (backend.protocol !== 'https:' || backend.username || backend.password) throw Error();
      } catch { return json({detail:'The video server address is not configured correctly.'},503); }
      backend.pathname = url.pathname;
      backend.search = '';
      const headers = new Headers();
      for (const name of ['Content-Type','Range','Accept']) if (request.headers.has(name)) headers.set(name,request.headers.get(name));
      headers.set('Authorization',`Bearer ${env.BUFFER_BACKEND_KEY}`);
      // Never forward browser cookies, ChatGPT identity, or service-access tokens.
      try {
        const response = await fetch(backend.toString(), {method:request.method, headers, body:['GET','HEAD'].includes(request.method) ? undefined : request.body, redirect:'error'});
        const safeHeaders = new Headers();
        for (const name of ['Content-Type','Content-Length','Content-Range','Accept-Ranges']) if (response.headers.has(name)) safeHeaders.set(name,response.headers.get(name));
        safeHeaders.set('Cache-Control','no-store');
        safeHeaders.set('X-Content-Type-Options','nosniff');
        return new Response(response.body,{status:response.status,headers:safeHeaders});
      } catch { return json({detail:'The video server could not be reached. It may be waking up; retry in a moment.'},502); }
    }
    if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405});
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const asset = ASSETS[path];
    if (!asset) return new Response('Not found',{status:404});
    const headers = {'Content-Type':asset.type,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-cache'};
    if (path === '/sw.js') headers['Service-Worker-Allowed'] = '/';
    const body = request.method === 'HEAD' ? null : Uint8Array.from(atob(asset.data),c=>c.charCodeAt(0));
    return new Response(body,{headers});
  }
};
