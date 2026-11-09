import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source = await readFile(new URL('../worker/router.js',import.meta.url),'utf8');
const {default:worker} = await import('data:text/javascript;base64,'+Buffer.from('const ASSETS={"/index.html":{type:"text/html",data:"aGVsbG8="}};\n'+source).toString('base64'));

test('private proxy reports configuration without revealing secrets',async()=>{
  const request=new Request('https://buffer.test/api/config');
  assert.deepEqual(await (await worker.fetch(request,{})).json(),{managed:false});
  const response=await worker.fetch(request,{BUFFER_BACKEND_URL:'https://video.test',BUFFER_BACKEND_KEY:'test-only-secret'});
  assert.deepEqual(await response.json(),{managed:true});
});
test('proxy allows only known video API paths and HTTPS targets',async()=>{
  assert.equal((await worker.fetch(new Request('https://buffer.test/api/proxy?url=https://other.test'),{})).status,404);
  assert.equal((await worker.fetch(new Request('https://buffer.test/api/connection'),{BUFFER_BACKEND_URL:'http://private.test',BUFFER_BACKEND_KEY:'test-only-secret'})).status,503);
  assert.equal((await worker.fetch(new Request('https://buffer.test/api/connection'),{})).status,503);
});
test('proxy injects server auth, strips visitor credentials, and preserves ranges',async()=>{
  const original=globalThis.fetch;
  let call;
  globalThis.fetch=async(url,options)=>{
    call={url,options};
    return new Response(new Uint8Array([11,22]),{status:206,headers:{'Content-Range':'bytes 0-1/100','Content-Type':'video/mp4','Content-Length':'2'}});
  };
  try{
    const id='a'.repeat(32);
    const response=await worker.fetch(new Request(`https://buffer.test/api/jobs/${id}/media?ignored=yes`,{headers:{Range:'bytes=0-1',Cookie:'visitor=private','OAI-Sites-Authorization':'Bearer visitor-only','oai-authenticated-user-email':'private@example.test'}}),{BUFFER_BACKEND_URL:'https://video.test',BUFFER_BACKEND_KEY:'test-only-secret'});
    assert.equal(call.url,`https://video.test/api/jobs/${id}/media`);
    assert.equal(call.options.headers.get('Authorization'),'Bearer test-only-secret');
    assert.equal(call.options.headers.get('Cookie'),null);
    assert.equal(call.options.headers.get('OAI-Sites-Authorization'),null);
    assert.equal(call.options.headers.get('oai-authenticated-user-email'),null);
    assert.equal(call.options.headers.get('Range'),'bytes=0-1');
    assert.equal(response.status,206);
    assert.equal(response.headers.get('Content-Range'),'bytes 0-1/100');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[11,22]);
  }finally{globalThis.fetch=original;}
});
