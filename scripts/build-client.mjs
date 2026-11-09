import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const version='1.2.0';
const source=async name=>(await readFile(resolve(root,'dist',name),'utf8')).replace(/^import[^\n]*\n/gm,'').replace(/^export\s+/gm,'');
const shared=(await source('db.js'))+'\n'+(await source('media.js'));
await writeFile(resolve(root,`dist/app-v${version}.js`),`// BUFFER ${version}: self-contained browser script.\n(()=>{\n'use strict';\n${shared}\n${await source('app.js')}\n})();\n`);
await writeFile(resolve(root,`dist/offline-v${version}.js`),`// BUFFER ${version}: self-contained classic service worker.\n'use strict';\n${shared}\n${await source('sw.js')}\n`);
console.log(`Built self-contained browser and offline scripts ${version}`);
