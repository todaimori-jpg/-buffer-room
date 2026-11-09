import {readdir,readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.mp4':'video/mp4','.webmanifest':'application/manifest+json'};
const assets={};
for(const file of await readdir(resolve(root,'dist'),{withFileTypes:true})) {
  if(!file.isFile())continue;
  const bytes=await readFile(resolve(root,'dist',file.name));
  assets['/'+file.name]={type:types[extname(file.name)]||'application/octet-stream',data:bytes.toString('base64')};
}
const router=await readFile(resolve(root,'worker/router.js'),'utf8');
await mkdir(resolve(root,'worker'),{recursive:true});
await writeFile(resolve(root,'worker/index.js'),'// Generated self-contained Worker; edit router.js or dist assets, then rebuild.\nconst ASSETS='+JSON.stringify(assets)+';\n'+router);
console.log(`Embedded ${Object.keys(assets).length} application assets`);
