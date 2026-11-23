import {readFileSync,writeFileSync} from 'node:fs';
import {buildSchematic,exportSheets} from '../packages/core/src/index.js';
if(!process.argv.includes('--accept'))throw new Error('Укажите --accept после проверки SVG вручную.');
const library=JSON.parse(readFileSync('examples/library.json','utf8'));
const demo=JSON.parse(readFileSync('examples/demo.json','utf8'));
const r=await buildSchematic(demo,library);
writeFileSync('tests/golden/demo-sheet-1.svg',exportSheets(r,{sheetId:'sheet_1'}).bytes);
console.log('Golden SVG updated: tests/golden/demo-sheet-1.svg');
