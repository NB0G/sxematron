import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildSchematic, emptySchematic } from '../packages/core/src/index.js';
import type { ComponentDefinition, Instance, Net, Schematic } from '../packages/core/src/types.js';

const component:ComponentDefinition={format_version:'1.0',component_code:'BENCH_4PIN',name:'Синтетический четырёхвыводный блок',category:'benchmark',positional_prefix:'DA',physical_pins:[{number:'1'},{number:'2'},{number:'3'},{number:'4'}],variants:[{variant_code:'01',name:'Основной',sections:[{section_id:'BODY',graphics:[{id:'body',kind:'rectangle',x:0,y:0,width:15,height:10}],pins:[{number:'1',x:-5,y:2.5,side:'left'},{number:'2',x:-5,y:7.5,side:'left'},{number:'3',x:20,y:2.5,side:'right'},{number:'4',x:20,y:7.5,side:'right'}]}]}]};

function reference(mode:'label'|'auto',count:number,sheetCount:number):Schematic {
 const s=emptySchematic();s.document.title=`Нагрузочная проверка: ${count} компонентов`;s.document.designation='BENCH.Э3';s.sheets=Array.from({length:sheetCount},(_,i)=>({id:`sheet_${i+1}`}));
 const perSheet=count/sheetCount;if(!Number.isInteger(perSheet))throw new Error('Количество компонентов должно делиться на количество листов.');
 for(let sh=1;sh<=sheetCount;sh++){
  const group=`group_${sh}`;s.groups.push({id:group,tag:group,sheet_id:`sheet_${sh}`});
  for(let i=0;i<perSheet;i++){const id=`s${sh}_c${i}`;s.components.push({id,component_code:component.component_code,variant_code:'01',tag:group,sections:{BODY:{sheet_id:`sheet_${sh}`}}});}
  for(let i=0;i<perSheet;i++){const a=`s${sh}_c${i}`,b=`s${sh}_c${(i+1)%perSheet}`;for(let n=0;n<2;n++)s.nets.push({id:`s${sh}_n${i}_${n}`,name:`S${sh}_${i}_${n}`,render:mode,pins:[{instance_id:a,number:String(n+3)},{instance_id:b,number:String(n+1)}]});}
 }
 return s;
}

async function measure(name:string,s:Schematic){
 const start=performance.now();const result=await buildSchematic(s,[component]);const elapsedMs=Math.round((performance.now()-start)*100)/100;
 const byCode:Record<string,number>={};for(const issue of result.issues)byCode[`${issue.severity}:${issue.code}`]=(byCode[`${issue.severity}:${issue.code}`]??0)+1;
 const memory=process.memoryUsage();const value={name,components:s.components.length,nets:s.nets.length,requestedSheets:s.sheets.length,resultSheets:result.schematic.sheets.length,placedSections:result.sections.length,routes:result.routes.length,labels:result.labels.length,elapsedMs,rssMiB:Math.round(memory.rss/1024/1024*100)/100,peakRssMiB:Math.round(process.resourceUsage().maxRSS/1024*100)/100,heapUsedMiB:Math.round(memory.heapUsed/1024/1024*100)/100,issues:byCode};
 console.log(JSON.stringify(value));return value;
}

const results=[];
results.push(await measure('reference-500-components-1000-label-nets-20-A3',reference('label',500,20)));
results.push(await measure('wire-stress-100-components-200-auto-nets-4-A3',reference('auto',100,4)));
mkdirSync('artifacts',{recursive:true});
writeFileSync('artifacts/benchmark.json',JSON.stringify({runAt:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,notes:['Measured in the development environment without Docker CPU/memory limits; timings are not a guarantee for a 2-core host.','Four physical pins per component; every pin belongs to exactly one 2-terminal net; groups/sections assigned pages but positions automatic.','Label reference validates the agreed scale; auto-wire stress deliberately contains cyclic feedback and may report routing limitations.','Memory figures are process RSS; peak includes previous benchmark scenarios in the same process.'],results},null,2)+'\n');
if(results[0].placedSections!==500 || results[0].resultSheets!==20 || Object.keys(results[0].issues).some(k=>k.startsWith('error:')))process.exitCode=1;
