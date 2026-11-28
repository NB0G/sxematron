import {conductors,contactPoints,parallelGap,physicalPinKey,visitPairs,type Conductor} from './conductors.js';
import {pinPosition,pinLead,pointOnSegment,same} from './geometry.js';
import type {Issue, Net, PlacedSection, Point, Resolved, Schematic, Terminal} from './types.js';

export const PARALLEL_WIRE_SPACING=3;

export const portId=(net:string,a:string,b:string)=>JSON.stringify([net,...[a,b].sort()]);

export function continuationPairs(s:Schematic,locations:ReadonlyMap<string,string>){
 return s.nets.flatMap(net=>{
  if(net.role==='ground')return [];
  const occupied=new Set(net.pins.map(p=>locations.get(physicalPinKey(p.instance_id,p.number))));
  const sheets=s.sheets.filter(sheet=>occupied.has(sheet.id));
  return sheets.slice(1).map((sheet,i)=>({net:net.id,from:sheets[i].id,to:sheet.id,id:portId(net.id,sheets[i].id,sheet.id)}));
 });
}

export function auditConnections(r:Pick<Resolved,'schematic'|'sections'|'routes'|'labels'>){
 const issues:Issue[]=[],parts=conductors(r.routes);
 const pages=new Map<string,Conductor[]>();
 const parents=r.routes.map((_,i)=>i);
 function root(i:number):number{
  while(parents[i]!==i){parents[i]=parents[parents[i]];i=parents[i];}
  return i;
 }
 function join(a:number,b:number){parents[root(a)]=root(b);}
 for(const p of parts){
  const sheet=p.wire.sheet_id,page=pages.get(sheet);
  if(page)page.push(p);else pages.set(sheet,[p]);
 }
 const report=(code:string,sheet:string,net:string,message:string,point?:Point,pins?:Terminal[],obstacle?:string)=>{
  issues.push({severity:'error',code,path:'sheets.'+sheet,sheet_id:sheet,net_id:net,point,pins,obstacle,message});
 };
 let crossings=0,spacingViolations=0,ambiguousContacts=0;
 const diagnosed=new Set<string>();
 for(const [sheet,page] of pages)visitPairs(page,PARALLEL_WIRE_SPACING,(a,b)=>{
  if(a.index===b.index)return;
  const sameNet=a.wire.net_id===b.wire.net_id;
  const [p,q,u,v]=[a.a,a.b,b.a,b.b];
  const contact=contactPoints(p,q,u,v)[0],gap=parallelGap(p,q,u,v);
  if(sameNet){if(contact)join(a.index,b.index);return;}
  let code:string|undefined;
  if(contact&&((p.x===q.x)===(u.x===v.x)||[p,q,u,v].some(end=>same(end,contact)))){
   ambiguousContacts++;code='AMBIGUOUS_CROSSING';
  }else if(contact)crossings++;
  else if(gap!==undefined&&gap<PARALLEL_WIRE_SPACING-.001){spacingViolations++;code='WIRE_SPACING';}
  if(code){
   const id=JSON.stringify([code,...[a.index,b.index].sort()]);
   if(diagnosed.has(id))return;
   diagnosed.add(id);
   report(code,sheet,a.wire.net_id,code==='WIRE_SPACING'
    ? `Лист ${sheet}: между участками ${a.wire.id} и ${b.wire.id} меньше 3 мм`
    : `Лист ${sheet}: касание проводников разных цепей ${a.wire.net_id} и ${b.wire.net_id}`,contact??p,undefined,b.wire.id);
  }
 });
 const netByPin=new Map<string,Net>(),locations=new Map<string,string>();
 for(const net of r.schematic.nets)for(const p of net.pins){
  const key=physicalPinKey(p.instance_id,p.number),previous=netByPin.get(key);
  if(previous)report('DUPLICATE_DRAWING_PIN','',net.id,`${p.instance_id}.${p.number}: повторное назначение вывода`,undefined,[p],previous.id);
  netByPin.set(key,net);
 }
 const contacts=(sheet:string,point:Point)=>(pages.get(sheet)??[]).filter(p=>pointOnSegment(point,p.a,p.b));
 const covered=new Map<string,{index:number;sheet:string;pin:Terminal;point:Point}[]>();
 let missingTerminals=0,orphanLabels=0,disconnectedGroups=0,unpairedPorts=0,foreignPins=0,duplicateGrounds=0,invalidLabels=0;
 const expected=new Map<string,{owner:PlacedSection;point:Point}>();
 for(const a of r.sections)for(const p of a.section.pins){
  const pin={instance_id:a.instance.id,number:p.number},key=physicalPinKey(pin.instance_id,pin.number);
  const point=pinPosition(a,p),net=netByPin.get(key),segments=contacts(a.sheet_id,point);
  locations.set(key,a.sheet_id);
  if(net)expected.set(key,{owner:a,point});
  const lead=pinLead(a,p);
  const wrong=(pages.get(a.sheet_id)??[]).find(s=>s.wire.net_id!==net?.id&&contactPoints(s.a,s.b,...lead).length);
  if(wrong){
   foreignPins++;
   const contact=contactPoints(wrong.a,wrong.b,...lead)[0];
   report('FOREIGN_PIN_CONTACT',a.sheet_id,wrong.wire.net_id,`${wrong.wire.net_id}: проводник касается чужого вывода ${a.instance.designator??pin.instance_id}.${pin.number}`,contact,[pin],wrong.wire.id);
  }
  if(!net)continue;
  const wire=segments.find(s=>s.wire.net_id===net.id);
  if(!wire){
   missingTerminals++;
   report('DRAWING_DISCONNECTED',a.sheet_id,net.id,`${net.name||net.id}: проводник не доходит до ${a.instance.designator??pin.instance_id}.${pin.number}`,point,[pin]);
  }else{
   const entry={index:wire.index,sheet:a.sheet_id,pin,point},list=covered.get(net.id);
   if(list)list.push(entry);else covered.set(net.id,[entry]);
  }
 }
 for(const [key,net] of netByPin)if(!locations.has(key)){
  missingTerminals++;
  const [instance_id,number]=key.split('\0');
  report('DRAWING_DISCONNECTED','',net.id,`${net.id}: вывод ${instance_id}.${number} отсутствует на чертеже`,undefined,[{instance_id,number}]);
 }
 const physicalRoots=parents.map((_,index)=>root(index));
 const pairs=continuationPairs(r.schematic,locations),byPair=new Map(pairs.map(pair=>[pair.id,pair]));
 const portEnds=new Map<string,Map<string,number[]>>(),verifiedPorts=new Set<string>();
 const named=new Map<string,number>();
 const grounds=new Map<number,number>();
 const groundNet=r.schematic.nets.find(net=>net.role==='ground')?.id;
 for(const label of r.labels){
  const {sheet_id:sheet,net_id:net,point,peerSheet}=label,segments=contacts(sheet,point);
  const wire=segments.find(s=>s.wire.net_id===net);
  if(!wire){
   orphanLabels++;
   report('ORPHAN_LABEL',sheet,net,`${net}: обозначение не касается своего проводника`,point);
   continue;
  }
  if(label.role==='ground'){
   if(net!==groundNet||label.text||peerSheet||label.approach!=='down'||!segments.some(s=>s.wire.net_id===net&&s.a.x===s.b.x&&Math.min(s.a.y,s.b.y)<point.y)){
    invalidLabels++;
    report('INVALID_GROUND',sheet,net,`${net}: недопустимое обозначение земли`,point);
    continue;
   }
   const island=physicalRoots[wire.index],n=grounds.get(island)??0;
   if(n){duplicateGrounds++;report('DUPLICATE_GROUND',sheet,net,`${net}: повторный знак земли на одном проводнике`,point);}
   grounds.set(island,n+1);
  }
  const localKey=JSON.stringify([sheet,net]),existing=named.get(localKey);
  if(existing===undefined)named.set(localKey,wire.index);else join(existing,wire.index);
  if(label.role==='ground')continue;
  if(peerSheet||label.continuation){
   const key=peerSheet?portId(net,sheet,peerSheet):'';
   if(!byPair.has(key)||label.pairId!==key){
    unpairedPorts++;
    report('INVALID_PORT',sheet,net,`${net}: неизвестный межлистовой переход на ${peerSheet??'неуказанный лист'}`,point);
   }else{
    const ends=portEnds.get(key)??new Map<string,number[]>();
    const list=ends.get(sheet)??[];list.push(wire.index);ends.set(sheet,list);portEnds.set(key,ends);
   }
  }
 }
 // Union earth symbols only after counting physical islands.
 let missingGrounds=0;
 if(groundNet){
  const islands=new Map((covered.get(groundNet)??[]).map(item=>[physicalRoots[item.index],item]));
  for(const [island,item] of islands)if(!grounds.has(island)){
   missingGrounds++;
   report('MISSING_GROUND',item.sheet,groundNet,`${groundNet}: нет знака земли у проводника ${item.pin.instance_id}.${item.pin.number}`,item.point,[item.pin]);
  }
 }
 let earth:number|undefined;
 for(const index of grounds.keys()){if(earth===undefined)earth=index;else join(earth,index);}
 for(const pair of pairs){
  const ends=portEnds.get(pair.id),from=ends?.get(pair.from),to=ends?.get(pair.to);
  if(from?.length===1&&to?.length===1){join(from[0],to[0]);verifiedPorts.add(pair.id);continue;}
  unpairedPorts++;
  report('UNPAIRED_PORT',pair.from,pair.net,`${pair.net}: требуется по одному подключённому переходу между ${pair.from} и ${pair.to}`,undefined,undefined,pair.to);
 }
 for(const [net,terminals] of covered){
  const first=terminals[0],seen=new Set([root(first.index)]);
  for(const item of terminals){
   const id=root(item.index);
   if(seen.has(id))continue;
   seen.add(id);disconnectedGroups++;
   report('DRAWING_DISCONNECTED',item.sheet,net,`${net}: выводы ${item.pin.instance_id}.${item.pin.number} и ${first.pin.instance_id}.${first.pin.number} разделены`,item.point,[item.pin,first.pin]);
  }
 }
 return {issues,expected,verifiedPorts,crossings,spacingViolations,ambiguousContacts,missingTerminals,orphanLabels,disconnectedGroups,unpairedPorts,foreignPins,duplicateGrounds,missingGrounds,invalidLabels};
}
