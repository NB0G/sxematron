import {PAGE,intersects,pinDirection,pinPosition,placedBounds,round,sectionBounds,type Bounds} from './geometry.js';
import {measureQuality,betterQuality} from './quality.js';
import {mergeRoutedSheets,routeSheetBatch,labelBounds,type RoutedSheets} from './routing.js';
import {routingSettings,type PlacedSection,type Point,type Pin,type Issue,type Resolved,type Schematic} from './types.js';

const key=(id:string,pin:string)=>id+'\0'+pin;
const dist=(a:Point,b:Point)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
const title={x:PAGE.stamp.x-4,y:PAGE.stamp.y-4,right:PAGE.stamp.x+PAGE.stamp.width,bottom:PAGE.stamp.y+PAGE.stamp.height};
type Pose={index:number;position:Point;rotation:number;gain:number;signature:string};
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
   if(others.length&&n.render!=='label'){
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
 const boxes=r.sections.map(s=>placedBounds({...s,label_padding:undefined},2.5));
 const choices:Pose[]=[];
 for(const [index,urgency] of [...priority].sort((a,b)=>b[1]-a[1]).slice(0,20)){
  const a=r.sections[index],adj=links.get(index)??[];
  function estimate(trial:PlacedSection){
   return adj.reduce((total,l)=>{
    const b=r.sections[l.other.index],p=pinPosition(trial,l.pin),q=pinPosition(b,l.other.pin);
    const da=pinDirection(trial,l.pin),db=pinDirection(b,l.other.pin),dx=q.x-p.x,dy=q.y-p.y;
    const away=(da.x*dx+da.y*dy<0?10:0)+(db.x*dx+db.y*dy>0?10:0);
    return total+dist(p,q)+away+(dx!==0&&dy!==0?7:0);
   },0);
  }
  const current=estimate(a);
  for(const rotation of turnable.has(a.key)?[a.rotation,...[0,90,180,270].filter(v=>v!==a.rotation)]:[a.rotation]){
   const zero={...a,rotation,position:{x:0,y:0}},b=placedBounds({...zero,label_padding:undefined},2.5);
   function offer(x:number,y:number){
    const position={x:round(x),y:round(y)},signature=JSON.stringify([a.key,position.x,position.y,rotation]);
    if(seen.has(signature)||rotation===a.rotation&&dist(position,a.position)<.01)return;
    const box:Bounds={x:b.x+x,y:b.y+y,right:b.right+x,bottom:b.bottom+y};
    if(box.x<PAGE.drawing.x||box.right>PAGE.drawing.right||box.y<PAGE.drawing.y||box.bottom>PAGE.drawing.bottom||intersects(box,title))return;
    if(boxes.some((o,j)=>j!==index&&r.sections[j].sheet_id===a.sheet_id&&intersects(box,o)))return;
    const gain=current-estimate({...zero,position})+.28*urgency-.05*dist(position,a.position);
    if(gain>0)choices.push({index,position,rotation,gain,signature});
   }
   // Align the two pins; allow enough room for the captions and for local
   // fan-out instead of relying on movement on a fine exhaustive grid.
   for(const l of [...adj].sort((u,v)=>v.difficulty-u.difficulty).slice(0,4)){
    const peer=r.sections[l.other.index],q=pinPosition(peer,l.other.pin),out=pinDirection(peer,l.other.pin),inlet=pinPosition(zero,l.pin);
    for(const gap of [8,16,28])offer(q.x+out.x*gap-inlet.x,q.y+out.y*gap-inlet.y);
    offer(q.x-inlet.x,a.position.y);offer(a.position.x,q.y-inlet.y);
   }
   offer(a.position.x,a.position.y);
   // A crowded labelled island may have no in-sheet electrical neighbours.
   // Try clearance towards the page interior rather than arbitrary permutations.
   if(!adj.length&&urgency>5){const dx=Math.sign((PAGE.drawing.x+PAGE.drawing.right)/2-a.position.x),dy=Math.sign((PAGE.drawing.y+PAGE.drawing.bottom)/2-a.position.y);offer(a.position.x+dx*10,a.position.y);offer(a.position.x,a.position.y+dy*10);}
  }
 }
 return choices.sort((a,b)=>b.gain-a.gain)[0];
}

export function finishDrawing(s:Schematic,sections:PlacedSection[],issues0:Issue[],routed:RoutedSheets):Resolved{
 const issues=[...issues0,...routed.issues],physical=new Map(sections.map(a=>[a,placedBounds({...a,label_padding:undefined})]));
 const labelBoxes=routed.labels.filter(l=>l.text).map(label=>{const owner=sections.find(a=>a.instance.id===label.pin?.instance_id&&a.section.pins.some(p=>p.number===label.pin?.number));return{label,owner,box:labelBounds(label.text,label.point,label.alignLeft??false)};});
 for(let i=0;i<labelBoxes.length;i++){
  const a=labelBoxes[i],{sheet_id}=a.label;
  if(a.box.x<20||a.box.right>415||a.box.y<5||a.box.bottom>292)issues.push({severity:'warning',code:'LABEL_OUT_OF_BOUNDS',message:`Метка ${a.label.text}: выходит за рамку листа`});
  if(sections.some(other=>other!==a.owner&&other.sheet_id===sheet_id&&intersects(a.box,physical.get(other)!)))issues.push({severity:'warning',code:'LABEL_OVERLAP',message:`Метка ${a.label.text}: пересекает другой компонент или его подпись`});
  for(let j=i+1;j<labelBoxes.length;j++){const b=labelBoxes[j];if(sheet_id===b.label.sheet_id&&intersects(a.box,b.box))issues.push({severity:'warning',code:'LABEL_OVERLAP',message:`Пересекаются метки ${a.label.text} и ${b.label.text}`});}
 }
 s.layout.routes=routed.routes;
 const result:Resolved={schematic:s,sections,routes:routed.routes,labels:routed.labels,issues};
 result.quality=measureQuality(result);return result;
}

export function refineDrawing(initial:Resolved,baseline:RoutedSheets,issues:Issue[],movable:Set<string>,turnable:Set<string>):Resolved{
 let best=initial,tiles=baseline,stale=0;
 const seen=new Set<string>(),limit=routingSettings(initial.schematic.layout).iterations;
 for(let step=1;step<limit&&movable.size&&stale<2;step++){
  const move=proposals(best,movable,turnable,seen);if(!move)break;
  seen.add(move.signature);
  // Clone together, retaining the section ↔ instance ↔ placement references.
  const {schematic:s,sections}=structuredClone({schematic:best.schematic,sections:best.sections});
  const a=sections[move.index],sheet=a.sheet_id;
  a.position=move.position;a.rotation=move.rotation;a.placement.position={...move.position};delete a.placement.relative;
  if(move.rotation||a.placement.rotation!==undefined)a.placement.rotation=move.rotation;
  const box=sectionBounds(a.section,a.rotation,a.mirror,{...a.instance,label_padding:a.label_padding});a.width=box.right-box.x;a.height=box.bottom-box.y;
  const update=routeSheetBatch(s,sections,[sheet]);
  // Only positions on this sheet changed; net membership, page addresses
  // and reservations for manual wires on all other sheets are identical.
  const batches=s.sheets.map(sh=>sh.id===sheet?update:{
   routes:tiles.routes.filter(w=>!w.locked&&w.sheet_id===sh.id),labels:tiles.labels.filter(l=>l.sheet_id===sh.id),
   issues:tiles.issues.filter(i=>i.path==='sheets.'+sh.id)
  });
  const routed=mergeRoutedSheets(s,batches),trial=finishDrawing(s,sections,issues,routed);
  if(betterQuality(trial.quality!,best.quality!)){best=trial;tiles=routed;stale=0;}
  else stale++;
 }
 if(best.quality!.missingTerminals||best.quality!.disconnectedGroups||best.quality!.orphanLabels){
  const q=best.quality!;best.issues.push({severity:'error',code:'DRAWING_DISCONNECTED',message:`Проверка связности чертежа: неподключённых выводов: ${q.missingTerminals}; разрывов: ${q.disconnectedGroups}; меток без проводника: ${q.orphanLabels}.`});
  best.quality=measureQuality(best);
 }
 return best;
}
