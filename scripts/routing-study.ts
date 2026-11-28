// Reproduce a study on local inputs. No network requests; do not invent missing library definitions.
import fs from 'node:fs';
import path from 'node:path';
import {buildSchematic,bundledDrawingFont,outlineSvgText,renderSheet} from '../packages/core/src/index.js';
import {measureQuality} from '../packages/core/src/quality.js';
import type {Library,Resolved,Schematic} from '../packages/core/src/types.js';

const [folder, inputFile, libraryFile='examples/library.json', budget]=process.argv.slice(2);
if(!inputFile||!folder)throw Error('node --import tsx scripts/routing-study.ts OUTPUT_DIR INPUT.json [LIBRARY.json] [1..8]');
const read=(f:string)=>JSON.parse(fs.readFileSync(f,'utf8'));
const input:Schematic=read(inputFile),doc=read(libraryFile),lib:Library=Array.isArray(doc)?doc:doc.components;
if(budget){const n=Number(budget);if(!Number.isInteger(n)||n<1||n>8)throw Error('Проходы: 1..8');input.layout.settings={...input.layout.settings,iterations:n};}
fs.mkdirSync(folder,{recursive:true});const name=path.basename(inputFile,'.json');
const t=performance.now(),r:Resolved=await buildSchematic(input,lib),ms=Math.round(performance.now()-t);
const codes:Record<string,number>={};for(const i of r.issues)codes[i.code]=(codes[i.code]??0)+1;
const quality=measureQuality(r);
const expectedTerminals=r.schematic.nets.reduce((total,net)=>total+net.pins.length,0);
const summary={name,ms,sections:r.sections.length,sheets:r.schematic.sheets.length,expectedTerminals,
 coveredTerminals:expectedTerminals-quality.missingTerminals,issues:codes,...quality};
fs.writeFileSync(path.join(folder,name+'.json'),JSON.stringify({ms,r}));
fs.writeFileSync(path.join(folder,name+'.metrics.json'),JSON.stringify(summary,null,2)+'\n');
for(const [i,sh] of r.schematic.sheets.entries())if(r.sections.some(s=>s.sheet_id===sh.id)){
 const safe=sh.id.replace(/[^\p{L}\p{N}_-]/gu,'_');
 const filename=path.join(folder,name+'-'+(i+1)+'-'+safe+'.svg');
 fs.writeFileSync(filename,outlineSvgText(renderSheet(r,sh.id),bundledDrawingFont()));
}
console.log(JSON.stringify(summary));
