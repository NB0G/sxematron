import type {Schematic,PlacedSection,WireRoute,Point,Issue,RenderedLabel,Terminal,Pin,Net} from './types.js';
import {routingLimits,routingSettings} from './types.js';
import {PAGE,placedBodyBounds,placedBounds,pinPosition,pinDirection,intersects,simplify,same,pointOnSegment,round,type Bounds} from './geometry.js';
import {bundledDrawingFont,DRAWING_FONT_SCALE} from './font.js';

type Endpoint={point:Point;placed:PlacedSection;pin:Pin;terminal:Terminal};
type Segment=[Point,Point];
type Box={owner?:PlacedSection;bounds:Bounds};
const STEP=PAGE.grid;
const CLEARANCE=.25; // Pin and caption envelope, separate from the actual case.
export const BODY_CLEARANCE=routingLimits.bodyClearance.default;
const LABEL_LEAD=3.75;
export const PARALLEL_WIRE_SPACING=3;
const BEND_COST=6;
const MIN_X=21, MAX_X=414, MIN_Y=6, MAX_Y=291;
const stamp:Bounds={x:PAGE.stamp.x-1,y:PAGE.stamp.y-1,right:415,bottom:292};
const dirs=[{x:1,y:0},{x:0,y:1},{x:-1,y:0},{x:0,y:-1}];
const direction=(a:Point,b:Point)=>a.x===b.x?(a.y<b.y?1:3):(a.x<b.x?0:2);
const opposite=(dir:number)=>(dir+2)%4;
const dist=(a:Point,b:Point)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
function shortJog(points:Point[]){
 let sum=0;
 for(let i=2;i<points.length-1;i++)if(dist(points[i-1],points[i])<1.25)sum+=4;
 return sum;
}
const inFrame=(p:Point)=>p.x>=MIN_X&&p.x<=MAX_X&&p.y>=MIN_Y&&p.y<=MAX_Y;
const segments=(points:Point[]):Segment[]=>points.slice(1).map((p,i)=>[points[i],p]);
const between=(n:number,a:number,b:number)=>n>=Math.min(a,b)&&n<=Math.max(a,b);
const clamp=(n:number,a:number,b:number)=>Math.max(Math.min(a,b),Math.min(Math.max(a,b),n));

class Heap {
 private data:{id:number;score:number}[]=[];
 push(v:{id:number;score:number}){
  let i=this.data.length;this.data.push(v);
  while(i){const p=(i-1)>>1;if(this.data[p].score<=v.score)break;this.data[i]=this.data[p];i=p;}
  this.data[i]=v;
 }
 pop(){
  const first=this.data[0],last=this.data.pop()!;
  if(this.data.length){let i=0;while(i*2+1<this.data.length){let j=i*2+1;if(j+1<this.data.length&&this.data[j+1].score<this.data[j].score)j++;if(last.score<=this.data[j].score)break;this.data[i]=this.data[j];i=j;}this.data[i]=last;}
  return first;
 }
 get length(){return this.data.length;}
}

function segmentHits(a:Point,b:Point,box:Bounds){
 if(a.y===b.y)return a.y>box.y&&a.y<box.bottom&&Math.max(a.x,b.x)>box.x&&Math.min(a.x,b.x)<box.right;
 if(a.x===b.x)return a.x>box.x&&a.x<box.right&&Math.max(a.y,b.y)>box.y&&Math.min(a.y,b.y)<box.bottom;
 return true;
}

function overlap(a:Point,b:Point,c:Point,d:Point){
 return (a.x===b.x&&a.x===c.x&&c.x===d.x&&Math.min(Math.max(a.y,b.y),Math.max(c.y,d.y))-Math.max(Math.min(a.y,b.y),Math.min(c.y,d.y))>.001)||
 (a.y===b.y&&a.y===c.y&&c.y===d.y&&Math.min(Math.max(a.x,b.x),Math.max(c.x,d.x))-Math.max(Math.min(a.x,b.x),Math.min(c.x,d.x))>.001);
}

function hit(a:Point,b:Point,c:Point,d:Point):Point|undefined{
 if(a.x===b.x&&c.x===d.x&&a.x===c.x){const y=clamp(a.y,c.y,d.y);if(between(y,a.y,b.y))return{x:a.x,y};}
 if(a.y===b.y&&c.y===d.y&&a.y===c.y){const x=clamp(a.x,c.x,d.x);if(between(x,a.x,b.x))return{x,y:a.y};}
 if((a.x===b.x)!==(c.x===d.x)){const p=a.x===b.x?{x:a.x,y:c.y}:{x:c.x,y:a.y};if(pointOnSegment(p,a,b)&&pointOnSegment(p,c,d))return p;}
}

function stopAtTree(points:Point[],tree:Segment[]){
 const out=[points[0]];
 if(tree.some(([a,b])=>pointOnSegment(points[0],a,b)))return out;
 for(const [a,b] of segments(points)){
  let nearest:Point|undefined;
  for(const [c,d] of tree){const p=hit(a,b,c,d);if(p&&(!nearest||dist(a,p)<dist(a,nearest)))nearest=p;}
  if(nearest){out.push(nearest);return simplify(out);}
  out.push(b);
 }
 return simplify(out);
}

function withoutLoops(points:Point[]){
 const [start,...rest]=simplify(points);
 const out=[start];
 for(const end of rest){
  while(!same(out.at(-1)!,end)){
   const start=out.at(-1)!;
   let first:{i:number;point:Point}|undefined;
   for(let i=1;i<out.length-1;i++){
    const point=hit(start,end,out[i-1],out[i]);
    if(point&&(!first||dist(start,point)<dist(start,first.point)))first={i,point};
   }
   if(!first){out.push(end);break;}
   out.length=first.i;
   if(!same(out.at(-1)!,first.point))out.push(first.point);
  }
 }
 return simplify(out);
}

type Occupancy={segments:Segment[];tracks:Map<string,Segment[]>;ends:Map<string,Point[]>};
const bucket=(n:number)=>Math.floor(n/PARALLEL_WIRE_SPACING);
function parallelTooClose(a:Point,b:Point,c:Point,d:Point){
 if(a.x===b.x&&c.x===d.x)return Math.abs(a.x-c.x)<PARALLEL_WIRE_SPACING-.001&&Math.min(Math.max(a.y,b.y),Math.max(c.y,d.y))-Math.max(Math.min(a.y,b.y),Math.min(c.y,d.y))>.001;
 if(a.y===b.y&&c.y===d.y)return Math.abs(a.y-c.y)<PARALLEL_WIRE_SPACING-.001&&Math.min(Math.max(a.x,b.x),Math.max(c.x,d.x))-Math.max(Math.min(a.x,b.x),Math.min(c.x,d.x))>.001;
 return false;
}
function trackGuides(occupancy:Occupancy):Box[]{
 return occupancy.segments.map(([a,b])=>({bounds:a.x===b.x
  ? {x:round(a.x-PARALLEL_WIRE_SPACING),right:round(a.x+PARALLEL_WIRE_SPACING),y:Math.min(a.y,b.y),bottom:Math.max(a.y,b.y)}
  : {x:Math.min(a.x,b.x),right:Math.max(a.x,b.x),y:round(a.y-PARALLEL_WIRE_SPACING),bottom:round(a.y+PARALLEL_WIRE_SPACING)}}));
}
function addToMap<T>(map:Map<string,T[]>,key:string,value:T){const found=map.get(key);if(found)found.push(value);else map.set(key,[value]);}
function occupied(wires:WireRoute[],net:string){
 const result:Occupancy={segments:[],tracks:new Map(),ends:new Map()};
 for(const wire of wires)if(wire.net_id!==net){
  for(const s of segments(wire.points)){result.segments.push(s);addToMap(result.tracks,s[0].x===s[1].x?'x'+bucket(s[0].x):'y'+bucket(s[0].y),s);}
  for(const p of [wire.points[0],wire.points.at(-1)!]){addToMap(result.ends,'x'+p.x,p);addToMap(result.ends,'y'+p.y,p);}
 }
 return result;
}

type Blocked=(a:Point,b:Point,owner?:PlacedSection)=>boolean;
function collision(boxes:Box[],foreign:Occupancy):Blocked{
 return (a,b,owner)=>{
  if(!inFrame(a)||!inFrame(b)||boxes.some(o=>(!owner||o.owner!==owner)&&segmentHits(a,b,o.bounds)))return true;
  if(same(a,b))return false;
  const axis=a.x===b.x?'x':'y',at=axis==='x'?a.x:a.y,k=bucket(at);
  for(let i=k-1;i<=k+1;i++)if(foreign.tracks.get(axis+i)?.some(([c,d])=>parallelTooClose(a,b,c,d)))return true;
  return !!foreign.ends.get(axis+at)?.some(p=>pointOnSegment(p,a,b));
 };
}
const onForeign=(p:Point,foreign:Occupancy)=>foreign.segments.some(([a,b])=>pointOnSegment(p,a,b));

function exit(e:Endpoint,box:Bounds){
 const d=pinDirection(e.placed,e.pin),p=e.point;
 return {x:round(d.x<0?box.x:d.x>0?box.right:p.x),y:round(d.y<0?box.y:d.y>0?box.bottom:p.y)};
}

// Try low-bend Manhattan paths first. Exact pin ordinates and obstacle edges are
// retained in the fallback search, so just snapping cannot create a staircase.
function findPath(start:Point,end:Point,boxes:Box[],blocked:Blocked,from:number,to?:number,search=true):Point[]|undefined{
 if(!inFrame(start)||!inFrame(end))return;
 if(same(start,end))return to===opposite(from)?undefined:[start];
 const bend=(a:number,b:number)=>a===b?0:BEND_COST;
 const score=(path:Point[])=>{let cost=shortJog(path),last=from;for(const [a,b]of segments(path)){const next=direction(a,b);if(next===opposite(last)||blocked(a,b))return Infinity;cost+=dist(a,b)+bend(last,next);last=next;}return to===undefined?cost:to===opposite(last)?Infinity:cost+bend(last,to);};
 const mx=round((start.x+end.x)/2),my=round((start.y+end.y)/2);
 const proposals=[
  // Equal-cost bends should use the middle of the gap, not hug a pin.
  [start,{x:mx,y:start.y},{x:mx,y:end.y},end],
  [start,{x:start.x,y:my},{x:end.x,y:my},end],
  [start,{x:end.x,y:start.y},end],[start,{x:start.x,y:end.y},end],
  ...[start.x-STEP,start.x+STEP,end.x-STEP,end.x+STEP].map(x=>[start,{x,y:start.y},{x,y:end.y},end]),
  ...[start.y-STEP,start.y+STEP,end.y-STEP,end.y+STEP].map(y=>[start,{x:start.x,y},{x:end.x,y},end]),
 ];
 let best:Point[]|undefined, bestCost=Infinity;
 for(const proposal of proposals){const path=simplify(proposal);const cost=score(path);if(cost<bestCost){best=path;bestCost=cost;}}
 // Only accept the fast path outright if it attains a lower bound. Facing along
 // the same axis needs two turns when coordinates differ on that axis's normal.
 let lowerBends=to===undefined?0:from===to?0:from===opposite(to)?2:1;
 if(to===from&&((from%2===0&&start.y!==end.y)||(from%2===1&&start.x!==end.x)))lowerBends=2;
 if(!search||bestCost<=dist(start,end)+BEND_COST*lowerBends+.001)return best;
 const coords=(min:number,max:number,s:number,e:number,keys:number[])=>{
  const values=new Set([min,max,s,e]);
  for(let p=Math.ceil(min/STEP)*STEP;p<=max;p+=STEP)values.add(p);
  const center=(s+e)/2;
  const candidates=[...new Set(keys.map(round))].filter(p=>p>=min&&p<=max&&!values.has(p));
  // Limit the extra coordinates so hard bounds on grid memory and time also
  // hold when a large number of components are forced onto the same sheet.
  candidates.sort((a,b)=>Math.abs(a-clamp(a,s,e))-Math.abs(b-clamp(b,s,e))||Math.abs(a-center)-Math.abs(b-center));
  for(const p of candidates.slice(0,64))values.add(p);
  return [...values].sort((a,b)=>a-b);
 };
 const xs=coords(MIN_X,MAX_X,start.x,end.x,boxes.flatMap(o=>[o.bounds.x,o.bounds.right]));
 const ys=coords(MIN_Y,MAX_Y,start.y,end.y,boxes.flatMap(o=>[o.bounds.y,o.bounds.bottom]));
 const w=xs.length, h=ys.length;
 const id=(x:number,y:number,heading:number)=>(y*w+x)*4+heading;
 const point=(i:number):Point=>({x:xs[Math.floor(i/4)%w],y:ys[Math.floor(i/4/w)]});
 const begin=id(xs.indexOf(start.x),ys.indexOf(start.y),from);
 const heap=new Heap(),cost=new Float64Array(w*h*4),parent=new Int32Array(w*h*4),closed=new Uint8Array(w*h*4);
 cost.fill(Infinity);parent.fill(-1);cost[begin]=0;heap.push({id:begin,score:dist(start,end)});
 let visited=0;
 // Keep difficult pages bounded; a valid candidate, if found, remains available.
 while(heap.length&&visited<60000){
  const next=heap.pop(),i=next.id;if(closed[i])continue;if(next.score>=bestCost)break;
  closed[i]=1;visited++;
  const p=point(i),heading=i%4,x=Math.floor(i/4)%w,y=Math.floor(i/4/w);
  if(same(p,end)){
   if(to!==opposite(heading)){
    const path:Point[]=[];for(let j=i;j!==-1;j=parent[j])path.push(point(j));
    const simple=simplify(path.reverse()),total=score(simple);
    if(total<bestCost){bestCost=total;best=simple;}
   }
   continue;
  }
  for(let k=0;k<dirs.length;k++){
   if(k===opposite(heading))continue;
   const nx=x+dirs[k].x,ny=y+dirs[k].y;if(nx<0||nx>=w||ny<0||ny>=h)continue;
   const j=id(nx,ny,k);if(closed[j])continue;
   const q={x:xs[nx],y:ys[ny]},grow=cost[i]+dist(p,q)+bend(heading,k),estimate=grow+dist(q,end);
   if(grow+.0001>=cost[j]||estimate>=bestCost||blocked(p,q))continue;
   cost[j]=grow;parent[j]=i;heap.push({id:j,score:estimate});
  }
 }
 return best;
}

export function labelBounds(text:string,point:Point,left:boolean):Bounds{
 const font=bundledDrawingFont(),size=3.5*DRAWING_FONT_SCALE;
 let width:number,b:Bounds;
 try{
  width=font.getAdvanceWidth(text,size,{kerning:true});
  const {x1,y1,x2,y2}=font.getPath(text,0,0,size,{kerning:true}).getBoundingBox();
  b={x:x1,y:y1,right:x2,bottom:y2};
 }catch{
  width=[...text].length*3.5;
  b={x:0,y:-3.5,right:width,bottom:.5};
 }
 const x=point.x+(left?-1-width:1),y=point.y-1.5;
 return {x:x+b.x-.15,right:x+b.right+.15,y:y+b.y-.15,bottom:y+b.bottom+.15};
}

function terminalGraph(sections:PlacedSection[]){
 const map=new Map<string,Endpoint>();
 for(const placed of sections)for(const pin of placed.section.pins)map.set(`${placed.instance.id}\0${pin.number}`,{point:pinPosition(placed,pin),placed,pin,terminal:{instance_id:placed.instance.id,number:pin.number}});
 return map;
}
const terminalKey=(t:Terminal)=>`${t.instance_id}\0${t.number}`;

export type RoutedSheets={routes:WireRoute[];labels:RenderedLabel[];issues:Issue[]};
export type SheetRouteMemo=(id:string,calculate:()=>RoutedSheets)=>RoutedSheets;

function routeOneSheet(s:Schematic,sections:PlacedSection[],sheet:string,endpoints:Map<string,Endpoint>,netIds:Map<Net,number>,reserved:Set<string>,first?:Net,contactsFirst=false):RoutedSheets&{retry?:Net}{
 const routes:WireRoute[]=[],labels:RenderedLabel[]=[],issues:Issue[]=[];
 let retry:Net|undefined;
 const settings=routingSettings(s.layout);
 const locked=s.layout.routes.filter(r=>r.locked&&r.sheet_id===sheet);
 const labelKey=(id:string,t:Terminal,peer?:number)=>JSON.stringify([id,terminalKey(t),peer===undefined?null:s.sheets[peer]?.id]);
 const manualLabels=new Map(s.layout.labels?.map(l=>[JSON.stringify([l.net_id,terminalKey(l),l.peerSheet??null]),l.position]));
 const sheetIndex=s.sheets.findIndex(sh=>sh.id===sheet);
 const routeId=(type:'route'|'label',net:Net,ordinal:number)=>{
  const base=`${type}_${sheetIndex}_${netIds.get(net)}_${ordinal}`;
  let id=base;for(let n=1;reserved.has(id);n++)id=`${base}_r${n}`;
  return id;
 };
  const bodies=sections.filter(a=>a.sheet_id===sheet);
  // Reservations for possible labels help auto placement, but are not ink.
  const physical=new Map(bodies.map(a=>[a,placedBounds({...a,label_padding:undefined})]));
  const padded=new Map(bodies.map(a=>{
   const b=placedBounds({...a,label_padding:undefined},CLEARANCE);
   return [a,{x:round(b.x),y:round(b.y),right:round(b.right),bottom:round(b.bottom)}];
  }));
  const bodyClearance=new Map(bodies.flatMap(a=>{const b=placedBodyBounds(a,settings.bodyClearance);return b?[[a,b] as const]:[];}));
  const base:Box[]=[...padded,...bodyClearance].map(([owner,bounds])=>({owner,bounds}));
  function pinExit(e:Endpoint){
   const p=exit(e,padded.get(e.placed)!),c=bodyClearance.get(e.placed);
   if(!c)return p;
   const d=pinDirection(e.placed,e.pin);
   if(d.x&&p.y>c.y&&p.y<c.bottom)p.x=d.x<0?Math.min(p.x,c.x):Math.max(p.x,c.right);
   if(d.y&&p.x>c.x&&p.x<c.right)p.y=d.y<0?Math.min(p.y,c.y):Math.max(p.y,c.bottom);
   return p;
  }
  base.push({bounds:stamp});
  // Leave an exit at pins of other nets, before their wires or label stubs
  // have been drawn. Otherwise an earlier route can fence a pin in.
  const portBoxes=s.nets.flatMap(net=>net.pins.flatMap(pin=>{
   const e=endpoints.get(terminalKey(pin));
   if(!e||e.placed.sheet_id!==sheet)return [];
   const d=pinDirection(e.placed,e.pin),{x,y}=e.point,xx=x+3*d.x,yy=y+3*d.y;
   return [{netId:net.id,bounds:{x:round(Math.min(x,xx)-1.25),right:round(Math.max(x,xx)+1.25),y:round(Math.min(y,yy)-1.25),bottom:round(Math.max(y,yy)+1.25)}}];
  }));
  const otherPorts=(net:Net)=>portBoxes.filter(b=>b.netId!==net.id);
  const labelBoxes:Bounds[]=[];
  const sheetRoutes=locked.slice();
  for(const r of locked){
   const ends=s.nets.find(n=>n.id===r.net_id)?.pins.map(pin=>endpoints.get(terminalKey(pin)))??[];
   const parts=segments(r.points);
   const hits=(owner:PlacedSection,box:Bounds)=>parts.some(([a,b])=>segmentHits(a,b,box)&&!ends.some(e=>{
    if(!e||e.placed!==owner)return false;
    const other=same(a,e.point)?b:same(b,e.point)?a:undefined;
    if(!other)return false;
    const d=pinDirection(owner,e.pin);
    return d.x?other.y===e.point.y&&(other.x-e.point.x)*d.x>0:other.x===e.point.x&&(other.y-e.point.y)*d.y>0;
   }));
   const blockedBy=bodies.find(owner=>hits(owner,physical.get(owner)!));
   if(blockedBy)issues.push({severity:'warning',code:'LOCKED_ROUTE_OBSTACLE',message:`Ручной маршрут ${r.id} проходит через ${blockedBy.instance.designator??blockedBy.instance.id}/${blockedBy.section.section_id}`});
   else{
    const close=[...bodyClearance].find(([owner,box])=>hits(owner,box));
    if(close)issues.push({severity:'warning',code:'LOCKED_ROUTE_CLEARANCE',message:`Ручной маршрут ${r.id} близко к корпусу ${close[0].instance.designator??close[0].instance.id}; требуется зазор`});
   }
  }
  const add=(r:WireRoute)=>{routes.push(r);sheetRoutes.push(r);};
  const treeByNet=new Map<string,Segment[]>();
  // A net spanning k sheets needs k-1 reciprocal links, not k copies
  // listing all destinations. Local names remain valid for disconnected stubs.
  const pending:{net:Net;end:Endpoint;peer?:number}[]=[];
  const scheduled=new Set<string>();
  const enqueue=(net:Net,end:Endpoint,peer?:number)=>{
   const key=JSON.stringify([net.id,terminalKey(end.terminal),peer]);
   if(!scheduled.has(key)){scheduled.add(key);pending.push({net,end,peer});}
  };
  const density=settings.wireDensity;
  const plans=(first?[first,...s.nets.filter(n=>n!==first)]:s.nets).flatMap(net=>{
   const ends=net.pins.map(p=>endpoints.get(terminalKey(p))).filter((e):e is Endpoint=>!!e);
   const local=ends.filter(e=>e.placed.sheet_id===sheet);
   if(!local.length)return [];
   const used=new Set(ends.map(e=>e.placed.sheet_id));
   const pages=s.sheets.flatMap((sh,i)=>used.has(sh.id)?[i]:[]),idx=pages.indexOf(sheetIndex);
   const peers=net.role==='ground'?[]:pages.slice(Math.max(0,idx-1),idx+2).filter(i=>i!==sheetIndex);
   const fixed=locked.filter(r=>r.net_id===net.id);
   // Wire preference considers local geometric span and local fan-out only.
   // A distant sheet is not a reason to split a compact circuit on this one.
   const xs=local.map(e=>e.point.x),ys=local.map(e=>e.point.y);
   const span=Math.max(...xs)-Math.min(...xs)+Math.max(...ys)-Math.min(...ys);
   const isLabel=net.render==='label'||net.render==='auto'&&(density===0||local.length>2+Math.floor(density*.12)||span>25+3.1*density);
   return [{net,local,peers,fixed,isLabel}];
  });
  const namedTrees=new Set<string>();
  if(contactsFirst){
   for(const {net,local,peers,isLabel,fixed} of plans)if(!fixed.length&&(isLabel||local.length===1)){
    for(const [i,peer] of peers.entries())enqueue(net,local[i%local.length],peer);
    for(const [i,e] of local.entries())if(i>=peers.length)enqueue(net,e);
   }
   placeLabels();
  }
  for(const {net,local,peers,fixed,isLabel} of plans){
   for(const [i,peer] of peers.entries())enqueue(net,local[i%local.length],peer);
   if(isLabel&&!fixed.length){
    for(const [i,e] of local.entries())if(i>=peers.length)enqueue(net,e);
    continue;
   }
   if(!peers.length&&(local.length===1||net.role==='ground'))enqueue(net,local[0]);
   if(fixed.length){
    const locked=fixed.flatMap(r=>segments(r.points));
    const reached=new Set<number>([0]);const visit=[0];
    while(visit.length){const j=visit.pop()!;for(let i=0;i<locked.length;i++)if(!reached.has(i)&&hit(...locked[i],...locked[j])){reached.add(i);visit.push(i);}}
    if(reached.size!==locked.length||local.some(e=>![...reached].some(i=>pointOnSegment(e.point,...locked[i]))))issues.push({severity:'error',code:'LOCKED_ROUTE_DISCONNECTED',message:`${net.id}: закреплённые провода не образуют связную цепь до всех выводов; исправьте маршрут или снимите фиксацию`});
    treeByNet.set(net.id,locked);
    continue;
   }
   if(local.length===1)continue;
   const foreign=occupied(sheetRoutes,net.id),obstacles=[...base,...otherPorts(net),...labelBoxes.map(bounds=>({bounds}))],blocked=collision(obstacles,foreign),guide=[...obstacles,...trackGuides(foreign)];
   const root=local[0],remaining=local.slice(1).map(end=>({end,nearest:root,distance:dist(root.point,end.point)})),tree:Segment[]=[];
   treeByNet.set(net.id,tree);
   const exits=new Map(local.map(e=>[e,pinExit(e)]));
   let serial=0;
   while(remaining.length){
    let bi=0;
    for(let j=1;j<remaining.length;j++)if(remaining[j].distance<remaining[bi].distance)bi=j;
    const {nearest:a,end:b}=remaining.splice(bi,1)[0],from=exits.get(b)!;
    let path:Point[]|undefined;
    if(!blocked(b.point,from,b.placed)&&!onForeign(b.point,foreign)){
     const heading=direction(b.point,from);
     if(tree.length){
      // Try projections as well as corners. The new branch terminates at the
      // first actual contact; it may not cross and then re-enter its own tree.
      const goals=new Map<string,Point>();
      for(const [p,q] of tree){
       const projection=p.x===q.x?{x:p.x,y:clamp(from.y,p.y,q.y)}:{x:clamp(from.x,p.x,q.x),y:p.y};
       for(const goal of [projection,p,q])if(!onForeign(goal,foreign))goals.set(`${goal.x},${goal.y}`,goal);
      }
      let best=Infinity;
      for(const goal of [...goals.values()].sort((p,q)=>dist(from,p)-dist(from,q)).slice(0,8)){
       if(dist(from,goal)>best)break;
       const middle=findPath(from,goal,guide,blocked,heading);
       if(!middle)continue;
       const candidate=stopAtTree(withoutLoops([b.point,...middle]),tree);
       const score=segments(candidate).reduce((n,[p,q])=>n+dist(p,q),0)+BEND_COST*Math.max(0,candidate.length-2)+shortJog(candidate)+(candidate.length>2&&dist(candidate.at(-2)!,candidate.at(-1)!)<1.25?5:0);
       if(score<best&&!onForeign(candidate.at(-1)!,foreign)){path=candidate;best=score;}
      }
     }else{
      const end=exits.get(a)!;
      if(!blocked(a.point,end,a.placed)&&!onForeign(a.point,foreign)){
       const middle=findPath(from,end,guide,blocked,heading,opposite(direction(a.point,end)));
       if(middle)path=withoutLoops([b.point,...middle,a.point]);
      }
     }
    }
    if(path){
     for(const item of remaining){const d=dist(item.end.point,b.point);if(d<item.distance){item.distance=d;item.nearest=b;}}
     if(path.length>1){
      const points=tree.length?path:path.slice().reverse();
      add({id:routeId('route',net,serial++),net_id:net.id,sheet_id:sheet,points});
      tree.push(...segments(points));
     }
    }else if(net.render==='auto'){
     retry??=net;
     enqueue(net,a);enqueue(net,b);
     issues.push({severity:'warning',code:'AUTO_LABEL_FALLBACK',message:`${net.name||net.id}: для непроходимой ветви использованы именованные метки`});
    }else{
     retry??=net;
     issues.push({severity:'error',code:'UNROUTED',message:`${net.name||net.id}: не удалось провести ${a.terminal.instance_id}.${a.pin.number} — ${b.terminal.instance_id}.${b.pin.number} на листе ${s.sheets.findIndex(sh=>sh.id===sheet)+1}; задайте ручной маршрут или режим меток`});
    }
   }
  }

  // Route wires before placing automatic labels. Label anchors and their leads
  // are tried in deterministic order; explicit user positions are untouched.
  function placeLabels(){
  pending.sort((a,b)=>Number(manualLabels.has(labelKey(b.net.id,b.end.terminal,b.peer)))-Number(manualLabels.has(labelKey(a.net.id,a.end.terminal,a.peer))));

  for(const {net,end:e,peer} of pending){
   const dir=pinDirection(e.placed,e.pin),ground=net.role==='ground';
   const text=ground?'':(net.name||net.id)+(peer!==undefined?` (л.${peer+1})`:'');
   const textBoxes={left:labelBounds(text,{x:0,y:0},true),right:labelBounds(text,{x:0,y:0},false)};
   const pinKey=labelKey(net.id,e.terminal,peer);
   const manual=manualLabels.get(pinKey);
   const lead=pinExit(e),heading=direction(e.point,lead);
   const foreign=occupied(sheetRoutes,net.id),allSegments=sheetRoutes.flatMap(r=>segments(r.points));
   const original=treeByNet.get(net.id)??[];
   // Separate ground stubs are already electrically named. Keep their ink
   // disjoint, so two earth symbols cannot grow onto the same drawn island.
   const tree=ground?sheetRoutes.filter(r=>r.net_id===net.id).flatMap(r=>segments(r.points)):original;
   if(ground&&!original.some(([a,b])=>pointOnSegment(e.point,a,b))&&tree.some(([a,b])=>pointOnSegment(e.point,a,b)))continue;
   const attached=tree.some(([a,b])=>pointOnSegment(e.point,a,b));
   if(peer===undefined&&attached&&namedTrees.has(net.id))continue;
   const boxes=[...base,...otherPorts(net),...labelBoxes.map(bounds=>({bounds}))],conflicts=collision(boxes,foreign);
   // A short branch to a nearby already-drawn ground is more legible
   // than parallel stubs each terminating in a separate earth symbol.
   if(ground&&!manual&&!attached&&tree.length&&!conflicts(e.point,lead,e.placed)){
    const goals=tree.map(([a,b])=>a.x===b.x?{x:a.x,y:clamp(lead.y,a.y,b.y)}:{x:clamp(lead.x,a.x,b.x),y:a.y})
     .filter(g=>dist(lead,g)<=18&&!onForeign(g,foreign)).sort((a,b)=>dist(lead,a)-dist(lead,b));
    let branch:Point[]|undefined,best=Infinity;
    for(const goal of goals.slice(0,6)){
     const middle=findPath(lead,goal,boxes,conflicts,heading,undefined,false);
     if(!middle)continue;
     const path=stopAtTree(withoutLoops([e.point,...middle]),tree);
     const cost=segments(path).reduce((sum,[a,b])=>sum+dist(a,b),0)+4*(path.length-2);
     if(path.length>=2&&cost<best&&cost<=20){branch=path;best=cost;}
    }
    if(branch){add({id:routeId('label',net,net.pins.findIndex(pin=>terminalKey(pin)===terminalKey(e.terminal))),net_id:net.id,sheet_id:sheet,points:branch});continue;}
   }
   const blocked:Blocked=(a,b,owner)=>conflicts(a,b,owner)||(!attached&&tree.some(([c,d])=>hit(a,b,c,d)!==undefined));
   type Approach=NonNullable<RenderedLabel['approach']>;
   type Candidate={point:Point;tail:Point;approach:Approach;alignLeft:boolean;mark:Bounds;text:Bounds;dir:number};
   const candidates:Candidate[]=[],seen=new Set<string>();
   const blockedAreas=[...physical.values(),...labelBoxes,stamp];
   function offer(p:Point,approach:Approach,alignLeft=approach==='left'){
    const point={x:round(p.x),y:round(p.y)},key=`${point.x},${point.y},${approach},${alignLeft}`;
    if(seen.has(key)||!inFrame(point))return;seen.add(key);
    const {x,y}=point,b=textBoxes[alignLeft?'left':'right'];
    const text={x:x+b.x,right:x+b.right,y:y+b.y,bottom:y+b.bottom};
    // Reserve the visible symbol and the editor's hit circle.
    const directionIndex=['right','down','left','up'].indexOf(approach),axis=dirs[directionIndex];
    const mark=ground?{x:x-4,right:x+4,y:y-1.6,bottom:y+5.8}:{
     x:x-1.6-Math.max(0,axis.x),right:x+1.6-Math.min(0,axis.x),
     y:y-1.6-Math.max(0,axis.y),bottom:y+1.6-Math.min(0,axis.y)
    };
    if((ground?[mark]:[text,mark]).some(b=>b.x<20||b.right>415||b.y<5||b.bottom>292||
     blockedAreas.some(o=>intersects(b,o,.25))||allSegments.some(([a,c])=>segmentHits(a,c,b))))return;
    const tail={x:round(x-axis.x*LABEL_LEAD),y:round(y-axis.y*LABEL_LEAD)};
    if(blocked(tail,point))return;
    candidates.push({point,tail,approach,alignLeft,mark,text:ground?mark:text,dir:directionIndex});
   }
   const headings:Approach[]=['right','down','left','up'];
   if(manual){
    if(ground)offer(manual,'down',dir.x<0);
    else for(const h of [heading,(heading+1)%4,(heading+3)%4,opposite(heading)])offer(manual,headings[h]);
   }else if(ground){
    for(const below of [LABEL_LEAD,6,8.75,12.5,17.5,25,35,45])for(const shift of [0,3,-3,6,-6,10,-10,15,-15,22.5,-22.5,30,-30]){
     const x=dir.x?lead.x+dir.x*6+shift:lead.x+shift;
     const y=Math.max(lead.y+below,e.point.y+below);
     offer({x,y},'down',dir.x<0);
     if(!dir.x)offer({x,y},'down',true);
    }
   }else{
    // Probe the straight escape first; then fan out along its tangent.
    // Also try a perpendicular arrow beyond a short pin stub, instead of
    // dragging a horizontal arrow around the case when its caption won't fit.
    for(const n of [LABEL_LEAD,6,8.75,13.75,22.5,35,50]){
     for(const shift of [0,-5,5,-10,10,-17.5,17.5,-30,30]){
      const x=lead.x+dir.x*n-dir.y*shift,y=lead.y+dir.y*n+dir.x*shift;
      offer({x,y},headings[heading]);
      if(dir.y)offer({x,y},headings[heading],true);
      for(const k of [(heading+1)%4,(heading+3)%4])offer({x:x+dirs[k].x*LABEL_LEAD,y:y+dirs[k].y*LABEL_LEAD},headings[k]);
     }
    }
    for(const n of [8.75,17.5,30,50])for(const shift of [-10,10,-22.5,22.5,0])
     offer({x:lead.x-dir.x*n-dir.y*shift,y:lead.y-dir.y*n+dir.x*shift},headings[opposite(heading)]);
   }
   let choice:Candidate|undefined,points:Point[]=[],bestScore=Infinity;
   if(!onForeign(e.point,foreign)&&!blocked(e.point,lead,e.placed)){
    const wrongSide=(c:Candidate)=>!ground&&(c.point.x-e.point.x)*dir.x+(c.point.y-e.point.y)*dir.y<0;
    const sidePenalty=(c:Candidate)=>(wrongSide(c)?24:0)+(!ground&&c.dir!==heading?5:0);
    const score=(c:Candidate)=>dist(lead,c.tail)+sidePenalty(c);
    candidates.sort((a,b)=>score(a)-score(b));
    function tryPath(c:Candidate,search:boolean){
     const avoidLabel:Blocked=(a,b)=>blocked(a,b)||segmentHits(a,b,c.text)||segmentHits(a,b,c.mark);
     const middle=findPath(lead,c.tail,search?[...boxes,...trackGuides(foreign),{bounds:c.text},{bounds:c.mark}]:boxes,avoidLabel,heading,c.dir,search);
     if(!middle)return;
     let path=withoutLoops([e.point,...middle,c.point]);
     if(attached)path=stopAtTree(path.slice().reverse(),tree).reverse();
     const a=path.at(-2),b=path.at(-1);
     if(!a||!b||!same(b,c.point)||direction(a,b)!==c.dir||dist(a,b)<LABEL_LEAD-.001)return;
     const cost=segments(path).reduce((sum,[a,b])=>sum+dist(a,b),0)+8*Math.max(0,path.length-2)+shortJog(path)+sidePenalty(c);
     if(cost<bestScore){choice=c;points=path;bestScore=cost;}
    }
    let valid=0;
    for(const c of candidates){
     if(choice&&!attached&&score(c)+LABEL_LEAD>bestScore)break;
     const previous=bestScore;tryPath(c,false);
     if(previous!==bestScore)valid++;
     if(valid>=6)break;
    }
    if(!choice)for(const c of candidates.slice(0,10)){tryPath(c,true);if(choice)break;}
   }
   if(!choice){
    issues.push({severity:'error',code:'LABEL_CROWDED',message:`${net.name||net.id}, ${e.terminal.instance_id}.${e.pin.number}: не удалось подключить обозначение; раздвиньте элементы`});
    continue;
   }
   if(attached)namedTrees.add(net.id);
   labels.push({net_id:net.id,sheet_id:sheet,point:choice.point,text,role:net.role,pin:e.terminal,continuation:peer!==undefined,...(peer!==undefined?{peerSheet:s.sheets[peer].id}:{}),approach:choice.approach,alignLeft:choice.alignLeft});
   if(!ground)labelBoxes.push(choice.text);
   labelBoxes.push(choice.mark);
   if(points.length>1)add({id:routeId('label',net,net.pins.findIndex(pin=>terminalKey(pin)===terminalKey(e.terminal))+(peer!==undefined?(peer+1)*net.pins.length:0)),net_id:net.id,sheet_id:sheet,points});
  }
  pending.length=0;
  }
  placeLabels();
  for(let i=0;i<sheetRoutes.length;i++)for(let j=i+1;j<sheetRoutes.length;j++){
   const a=sheetRoutes[i],b=sheetRoutes[j];if(a.net_id===b.net_id)continue;
   const as=segments(a.points),bs=segments(b.points);
   const conflict=as.some(([p,q])=>bs.some(([u,v])=>overlap(p,q,u,v)))||
    [a.points[0],a.points.at(-1)!].some(p=>bs.some(([u,v])=>pointOnSegment(p,u,v)))||
    [b.points[0],b.points.at(-1)!].some(p=>as.some(([u,v])=>pointOnSegment(p,u,v)));
   if(conflict)issues.push({severity:'warning',code:'AMBIGUOUS_CROSSING',message:`Лист ${sheet}: неоднозначное касание цепей ${a.net_id} и ${b.net_id}; электрически они не соединены`});
   else if((a.locked||b.locked)&&as.some(([p,q])=>bs.some(([u,v])=>parallelTooClose(p,q,u,v))))issues.push({severity:'warning',code:'WIRE_SPACING',message:`Лист ${sheet}: между параллельными участками ${a.net_id} и ${b.net_id} меньше 3 мм`});
  }
 return {routes,labels,issues,retry};
}

export function routeSheetBatch(s:Schematic,sections:PlacedSection[],sheetIds:readonly string[],memo?:SheetRouteMemo):RoutedSheets{
 const endpoints=terminalGraph(sections),netIds=new Map(s.nets.map((net,i)=>[net,i]));
 const reserved=new Set(s.layout.routes.filter(r=>r.locked).map(r=>r.id));
 const batches=sheetIds.map(sheet=>{
  const calculate=()=>{
   let best=routeOneSheet(s,sections,sheet,endpoints,netIds,reserved);
   // One bounded rip-up attempt on small projects: give a blocked net first
   // choice of corridors, keep the reroute only if it improves diagnostics.
   if(best.issues.some(i=>i.severity==='error')||best.retry&&s.nets.length<=80&&s.components.length<=80){
    const other=routeOneSheet(s,sections,sheet,endpoints,netIds,reserved,best.retry,true);
    const rank=(r:RoutedSheets)=>r.issues.filter(i=>i.severity==='error').length*1e6+r.issues.length;
    if(rank(other)<rank(best))best=other;
   }
   const {routes,labels,issues}=best;return {routes,labels,issues:issues.map(issue=>({...issue,path:issue.path??'sheets.'+sheet}))};
  };
  return memo?memo(sheet,calculate):calculate();
 });
 return {routes:batches.flatMap(r=>r.routes),labels:batches.flatMap(r=>r.labels),issues:batches.flatMap(r=>r.issues)};
}

export function mergeRoutedSheets(s:Schematic,batches:readonly RoutedSheets[]):RoutedSheets{
 const routes=[...s.layout.routes.filter(r=>r.locked).map(r=>structuredClone(r)),...batches.flatMap(b=>b.routes)];
 const issues=batches.flatMap(b=>b.issues);
 for(const r of routes)if(r.points.some(p=>p.x<20||p.x>415||p.y<5||p.y>292))issues.push({severity:'warning',code:'ROUTE_OUT_OF_BOUNDS',message:`Маршрут ${r.id} выходит за рамку А3`});
 return {routes,labels:batches.flatMap(b=>b.labels),issues};
}

export function routeSchematic(s:Schematic,sections:PlacedSection[]):RoutedSheets{
 return mergeRoutedSheets(s,[routeSheetBatch(s,sections,s.sheets.map(sh=>sh.id))]);
}
