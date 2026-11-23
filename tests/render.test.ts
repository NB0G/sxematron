import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildSchematic,exportSheets} from '../packages/core/src/index.js';

test('A3 frame, labels, Type B outlines and routed geometry match reviewed golden SVG',async()=>{
 const lib=JSON.parse(readFileSync(new URL('../examples/library.json',import.meta.url),'utf8'));
 const s=JSON.parse(readFileSync(new URL('../examples/demo.json',import.meta.url),'utf8'));
 const resolved=await buildSchematic(s,lib);
 const actual=exportSheets(resolved,{sheetId:'sheet_1'}).bytes;
 assert.deepEqual(Buffer.from(actual),readFileSync(new URL('./golden/demo-sheet-1.svg',import.meta.url)),'Review visual output, then explicitly update golden if the drawing rules intentionally changed.');
 assert.deepEqual(exportSheets(resolved).bytes,exportSheets(resolved).bytes,'ZIP timestamps must be fixed for deterministic deliverables');
});
