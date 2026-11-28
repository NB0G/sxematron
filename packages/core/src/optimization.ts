import {conductors,physicalPinKey} from './conductors.js';
import {auditConnections} from './connections.js';
import {PAGE,WIRING_STAMP,intersects,placedBodyBounds,printedSectionParts,printedTextBounds,pinDirection,pinPosition,placedBounds,round,sectionBounds,segmentHitsBounds,same,type Bounds} from './geometry.js';
import {measureQuality,betterQuality} from './quality.js';
import {mergeRoutedSheets,routeSheetBatch,labelBounds,labelMarkBounds,type RoutedSheets} from './routing.js';
import {routingSettings,type PlacedSection,type Point,type Pin,type Issue,type Resolved,type Schematic} from './types.js';

const key=(id:string,pin:string)=>id+'\0'+pin;
const dist=(a:Point,b:Point)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
const title=WIRING_STAMP;
type Pose={index:number;position:Point;rotation:number;gain:number;signature:string;kind:'clearance'|'connection'|'rotation'};
type End={index:number;pin:Pin};
type Link={pin:Pin;other:End;difficulty:number};

/** Each trial targets an actual bottleneck. Align a terminal to a connected
 * neighbour's exit, shorten its span, or turn a crowded symbol towards clear
 * space. Estimate incident edges together before spending a routing pass. */
function proposals(r:Resolved,movable:Set<string>,turnable:Set<string>,seen:Set<string>){
 const terminals=new Map(r.sections.flatMap((a,index)=>a.section.pins.map(pin=>[key(a.instance.id,pin.number),{index,pin}] as const)));
 const links=new Map<number,Link[]>(),priority=new Map<number,number>();
 const ink=new Map<string,number>();
 for(const w of r.routes){
  const cost=w.points.slice(1).reduce((n,p,i)=>n+dist(p,w.points[i]),0)+8*Math.max(0,w.points.length-2);
  const k=key(w.sheet_id,w.net_id);ink.set(k,(ink.get(k)??0)+cost);
 }
 for(const n of r.schematic.nets){
  // Do not cluster functionally unrelated blocks through a common power bus.
  if(n.role&&n.role!=='signal'||n.pins.length>12)continue;
  const ends=n.pins.map(t=>terminals.get(key(t.instance_id,t.number))).filter((e):e is End=>!!e);
  for(const end of ends){
   const a=r.sections[end.index];if(!movable.has(a.key))continue;
   const p=pinPosition(a,end.pin),peers=ends.filter(t=>t.index!==end.index&&r.sections[t.index].sheet_id===a.sheet_id);
   const others=peers.map(e=>({e,d:dist(p,pinPosition(r.sections[e.index],e.pin))})).sort((a,b)=>a.d-b.d);
   if(others.length){
    const {e,d}=others[0],drawing=ink.get(key(a.sheet_id,n.id))??0;
    const difficulty=d+Math.max(0,drawing/Math.max(1,peers.length)-d)+(drawing===0?120:0);
    const list=links.get(end.index)??[];list.push({pin:end.pin,other:e,difficulty});links.set(end.index,list);
    priority.set(end.index,Math.max(priority.get(end.index)??0,difficulty));
   }
   const label=r.labels.find(l=>l.sheet_id===a.sheet_id&&l.net_id===n.id&&l.pin?.instance_id===a.instance.id&&l.pin.number===end.pin.number);
   if(label)priority.set(end.index,Math.max(priority.get(end.index)??0,dist(p,label.point)-6));
   else if(!peers.length||n.render==='label')priority.set(end.index,Math.max(priority.get(end.index)??0,120));
  }
 }
 const blockedPins=new Map<number,Pin[]>(),blockers=new Set<number>();
 for(const issue of r.issues)if(issue.severity==='error'){
  for(const pin of issue.pins??[]){
   const end=terminals.get(key(pin.instance_id,pin.number));
   if(!end||!movable.has(r.sections[end.index].key))continue;
   const list=blockedPins.get(end.index)??[];if(!list.includes(end.pin))list.push(end.pin);
   blockedPins.set(end.index,list);priority.set(end.index,500);
  }
  const index=r.sections.findIndex(a=>a.key===issue.obstacle&&movable.has(a.key));
  if(index>=0){blockers.add(index);priority.set(index,550);}
 }
 const boxes=r.sections.map(s=>placedBounds({...s,label_padding:undefined},2.5));
 const choices:Pose[]=[];
 for(const [index,urgency] of [...priority].sort((a,b)=>b[1]-a[1]).slice(0,20)){
  const a=r.sections[index],adj=links.get(index)??[],pins=blockedPins.get(index)??[];
  const environment=JSON.stringify(r.sections.filter(b=>b.sheet_id===a.sheet_id).map(b=>[b.key,b.position,b.rotation]));
  const unique=new Set<string>();
  const otherBoxes=boxes.filter((_,j)=>j!==index&&r.sections[j].sheet_id===a.sheet_id);
  function estimate(trial:PlacedSection){
   return adj.reduce((total,l)=>{
    const b=r.sections[l.other.index],p=pinPosition(trial,l.pin),q=pinPosition(b,l.other.pin);
    const da=pinDirection(trial,l.pin),db=pinDirection(b,l.other.pin),dx=q.x-p.x,dy=q.y-p.y;
    const away=(da.x*dx+da.y*dy<0?10:0)+(db.x*dx+db.y*dy>0?10:0);
    const obstruction=(corner:Point)=>boxes.filter((box,j)=>j!==index&&j!==l.other.index&&r.sections[j].sheet_id===a.sheet_id&&
     (segmentHitsBounds(p,corner,box)||segmentHitsBounds(corner,q,box))).length;
    return total+dist(p,q)+away+(dx!==0&&dy!==0?7:0)+18*Math.min(obstruction({x:p.x,y:q.y}),obstruction({x:q.x,y:p.y}));
   },0);
  }
  const current=estimate(a);
  for(const rotation of turnable.has(a.key)?[a.rotation,...[0,90,180,270].filter(v=>v!==a.rotation)]:[a.rotation]){
   const zero={...a,rotation,position:{x:0,y:0}},b=placedBounds({...zero,label_padding:undefined},2.5);
   function offer(x:number,y:number,kind:Pose['kind']='connection'){
    const position={x:round(x),y:round(y)},signature=JSON.stringify([a.key,position.x,position.y,rotation,environment]);
    if(seen.has(signature)||unique.has(signature)||rotation===a.rotation&&dist(position,a.position)<.01)return;
    const box:Bounds={x:b.x+x,y:b.y+y,right:b.right+x,bottom:b.bottom+y};
    if(box.x<PAGE.drawing.x||box.right>PAGE.drawing.right||box.y<PAGE.drawing.y||box.bottom>PAGE.drawing.bottom||intersects(box,title))return;
    if(otherBoxes.some(o=>intersects(box,o)))return;
    const candidate={...zero,position};
    const available=(trial:PlacedSection,pin:Pin)=>{
     const p=pinPosition(trial,pin),d=pinDirection(trial,pin),q={x:p.x+d.x*32,y:p.y+d.y*32};
     const room=Math.max(0,32-(Math.max(0,22-q.x,q.x-413,7-q.y,q.y-290)));
     return room-10*otherBoxes.filter(box=>segmentHitsBounds(p,q,box)).length;
    };
    const improvement=pins.reduce((n,p)=>n+available(candidate,p)-available(a,p),0);
    const gain=current-estimate(candidate)+.28*urgency+6*improvement-.12*dist(position,a.position);
    if(gain>0){choices.push({index,position,rotation,gain,signature,kind});unique.add(signature);}
   }
   // Align the two pins; allow enough room for the captions and for local
   // fan-out instead of relying on movement on a fine exhaustive grid.
   for(const l of [...adj].sort((u,v)=>v.difficulty-u.difficulty).slice(0,4)){
    const peer=r.sections[l.other.index],q=pinPosition(peer,l.other.pin),out=pinDirection(peer,l.other.pin),inlet=pinPosition(zero,l.pin);
    for(const gap of [8,16,28])offer(q.x+out.x*gap-inlet.x,q.y+out.y*gap-inlet.y);
    offer(q.x-inlet.x,a.position.y);offer(a.position.x,q.y-inlet.y);
   }
   offer(a.position.x,a.position.y,'rotation');
   if(pins.length||blockers.has(index))for(const gap of [5,12,22,36])for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]])
    offer(a.position.x+dx*gap,a.position.y+dy*gap,'clearance');
   // A crowded labelled island may have no in-sheet electrical neighbours.
   // Try clearance towards the page interior rather than arbitrary permutations.
   if(!adj.length&&urgency>5){const dx=Math.sign((PAGE.drawing.x+PAGE.drawing.right)/2-a.position.x),dy=Math.sign((PAGE.drawing.y+PAGE.drawing.bottom)/2-a.position.y);offer(a.position.x+dx*10,a.position.y);offer(a.position.x,a.position.y+dy*10);}
  }
 }
 choices.sort((a,b)=>b.gain-a.gain);
 const selected:Pose[]=[];
 for(const move of choices)if(!selected.some(a=>a.index===move.index||a.kind===move.kind&&r.sections[a.index].sheet_id===r.sections[move.index].sheet_id)){
  selected.push(move);
  if(selected.length===3)break;
 }
 return selected;
}

function checkWireGeometry(r:Resolved):Issue[]{
 const clearance=routingSettings(r.schematic.layout).bodyClearance,issues:Issue[]=[];
 const ownNet=new Map(r.schematic.nets.flatMap(n=>n.pins.map(p=>[physicalPinKey(p.instance_id,p.number),n.id] as const)));
 const pages=new Map<string,{
  section:PlacedSection;body?:Bounds;printing:Bounds[];box?:Bounds;
  pins:{point:Point;out:Point;net?:string}[];
 }[]>();
 for(const section of r.sections){
  const entries=pages.get(section.sheet_id)??[];
  entries.push({section,body:placedBodyBounds(section),printing:printedTextBounds(section),box:placedBodyBounds(section,clearance),
   pins:section.section.pins.map(p=>({point:pinPosition(section,p),out:pinDirection(section,p),net:ownNet.get(physicalPinKey(section.instance.id,p.number))}))});
  pages.set(section.sheet_id,entries);
 }
 const reported=new Set<string>();
 for(const {a,b,wire} of conductors(r.routes)){
  for(const entry of pages.get(wire.sheet_id)??[]){
   const {section,body,printing,box,pins}=entry;
   const own=pins.some(({point,out,net})=>{
    if(wire.net_id!==net)return false;
    const other=same(point,a)?b:same(point,b)?a:undefined;
    return !!other&&(out.x?other.y===point.y&&(other.x-point.x)*out.x>0:other.x===point.x&&(other.y-point.y)*out.y>0);
   });
   const touches=printing.some(bound=>segmentHitsBounds(a,b,bound))||!own&&body&&segmentHitsBounds(a,b,body);
   if(!touches&&(own||!box||!segmentHitsBounds(a,b,box)))continue;
   const code=wire.locked?(touches?'LOCKED_ROUTE_OBSTACLE':'LOCKED_ROUTE_CLEARANCE'):(touches?'ROUTE_OBSTACLE':'ROUTE_CLEARANCE');
   const id=JSON.stringify([wire.id,section.key,code]);
   if(reported.has(id))continue;
   reported.add(id);
   issues.push({severity:'error',code,path:'sheets.'+wire.sheet_id,sheet_id:wire.sheet_id,net_id:wire.net_id,point:a,obstacle:section.key,
    message:`Маршрут ${wire.id} ${touches?'пересекает обозначение':'нарушает зазор до корпуса'} ${section.instance.designator}/${section.section.section_id}`});
  }
  if(segmentHitsBounds(a,b,title)&&!reported.has(wire.id)){
   reported.add(wire.id);
   issues.push({severity:'error',code:'ROUTE_OUT_OF_BOUNDS',sheet_id:wire.sheet_id,net_id:wire.net_id,point:a,obstacle:'stamp',
    message:`Маршрут ${wire.id} пересекает штамп`});
  }
 }
 return issues;
}

export function finishDrawing(s:Schematic,sections:PlacedSection[],issues0:Issue[],routed:RoutedSheets):Resolved{
 const issues=[...issues0,...routed.issues];
 const physical=new Map(sections.map(a=>[a,printedSectionParts(a)]));
 for(const a of sections){
  if(physical.get(a)!.some(box=>box.x<=PAGE.frame.x+.175||box.y<=PAGE.frame.y+.175||box.right>=PAGE.frame.x+PAGE.frame.width-.175||
   box.bottom>=PAGE.frame.y+PAGE.frame.height-.175||intersects(box,title))){
   issues.push({severity:'error',code:'OUT_OF_BOUNDS',sheet_id:a.sheet_id,point:a.position,obstacle:a.key,message:`${a.instance.designator}/${a.section.section_id}: выходит за рабочее поле или заходит на штамп`});
  }
 }
 for(let i=0;i<sections.length;i++)for(let j=i+1;j<sections.length;j++){
  const a=sections[i],b=sections[j];
  if(a.sheet_id===b.sheet_id&&physical.get(a)!.some(box=>physical.get(b)!.some(other=>intersects(box,other)))){
   issues.push({severity:'error',code:'OVERLAP',sheet_id:a.sheet_id,point:a.position,obstacle:b.key,message:`Наложение ${a.instance.designator}/${a.section.section_id} и ${b.instance.designator}/${b.section.section_id}`});
  }
 }
 const labelBoxes=routed.labels.flatMap(label=>[
  {label,box:labelMarkBounds(label.point,label.approach??'right',label.role==='ground')},
  ...(label.text?[{label,box:labelBounds(label.text,label.point,label.alignLeft??false,label.textShift)}]:[])
 ]);
 for(let i=0;i<labelBoxes.length;i++){
  const a=labelBoxes[i],{sheet_id,net_id,point}=a.label;
  const issue={severity:'error' as const,sheet_id,net_id,point,pins:a.label.pin?[a.label.pin]:undefined};
  if(a.box.x<20||a.box.right>415||a.box.y<5||a.box.bottom>292||intersects(a.box,title))issues.push({...issue,code:'LABEL_OUT_OF_BOUNDS',message:`Метка ${a.label.text}: выходит за рамку или заходит на штамп`});
  const owner=sections.find(other=>other.sheet_id===sheet_id&&physical.get(other)!.some(b=>intersects(a.box,b)));
  if(owner)issues.push({...issue,obstacle:owner.key,code:'LABEL_OVERLAP',message:`Метка ${a.label.text}: пересекает ${owner.instance.designator}/${owner.section.section_id}`});
  for(let j=i+1;j<labelBoxes.length;j++){const b=labelBoxes[j];if(a.label!==b.label&&sheet_id===b.label.sheet_id&&intersects(a.box,b.box))issues.push({...issue,code:'LABEL_OVERLAP',message:`Пересекаются метки ${a.label.text} и ${b.label.text}`});}
 }
 s.layout.routes=routed.routes;
 const result:Resolved={schematic:s,sections,routes:routed.routes,labels:routed.labels,issues};
 const audit=auditConnections(result);
 issues.push(...checkWireGeometry(result));
 issues.push(...audit.issues);
 result.labels=result.labels.map(label=>label.continuation&&(!label.pairId||!audit.verifiedPorts.has(label.pairId))?{...label,unpaired:true}:label);
 result.quality=measureQuality(result,audit);
 return result;
}

export function refineDrawing(initial:Resolved,baseline:RoutedSheets,issues:Issue[],movable:Set<string>,turnable:Set<string>):Resolved{
 let best=initial,tiles=baseline;
 const seen=new Set<string>(),limit=routingSettings(initial.schematic.layout).iterations;
 for(let step=1;step<limit&&movable.size;step++){
  const moves=proposals(best,movable,turnable,seen);
  if(!moves.length)break;
  let winner=best,winningRoutes=tiles;
  for(const move of moves){
   seen.add(move.signature);
   // Clone the project and placements together so editor references survive.
   const {schematic:s,sections}=structuredClone({schematic:best.schematic,sections:best.sections});
   const a=sections[move.index],sheet=a.sheet_id;
   a.position=move.position;a.rotation=move.rotation;
   a.placement.position={...move.position};
   if(a.placement.relative){
    const base=s.groups.find(g=>g.tag===a.instance.tag)?.position;
    if(base)a.placement.position={x:round(a.position.x-base.x),y:round(a.position.y-base.y)};
   }
   if(move.rotation!==best.sections[move.index].rotation){
    a.placement.rotation=move.rotation;
    a.placement.autoRotation=true;
   }
   const box=sectionBounds(a.section,a.rotation,a.mirror,{...a.instance,label_padding:a.label_padding});
   a.width=box.right-box.x;a.height=box.bottom-box.y;
   const update=routeSheetBatch(s,sections,[sheet]);
   const batches=s.sheets.map(sh=>sh.id===sheet?update:{
    routes:tiles.routes.filter(w=>!w.locked&&w.sheet_id===sh.id),labels:tiles.labels.filter(l=>l.sheet_id===sh.id),
    issues:tiles.issues.filter(i=>i.path==='sheets.'+sh.id)
   });
   const routed=mergeRoutedSheets(s,batches),trial=finishDrawing(s,sections,issues,routed);
   if(betterQuality(trial.quality!,winner.quality!)){winner=trial;winningRoutes=routed;}
  }
  best=winner;tiles=winningRoutes;
 }
 return best;
}
