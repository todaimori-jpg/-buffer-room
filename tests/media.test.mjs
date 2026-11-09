import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRange, youtubeId} from '../dist/media.js';

test('byte ranges cover Safari probes, seeking, tails, and invalid requests', () => {
  assert.deepEqual(parseRange('bytes=0-1', 100), {start:0,end:1,partial:true});
  assert.deepEqual(parseRange('bytes=73-', 100), {start:73,end:99,partial:true});
  assert.deepEqual(parseRange('bytes=-10', 100), {start:90,end:99,partial:true});
  assert.deepEqual(parseRange('bytes=90-120', 100), {start:90,end:99,partial:true});
  assert.deepEqual(parseRange('bytes=-1000', 100), {start:0,end:99,partial:true});
  assert.deepEqual(parseRange(null, 100), {start:0,end:99,partial:false});
  for (const range of ['bytes=100-', 'bytes=8-2', 'bytes=-0', 'bytes=0-1,8-9', 'bits=1-4', 'bytes=-']) assert.equal(parseRange(range,100),null);
});

test('YouTube links are normalized without accepting lookalike hosts or credentials', () => {
  const id='jNQXAC9IVRw';
  for (const link of [`https://youtu.be/${id}?si=abc`, `https://www.youtube.com/watch?v=${id}&list=ignored`, `https://m.youtube.com/shorts/${id}`, `https://youtube.com/embed/${id}`,`https://youtube.com/live/${id}`]) assert.equal(youtubeId(link),id);
  for (const link of ['https://youtube.com.evil.test/watch?v='+id,'https://evil.test/?v='+id,'https://youtube.com/playlist?list=abc','javascript:alert(1)','https://password@youtube.com/watch?v='+id,'https://youtu.be/short']) assert.equal(youtubeId(link),null);
});
