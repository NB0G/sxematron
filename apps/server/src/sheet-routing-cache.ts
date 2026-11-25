import {createHash} from 'node:crypto';
import type {PlacedSection,Schematic} from '../../../packages/core/src/types.js';
import type {RoutedSheets,SheetRouteMemo} from '../../../packages/core/src/routing.js';

const ttlMs=30_000;
const limitBytes=4*1024*1024;

/** Short-lived per-worker memo; an exact content match or a fresh route. */
export class SheetRoutingCache {
 private bytes=0;
 private entries=new Map<string,{value:RoutedSheets;bytes:number;expires:number}>();
 private timer?:NodeJS.Timeout;

 memo(s:Schematic,sections:PlacedSection[]):SheetRouteMemo{
  const terminal=(id:string,number:string)=>JSON.stringify([id,number]);
  const locations=new Map<string,string>(),local=new Map<string,PlacedSection[]>();
  for(const a of sections){
   const list=local.get(a.sheet_id);
   if(list)list.push(a);else local.set(a.sheet_id,[a]);
   for(const p of a.section.pins)locations.set(terminal(a.instance.id,p.number),a.sheet_id);
  }
  const nets=new Map<string,unknown[]>();
  s.nets.forEach((net,ordinal)=>{
   const where=net.pins.map(p=>locations.get(terminal(p.instance_id,p.number)));
   for(const sheet of new Set(where))if(sheet!==undefined){
    const entry=[ordinal,net,where];
    const list=nets.get(sheet);if(list)list.push(entry);else nets.set(sheet,[entry]);
   }
  });
  const locked=s.layout.routes.filter(r=>r.locked);
  const labels=s.layout.labels??[];
  const prefixes=new Map(s.sheets.map((sh,i)=>[sh.id,i]));
  const reservations=new Map<number,string[]>();
  for(const r of locked){
   const m=/^(?:route|label)_(\d+)_/.exec(r.id);if(!m)continue;
   const page=Number(m[1]),list=reservations.get(page);
   if(list)list.push(r.id);else reservations.set(page,[r.id]);
  }
  const common=JSON.stringify([s.sheets.map(sh=>sh.id),s.nets.length,s.components.length]);
  return (sheet,calculate)=>{
   const own=local.get(sheet);
   if(!own?.length&&!locked.some(r=>r.sheet_id===sheet))return calculate();
   const key=createHash('sha256').update(common).update(JSON.stringify([
    sheet,own,nets.get(sheet),
    reservations.get(prefixes.get(sheet)!),
    locked.filter(r=>r.sheet_id===sheet),
    labels.filter(l=>locations.get(terminal(l.instance_id,l.number))===sheet)
   ])).digest('hex');
   const now=Date.now();this.prune(now);
   const cached=this.entries.get(key);
   if(cached){this.entries.delete(key);this.entries.set(key,cached);return cached.value;}
   const value=calculate(),bytes=Buffer.byteLength(JSON.stringify(value));
   if(bytes<=limitBytes){
    while(this.entries.size&&(this.bytes+bytes>limitBytes||this.entries.size>=128))this.remove(this.entries.keys().next().value!);
    this.entries.set(key,{value,bytes,expires:Date.now()+ttlMs});this.bytes+=bytes;
    this.timer??=setTimeout(this.expire,ttlMs).unref();
   }
   return value;
  };
 }

 private remove(key:string){this.bytes-=this.entries.get(key)!.bytes;this.entries.delete(key);}
 private prune(now:number){for(const [key,entry] of this.entries)if(entry.expires<=now)this.remove(key);}
 private expire=()=>{
  this.timer=undefined;
  const now=Date.now();this.prune(now);
  if(this.entries.size)this.timer=setTimeout(this.expire,Math.max(1,Math.min(...[...this.entries.values()].map(e=>e.expires-now)))).unref();
 };
}
