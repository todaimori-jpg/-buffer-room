import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('browser entry and offline worker are standalone classic scripts',async()=>{
  for(const name of ['app-v1.2.0.js','offline-v1.2.0.js']){
    const source=await readFile(new URL('../dist/'+name,import.meta.url),'utf8');
    assert.doesNotMatch(source,/^\s*(?:import|export)\s/m);
    assert.doesNotThrow(()=>new vm.Script(source,{filename:name}));
  }
  const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
  assert.match(html,/<script defer src="\/app-v1\.2\.0\.js"><\/script>/);
});
