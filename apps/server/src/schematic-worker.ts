import { parentPort } from 'node:worker_threads';
import { buildSchematic } from '../../../packages/core/src/layout.js';
import { renderSheet } from '../../../packages/core/src/render.js';
import { mergeRoutedSheets, routeSheetBatch, type RoutedSheets } from '../../../packages/core/src/routing.js';
import { validateComponent } from '../../../packages/core/src/validation.js';
import type { Library, PlacedSection, Schematic } from '../../../packages/core/src/types.js';
import { SheetRoutingCache } from './sheet-routing-cache.js';
import type { BuildReply, BuildRequest, FromWorker, ToWorker } from './schematic-build.js';

const sheetCache=new SheetRoutingCache();
const routeCached=(s:Schematic,sections:PlacedSection[],sheets:readonly string[])=>routeSheetBatch(s,sections,sheets,sheetCache.memo(s,sections));
const maxResultBytes = 16*1024*1024;
let routing: {
  acceptPlan: (batches:string[][])=>void;
  parts: Map<number,(part?:RoutedSheets)=>void>;
}|undefined;

async function calculate({schematic,library,options,preview}: BuildRequest): Promise<BuildReply> {
  const codes = new Set<string>();
  for (const candidate of library) {
    const issues = validateComponent(candidate).filter(issue=>issue.severity==='error');
    if (issues.length) return {ok:false,status:400,message:'Библиотека схемы не прошла проверку.',issues:issues.slice(0,100)};
    const code = (candidate as Library[number]).component_code;
    if (codes.has(code)) return {ok:false,status:400,message:`Код ${code} повторяется в библиотеке схемы.`};
    codes.add(code);
  }
  let routingWorkers=1;
  const route = async (placed:Schematic, sections:PlacedSection[]) => {
    if (new Set(sections.map(section=>section.sheet_id)).size<2) return mergeRoutedSheets(placed,[routeCached(placed,sections,placed.sheets.map(sh=>sh.id))]);
    const parts=new Map<number,(part?:RoutedSheets)=>void>();
    const plan=new Promise<string[][]>(acceptPlan=>{routing={acceptPlan,parts};});
    send({kind:'split',schematic:placed,sections});
    try {
      const [local,...remote]=await plan;
      const waiting=remote.map((_,i)=>new Promise<RoutedSheets|undefined>(resolve=>parts.set(i+1,resolve)));
      const own=routeCached(placed,sections,local);
      const results=await Promise.all(waiting);
      routingWorkers+=results.filter(Boolean).length;
      // Fail soft if a helper exits: reroute only its own batch here.
      return mergeRoutedSheets(placed,[own,...remote.map((sheets,i)=>results[i]??routeCached(placed,sections,sheets))]);
    } finally { routing=undefined; }
  };
  const result = await buildSchematic(schematic as Schematic,library as Library,options,route);
  const malformed = result.issues.filter(issue=>issue.severity==='error'&&(issue.code==='SCHEMA'||issue.code==='LIMIT'));
  if (malformed.length) return {ok:false,status:400,message:'Схема не прошла проверку.',issues:malformed.slice(0,100)};

  // Bound encoded previews as they accumulate, before serializing the response as a whole.
  let remaining = maxResultBytes;
  const tooLarge: BuildReply = {ok:false,status:422,message:'Результат построения превышает 16 МиБ. Уменьшите сложность схемы.'};
  const resultJson = JSON.stringify(result);
  remaining -= Buffer.byteLength(resultJson);
  if (remaining < 0) return tooLarge;
  if (!preview) return {ok:true,json:resultJson,routingWorkers};

  const previews: string[] = [];
  for (const {id} of result.schematic.sheets) {
    const entry = JSON.stringify(id)+':'+JSON.stringify(renderSheet(result,id,{interactive:true}));
    remaining -= Buffer.byteLength(entry)+1;
    if (remaining < 13) return tooLarge;
    previews.push(entry);
  }
  return {ok:true,json:resultJson.slice(0,-1)+',"previews":{'+previews.join(',')+'}}',routingWorkers};
}

if (!parentPort) throw new Error('Модуль построения должен выполняться в worker thread.');
const port = parentPort;
const send = (message:FromWorker) => port.postMessage(message);
port.on('message',(message:ToWorker)=>{
  if (message.kind==='plan') routing?.acceptPlan(message.batches);
  else if (message.kind==='part') routing?.parts.get(message.index)?.(message.result);
  else if (message.kind==='route') {
    try { send({kind:'routed',result:routeCached(message.schematic,message.sections,message.sheets)}); }
    catch { send({kind:'routed'}); }
  } else void calculate(message.payload).then(
    reply=>send({kind:'reply',reply}),
    ()=>send({kind:'reply',reply:{ok:false,status:500,message:'Не удалось выполнить построение схемы.'}})
  );
});
