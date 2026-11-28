import {betterQuality,measureQuality} from './quality.js';
import {continuationPairs,PARALLEL_WIRE_SPACING} from './connections.js';
import {contactPoints,parallelGap,physicalPinKey} from './conductors.js';
import type {Schematic,PlacedSection,WireRoute,Point,Issue,RenderedLabel,Terminal,Pin,Net} from './types.js';
import {routingLimits,routingSettings} from './types.js';
import {PAGE,WIRING_STAMP,placedBodyBounds,pinPosition,pinDirection,intersects,simplify,same,pointOnSegment,round,printedTextBounds,segmentHitsBounds as segmentHits,drawingTextBounds,type Bounds} from './geometry.js';


type Endpoint={point:Point;placed:PlacedSection;pin:Pin;terminal:Terminal};
type Segment=[Point,Point];
type Box={owner?:PlacedSection;bounds:Bounds};
const STEP=PAGE.grid;
export const BODY_CLEARANCE=routingLimits.bodyClearance.default;
const LABEL_LEAD=2.4;
export {PARALLEL_WIRE_SPACING};
const BEND_COST=6;
const MIN_X=21, MAX_X=414, MIN_Y=6, MAX_Y=291;
const stamp=WIRING_STAMP;
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

function hit(a:Point,b:Point,c:Point,d:Point):Point|undefined{
 return contactPoints(a,b,c,d).sort((p,q)=>dist(a,p)-dist(a,q))[0];
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
 return (parallelGap(a,b,c,d)??Infinity)<PARALLEL_WIRE_SPACING-.001;
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
  for(const p of wire.points){addToMap(result.ends,'x'+p.x,p);addToMap(result.ends,'y'+p.y,p);}
 }
 return result;
}

type Blocked=((a:Point,b:Point,owner?:PlacedSection)=>boolean)&{turn?:(p:Point)=>boolean;crossingCost?:(path:Point[])=>number};
function collision(boxes:Box[],foreign:Occupancy):Blocked{
 const blocked:Blocked=(a,b,owner)=>{
  if(!inFrame(a)||!inFrame(b)||boxes.some(o=>(!owner||o.owner!==owner)&&segmentHits(a,b,o.bounds)))return true;
  if(same(a,b))return false;
  const axis=a.x===b.x?'x':'y',at=axis==='x'?a.x:a.y,k=bucket(at);
  for(let i=k-1;i<=k+1;i++)if(foreign.tracks.get(axis+i)?.some(([c,d])=>parallelTooClose(a,b,c,d)))return true;
  return !!foreign.ends.get(axis+at)?.some(p=>pointOnSegment(p,a,b));
 };
 blocked.turn=p=>onForeign(p,foreign);
 blocked.crossingCost=path=>segments(path).reduce((cost,[a,b])=>cost+foreign.segments.filter(([c,d])=>(a.x===b.x)!==(c.x===d.x)&&hit(a,b,c,d)).length*4,0);
 return blocked;
}
const onForeign=(p:Point,foreign:Occupancy)=>foreign.segments.some(([a,b])=>pointOnSegment(p,a,b));

// Try low-bend Manhattan paths first. Exact pin ordinates and obstacle edges are
// retained in the fallback search, so just snapping cannot create a staircase.
function findPath(start:Point,end:Point,boxes:Box[],blocked:Blocked,from:number,to?:number,search=true,onBudget?:()=>void):Point[]|undefined{
 if(!inFrame(start)||!inFrame(end))return;
 if(same(start,end))return to===opposite(from)?undefined:[start];
 const bend=(a:number,b:number)=>a===b?0:BEND_COST;
 const score=(path:Point[])=>{let cost=shortJog(path)+(blocked.crossingCost?.(path)??0),last=from;for(const [a,b]of segments(path)){const next=direction(a,b);if(next===opposite(last)||next!==last&&blocked.turn?.(a)||blocked(a,b))return Infinity;cost+=dist(a,b)+bend(last,next);last=next;}return to===undefined?cost:to===opposite(last)?Infinity:cost+bend(last,to);};
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
   if(k===opposite(heading)||k!==heading&&blocked.turn?.(p))continue;
   const nx=x+dirs[k].x,ny=y+dirs[k].y;if(nx<0||nx>=w||ny<0||ny>=h)continue;
   const j=id(nx,ny,k);if(closed[j])continue;
   const q={x:xs[nx],y:ys[ny]},grow=cost[i]+dist(p,q)+bend(heading,k),estimate=grow+dist(q,end);
   if(grow+.0001>=cost[j]||estimate>=bestCost||blocked(p,q))continue;
   cost[j]=grow;parent[j]=i;heap.push({id:j,score:estimate});
  }
 }
 if(visited===60000&&heap.length&&!best)onBudget?.();
 return best;
}

export function labelBounds(text:string,point:Point,left:boolean,shift=0):Bounds{
 const b=drawingTextBounds(text,point.x+(left?-1:1),point.y-1.5+shift,3.5,left?'right':'left');
 return {x:b.x-.15,right:b.right+.15,y:b.y-.15,bottom:b.bottom+.15};
}

export function labelMarkBounds(point:Point,approach:NonNullable<RenderedLabel['approach']>,ground:boolean):Bounds{
 const {x,y}=point;
 if(ground)return {x:x-3.7,right:x+3.7,y:y-.2,bottom:y+3.95};
 const {x:dx,y:dy}=dirs[['right','down','left','up'].indexOf(approach)];
 return {
  x:x-2*Math.max(0,dx)-1.25*Math.abs(dy)-.2,right:x-2*Math.min(0,dx)+1.25*Math.abs(dy)+.2,
  y:y-2*Math.max(0,dy)-1.25*Math.abs(dx)-.2,bottom:y-2*Math.min(0,dy)+1.25*Math.abs(dx)+.2
 };
}

function terminalGraph(sections:PlacedSection[]){
 const map=new Map<string,Endpoint>();
 for(const placed of sections)for(const pin of placed.section.pins)map.set(physicalPinKey(placed.instance.id,pin.number),{point:pinPosition(placed,pin),placed,pin,terminal:{instance_id:placed.instance.id,number:pin.number}});
 return map;
}
const terminalKey=(t:Terminal)=>physicalPinKey(t.instance_id,t.number);

export type RoutedSheets={routes:WireRoute[];labels:RenderedLabel[];issues:Issue[]};
export type SheetRouteMemo=(id:string,calculate:()=>RoutedSheets)=>RoutedSheets;

function routeOneSheet(s:Schematic,sections:PlacedSection[],sheet:string,endpoints:Map<string,Endpoint>,netIds:Map<Net,number>,reserved:Set<string>,pairs:ReturnType<typeof continuationPairs>,first?:Net,contactsFirst=false,priorityPins:ReadonlySet<string>=new Set()):RoutedSheets&{retry?:Net}{
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
  const bodyClearance=new Map(bodies.flatMap(a=>{const b=placedBodyBounds(a,settings.bodyClearance);return b?[[a,b] as const]:[];}));
  const base:Box[]=[...bodyClearance].map(([owner,bounds])=>({owner,bounds}));
  for(const a of bodies)for(const bounds of printedTextBounds(a))base.push({bounds});
  function pinExit(e:Endpoint){
   const c=bodyClearance.get(e.placed),d=pinDirection(e.placed,e.pin),{x,y}=e.point;
   let lead=.75;
   if(c&&d.x&&y>c.y&&y<c.bottom)lead=Math.max(lead,d.x>0?c.right-x:x-c.x);
   if(c&&d.y&&x>c.x&&x<c.right)lead=Math.max(lead,d.y>0?c.bottom-y:y-c.y);
   return {x:round(x+d.x*lead),y:round(y+d.y*lead)};
  }
  base.push({bounds:stamp});
  const assignedNet=new Map(s.nets.flatMap(net=>net.pins.map(pin=>[terminalKey(pin),net.id] as const)));
  const portBoxes=bodies.flatMap(placed=>placed.section.pins.map(pin=>{
   const terminal={instance_id:placed.instance.id,number:pin.number},id=terminalKey(terminal),point=pinPosition(placed,pin);
   const d=pinDirection(placed,pin),{x,y}=point;
   const start=assignedNet.has(id)?1.25:.25;
   const denseVertical=d.y!==0&&placed.section.pins.filter(other=>{
    const pointing=pinDirection(placed,other);
    return pointing.y===d.y&&assignedNet.has(physicalPinKey(placed.instance.id,other.number));
   }).length>=4;
   const far=assignedNet.has(id)?denseVertical?10:3:.25;
   const xx=x+d.x*far,yy=y+d.y*far,ax=x-d.x*(pin.length??5),ay=y-d.y*(pin.length??5);
   const bounds={x:round(Math.min(x,xx,ax)-start),right:round(Math.max(x,xx,ax)+start),y:round(Math.min(y,yy,ay)-start),bottom:round(Math.max(y,yy,ay)+start)};
   const lead={x:Math.min(x,ax,x+d.x*3)-.8,right:Math.max(x,ax,x+d.x*3)+.8,
    y:Math.min(y,ay,y+d.y*3)-.8,bottom:Math.max(y,ay,y+d.y*3)+.8};
   return {netId:assignedNet.get(id),id,bounds,lead};
  }));
  const otherPorts=(net:Net)=>portBoxes.filter(b=>b.netId!==net.id);
  const labelBoxes:Bounds[]=[];
  const sheetRoutes=locked.slice();
  const add=(r:WireRoute)=>{routes.push(r);sheetRoutes.push(r);};
  // A net spanning k sheets needs k-1 reciprocal links, not k copies
  // listing all destinations. Local names remain valid for disconnected stubs.
  const pending:{net:Net;end:Endpoint;peer?:number}[]=[];
  const scheduled=new Set<string>();
  const enqueue=(net:Net,end:Endpoint,peer?:number)=>{
   const key=JSON.stringify([net.id,terminalKey(end.terminal),peer]);
   if(!scheduled.has(key)){scheduled.add(key);pending.push({net,end,peer});}
  };
  function portAnchor(net:Net,local:Endpoint[],index:number,peer:number){
   return local.find(e=>manualLabels.has(labelKey(net.id,e.terminal,peer)))??local[index%local.length];
  }
  const density=settings.wireDensity;
  const plans=(first?[first,...s.nets.filter(n=>n!==first)]:s.nets).flatMap(net=>{
   const ends=net.pins.map(p=>endpoints.get(terminalKey(p))).filter((e):e is Endpoint=>!!e);
   const local=ends.filter(e=>e.placed.sheet_id===sheet);
   if(!local.length)return [];
   const peers=pairs.flatMap(pair=>pair.net!==net.id?[]:pair.from===sheet?[s.sheets.findIndex(sh=>sh.id===pair.to)]:pair.to===sheet?[s.sheets.findIndex(sh=>sh.id===pair.from)]:[]);
   const fixed=locked.filter(r=>r.net_id===net.id);
   // Wire preference considers local geometric span and local fan-out only.
   // A distant sheet is not a reason to split a compact circuit on this one.
   const isLabel=net.render==='label'||net.render==='auto'&&density===0;
   return [{net,local,peers,fixed,isLabel}];
  });

  function wireGroups(local:Endpoint[],net:Net){
   if(net.render!=='auto')return [local];
   const remaining=new Set(local),groups:Endpoint[][]=[];
   const limit=6+density*2.1;
   while(remaining.size){
    const start=remaining.values().next().value!;
    remaining.delete(start);
    const group=[start];groups.push(group);
    for(const a of group)for(const b of remaining){
     const dx=b.point.x-a.point.x,dy=b.point.y-a.point.y;
     const u=pinDirection(a.placed,a.pin),v=pinDirection(b.placed,b.pin);
     const estimate=dist(a.point,b.point)+8*Number(dx!==0&&dy!==0)+12*Number(u.x*dx+u.y*dy<0)+12*Number(v.x*dx+v.y*dy>0);
     if(estimate<=limit){remaining.delete(b);group.push(b);}
    }
   }
   return groups;
  }
  if(contactsFirst){
   for(const {net,local,peers,isLabel,fixed} of plans)if(!fixed.length&&(isLabel||local.length===1)){
    for(const [i,peer] of peers.entries())enqueue(net,portAnchor(net,local,i,peer),peer);
    for(const e of local)if(!peers.some((peer,i)=>portAnchor(net,local,i,peer)===e))enqueue(net,e);
   }
   placeLabels();
  }
  for(const {net,local,peers,fixed,isLabel} of plans){
   for(const [i,peer] of peers.entries())enqueue(net,portAnchor(net,local,i,peer),peer);
   if(isLabel&&!fixed.length){
    for(const e of local)if(!peers.some((peer,i)=>portAnchor(net,local,i,peer)===e))enqueue(net,e);
    continue;
   }
   if(!peers.length&&(local.length===1||net.role==='ground'))enqueue(net,local[0]);
   if(!fixed.length&&local.length===1)continue;
   const foreign=occupied(sheetRoutes,net.id);
   const obstacles:Box[]=[...base,...otherPorts(net),...labelBoxes.map(bounds=>({bounds}))];
   const blocked=collision(obstacles,foreign),guide=[...obstacles,...trackGuides(foreign)];
   function toTree(start:Point,lead:Point,heading:number,tree:Segment[],search=true){
    const goals=new Map<string,Point>();
    for(const [a,b] of tree){
     const p=a.x===b.x?{x:a.x,y:clamp(lead.y,a.y,b.y)}:{x:clamp(lead.x,a.x,b.x),y:a.y};
     for(const goal of [p,a,b])if(!onForeign(goal,foreign))goals.set(`${goal.x},${goal.y}`,goal);
    }
    let best:Point[]|undefined,cost=Infinity;
    const ordered=[...goals.values()].sort((a,b)=>dist(lead,a)-dist(lead,b)).slice(0,8);
    for(const goal of ordered){
     if(dist(lead,goal)>cost)break;
     const middle=findPath(lead,goal,guide,blocked,heading,undefined,false);
     if(!middle)continue;
     const path=stopAtTree(withoutLoops([start,...middle]),tree);
     const score=segments(path).reduce((n,[a,b])=>n+dist(a,b),0)+BEND_COST*Math.max(0,path.length-2)+shortJog(path);
     if(score<cost&&!onForeign(path.at(-1)!,foreign)){best=path;cost=score;}
    }
    if(best||!search)return best;
    for(const goal of ordered.slice(0,4)){
     const middle=findPath(lead,goal,guide,blocked,heading);
     if(!middle)continue;
     const path=stopAtTree(withoutLoops([start,...middle]),tree);
     if(!onForeign(path.at(-1)!,foreign))return path;
    }
   }
   if(fixed.length){
    const pendingSegments=new Set(fixed.flatMap(w=>segments(w.points)));
    const seed=[...pendingSegments].find(part=>local.some(e=>pointOnSegment(e.point,...part)));
    const tree:Segment[]=[];
    function grow(first:Segment){
     pendingSegments.delete(first);tree.push(first);
     for(const part of tree)for(const other of pendingSegments)if(hit(...part,...other)){
      pendingSegments.delete(other);tree.push(other);
     }
    }
    const record=(points:Point[],ordinal:number)=>{
     if(points.length<2)return;
     add({id:routeId('route',net,ordinal),net_id:net.id,sheet_id:sheet,points});
     tree.push(...segments(points));
    };
    let serial=0;
    if(seed){
     grow(seed);
     for(const part of pendingSegments){
      let joined=false;
      for(const point of part){
       for(const heading of [0,1,2,3]){
        const path=toTree(point,point,heading,tree,false);
        if(!path||path.length<2)continue;
        record(path,serial++);grow(part);joined=true;break;
       }
       if(joined)break;
      }
     }
     for(const e of local){
      if(tree.some(part=>pointOnSegment(e.point,...part)))continue;
      const lead=pinExit(e);
      if(blocked(e.point,lead,e.placed)||onForeign(e.point,foreign))continue;
      const branch=toTree(e.point,lead,direction(e.point,lead),tree);
      if(branch)record(branch,serial++);
     }
    }
    const missing=local.filter(e=>!tree.some(part=>pointOnSegment(e.point,...part)));
    if(pendingSegments.size||missing.length)issues.push({
     severity:'error',code:'LOCKED_ROUTE_DISCONNECTED',sheet_id:sheet,net_id:net.id,point:missing[0]?.point,
     pins:missing.map(e=>e.terminal),obstacle:fixed[0].id,reason:'LOCKED_ROUTE_DISCONNECTED',message:`${net.id}: закреплённые провода не образуют связную цепь до всех выводов`
    });
    continue;
   }
   const groups=wireGroups(local,net);
   let serial=0;
   for(const group of groups){
   const root=group[0],remaining=group.slice(1).map(end=>({end,nearest:root,distance:dist(root.point,end.point)})),tree:Segment[]=[];
   if(groups.length>1&&!pending.some(p=>p.net===net&&group.includes(p.end)))enqueue(net,root);
   const exits=new Map(local.map(e=>[e,pinExit(e)]));
   while(remaining.length){
    let bi=0;
    for(let j=1;j<remaining.length;j++)if(remaining[j].distance<remaining[bi].distance)bi=j;
    const {nearest:a,end:b}=remaining.splice(bi,1)[0],from=exits.get(b)!;
    let path:Point[]|undefined;
    if(!blocked(b.point,from,b.placed)&&!onForeign(b.point,foreign)){
     const heading=direction(b.point,from);
     if(tree.length){
      path=toTree(b.point,from,heading,tree);
     }else{
      const end=exits.get(a)!;
      if(!blocked(a.point,end,a.placed)&&!onForeign(a.point,foreign)){
       const middle=findPath(from,end,guide,blocked,heading,opposite(direction(a.point,end)));
       if(middle)path=withoutLoops([b.point,...middle,a.point]);
      }
     }
    }
    if(path&&net.render==='auto'){
     const travel=segments(path).reduce((total,[p,q])=>total+dist(p,q),0);
     const excess=travel-dist(path[0],path.at(-1)!);
     if(travel+8*Math.max(0,path.length-2)+excess*.4>28+density*2.8){
      enqueue(net,a);enqueue(net,b);
      continue;
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
     const exitBlocked=blocked(b.point,from,b.placed)||onForeign(b.point,foreign);
     const obstacle=obstacles.find(o=>o.owner&&o.owner!==b.placed&&segmentHits(b.point,from,o.bounds));
     issues.push({severity:'error',code:'UNROUTED',sheet_id:sheet,net_id:net.id,point:b.point,pins:[a.terminal,b.terminal],
      reason:exitBlocked?'PIN_EXIT':'CHANNEL',obstacle:obstacle?.owner?.key,
      message:`${net.name||net.id}: ${exitBlocked?'заблокирован выход из вывода':'нет свободного канала'} между ${a.terminal.instance_id}.${a.pin.number} и ${b.terminal.instance_id}.${b.pin.number}`});
    }
   }
   }
  }

  // Route wires before placing automatic labels. Label anchors and their leads
  // are tried in deterministic order; explicit user positions are untouched.
  function placeLabels(){
  const sideSpace=({net,end:e,peer}:typeof pending[number])=>{
   const d=pinDirection(e.placed,e.pin),p=pinExit(e),text=(net.name||net.id)+(peer!==undefined?` (л.${peer+1})`:'');
   if(manualLabels.has(labelKey(net.id,e.terminal,peer)))return -100;
   if(priorityPins.has(terminalKey(e.terminal)))return -10;
   if(net.role==='ground')return 10;
   let options=0;
   for(const gap of [3,8,14,23,33])for(const left of [false,true]){
    const q={x:p.x+d.x*gap,y:p.y+d.y*gap};
    const box=labelBounds(text,q,left,.6);
    if(inFrame(q)&&box.x>=20&&box.right<=415&&box.y>=5&&box.bottom<=292&&!base.some(o=>intersects(box,o.bounds)))options++;
   }
   return options;
  };
  const priorities=new Map(pending.map(job=>{
   const d=pinDirection(job.end.placed,job.end.pin),text=job.net.name||job.net.id;
   const width=labelBounds(text,{x:0,y:0},false).right;
   return [job,{freedom:sideSpace(job),vertical:d.y!==0,width}];
  }));
  pending.sort((a,b)=>{
   const p=priorities.get(a)!,q=priorities.get(b)!;
   return p.freedom-q.freedom||Number(b.peer!==undefined)-Number(a.peer!==undefined)||
    (p.vertical&&q.vertical?p.width-q.width:0);
  });
  function place({net,end:e,peer}:typeof pending[number]):Issue|undefined{
   const dir=pinDirection(e.placed,e.pin),ground=net.role==='ground';
   const text=ground?'':(net.name||net.id)+(peer!==undefined?` (л.${peer+1})`:'');
   const textBoxes={left:labelBounds(text,{x:0,y:0},true),right:labelBounds(text,{x:0,y:0},false)};
   const pinKey=labelKey(net.id,e.terminal,peer);
   const manual=manualLabels.get(pinKey);
   const lead=pinExit(e),heading=direction(e.point,lead);
   const foreign=occupied(sheetRoutes,net.id),allSegments=sheetRoutes.flatMap(r=>segments(r.points));
   // Separate ground stubs are already electrically named. Keep their ink
   // disjoint, so two earth symbols cannot grow onto the same drawn island.
   const allTree=sheetRoutes.filter(r=>r.net_id===net.id).flatMap(r=>segments(r.points));
   const connected=new Set(allTree.filter(([a,b])=>pointOnSegment(e.point,a,b)));
   for(const segment of connected)for(const other of allTree)if(!connected.has(other)&&hit(...segment,...other))connected.add(other);
   const tree=connected.size?[...connected]:allTree;
   const attached=connected.size>0;
   if(peer===undefined&&!manual&&attached&&labels.some(l=>l.net_id===net.id&&tree.some(([a,b])=>pointOnSegment(l.point,a,b))))return;
   const boxes:Box[]=[...base,...otherPorts(net),...labelBoxes.map(bounds=>({bounds}))],conflicts=collision(boxes,foreign);
   // A short branch to a nearby already-drawn ground is more legible
   // than parallel stubs each terminating in a separate earth symbol.
   if(ground&&!manual&&!attached&&tree.length&&labels.some(l=>l.net_id===net.id)&&!conflicts(e.point,lead,e.placed)){
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
    if(branch){
     const goal=branch.at(-1)!;
     const island=new Set(tree.filter(([a,b])=>pointOnSegment(goal,a,b)));
     for(const segment of island)for(const other of tree)if(!island.has(other)&&hit(...segment,...other))island.add(other);
     if(labels.some(l=>l.net_id===net.id&&[...island].some(([a,b])=>pointOnSegment(l.point,a,b)))){
      add({id:routeId('label',net,net.pins.findIndex(pin=>terminalKey(pin)===terminalKey(e.terminal))),net_id:net.id,sheet_id:sheet,points:branch});return;
     }
    }
   }
   const blocked:Blocked=(a,b,owner)=>conflicts(a,b,owner)||(!attached&&tree.some(([c,d])=>hit(a,b,c,d)!==undefined));
   blocked.turn=conflicts.turn;
   blocked.crossingCost=conflicts.crossingCost;
   type Approach=NonNullable<RenderedLabel['approach']>;
   type Candidate={point:Point;tail:Point;approach:Approach;alignLeft:boolean;textShift:number;mark:Bounds;text:Bounds;dir:number};
   const candidates:Candidate[]=[],seen=new Set<string>();
   const blockedAreas=[...base.map(o=>o.bounds),...portBoxes.map(o=>o.lead),...labelBoxes,stamp];
   function offer(p:Point,approach:Approach,alignLeft=approach==='left'){
    const point={x:round(p.x),y:round(p.y)},key=`${point.x},${point.y},${approach},${alignLeft}`;
    if(seen.has(key)||!inFrame(point))return;seen.add(key);
    const {x,y}=point,b=textBoxes[alignLeft?'left':'right'];
    const directionIndex=['right','down','left','up'].indexOf(approach),axis=dirs[directionIndex];
    const mark=labelMarkBounds(point,approach,ground);
    const unavailable=(box:Bounds)=>box.x<20||box.right>415||box.y<5||box.bottom>292||
     blockedAreas.some(o=>intersects(box,o,.18))||allSegments.some(([a,c])=>segmentHits(a,c,box));
    if(unavailable(mark))return;
    const tail={x:round(x-axis.x*LABEL_LEAD),y:round(y-axis.y*LABEL_LEAD)};
    if(blocked(tail,point,e.placed)||onForeign(point,foreign))return;
    for(const textShift of ground?[0]:axis.y?[0,.65,1.25,-.65,5.5,8.5]:[0,.65,1.25,-.65]){
     const text=ground?mark:{x:x+b.x,right:x+b.right,y:y+b.y+textShift,bottom:y+b.bottom+textShift};
     if(!ground&&unavailable(text))continue;
     candidates.push({point,tail,approach,alignLeft,textShift,mark,text,dir:directionIndex});
     if(!textShift)break;
    }
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
    for(const n of [LABEL_LEAD,4,6,8.75,11,13.75,17.5,22.5,28,35,42,50,65]){
     for(const shift of [0,-5,5,-10,10,-17.5,17.5,-30,30]){
      const x=lead.x+dir.x*n-dir.y*shift,y=lead.y+dir.y*n+dir.x*shift;
      offer({x,y},headings[heading]);
      offer({x,y},headings[heading],dir.x>=0);
      for(const k of [(heading+1)%4,(heading+3)%4])offer({x:x+dirs[k].x*LABEL_LEAD,y:y+dirs[k].y*LABEL_LEAD},headings[k]);
     }
    }
    for(const n of [8.75,17.5,30,50])for(const shift of [-10,10,-22.5,22.5,0])
     offer({x:lead.x-dir.x*n-dir.y*shift,y:lead.y-dir.y*n+dir.x*shift},headings[opposite(heading)]);
   }
   let choice:Candidate|undefined,points:Point[]=[],bestScore=Infinity,searchBudget=false;
   if(!onForeign(e.point,foreign)&&!blocked(e.point,lead,e.placed)){
    const wrongSide=(c:Candidate)=>!ground&&(c.point.x-e.point.x)*dir.x+(c.point.y-e.point.y)*dir.y<0;
    const sidePenalty=(c:Candidate)=>(wrongSide(c)?24:0)+(!ground&&c.dir!==heading?5:0)+Math.abs(c.textShift)*.4;
    const lateral=(c:Candidate)=>dir.y?Math.abs(c.point.x-e.point.x):Math.abs(c.point.y-e.point.y);
    const score=(c:Candidate)=>dist(lead,c.tail)+sidePenalty(c);
    candidates.sort((a,b)=>score(a)-score(b));
    function tryPath(c:Candidate,search:boolean){
     const avoidLabel:Blocked=(a,b)=>blocked(a,b)||segmentHits(a,b,c.text)||segmentHits(a,b,c.mark);
     avoidLabel.turn=blocked.turn;
     const middle=findPath(lead,c.tail,search?[...boxes,...trackGuides(foreign),{bounds:c.text},{bounds:c.mark}]:boxes,avoidLabel,heading,c.dir,search,()=>{searchBudget=true;});
     if(!middle)return;
     let path=withoutLoops([e.point,...middle,c.point]);
     if(attached)path=stopAtTree(path.slice().reverse(),tree).reverse();
     const a=path.at(-2),b=path.at(-1);
     if(!a||!b||!same(b,c.point)||direction(a,b)!==c.dir||dist(a,b)<LABEL_LEAD-.001)return;
     const cost=segments(path).reduce((sum,[a,b])=>sum+dist(a,b),0)+9*Math.max(0,path.length-2)+shortJog(path)+sidePenalty(c)+.8*lateral(c);
     if(cost<bestScore){choice=c;points=path;bestScore=cost;}
    }
    let valid=0;
    for(const c of candidates){
     if(choice&&!attached&&score(c)+LABEL_LEAD>bestScore)break;
     const previous=bestScore;tryPath(c,false);
     if(previous!==bestScore)valid++;
     if(valid>=6)break;
    }
    if(!choice)for(const c of candidates.slice(0,12)){tryPath(c,true);if(choice)break;}
   }
   if(!choice){
    const blockage=boxes.find(box=>box.owner!==e.placed&&segmentHits(e.point,lead,box.bounds));
    const reason=!inFrame(e.point)||!inFrame(lead)?'FRAME':blockage||blocked(e.point,lead,e.placed)||onForeign(e.point,foreign)?'PIN_EXIT':!candidates.length?'LABEL_FOOTPRINT':searchBudget?'SEARCH_BUDGET':'SEARCH';
    const obstacle=blockage?.owner?.key??sheetRoutes.find(w=>w.net_id!==net.id&&segments(w.points).some(([a,b])=>hit(e.point,lead,a,b)))?.id;
    return {severity:'error',code:'LABEL_CROWDED',sheet_id:sheet,net_id:net.id,point:e.point,pins:[e.terminal],reason,obstacle,
     message:`${net.name||net.id}, ${e.terminal.instance_id}.${e.pin.number}: ${({FRAME:'выход за рамку',PIN_EXIT:'заблокирован выход из вывода',LABEL_FOOTPRINT:'нет места для обозначения',SEARCH_BUDGET:'исчерпан предел поиска подвода к обозначению',SEARCH:'не найден свободный подвод к обозначению'})[reason]}${obstacle?' ('+obstacle+')':''}`};
   }
   labels.push({net_id:net.id,sheet_id:sheet,point:choice.point,text,role:net.role,pin:e.terminal,continuation:peer!==undefined,...(peer!==undefined?{peerSheet:s.sheets[peer].id,pairId:pairs.find(p=>p.net===net.id&&(p.from===sheet&&p.to===s.sheets[peer].id||p.to===sheet&&p.from===s.sheets[peer].id))!.id}:{}),approach:choice.approach,alignLeft:choice.alignLeft,...(choice.textShift?{textShift:choice.textShift}:{})});
   if(!ground)labelBoxes.push(choice.text);
   labelBoxes.push(choice.mark);
   if(points.length>1)add({id:routeId('label',net,net.pins.findIndex(pin=>terminalKey(pin)===terminalKey(e.terminal))+(peer!==undefined?(peer+1)*net.pins.length:0)),net_id:net.id,sheet_id:sheet,points});
  }
  const checkpoint=()=>({routes:routes.length,ink:sheetRoutes.length,labels:labels.length,boxes:labelBoxes.length});
  const recent:{job:typeof pending[number];before:ReturnType<typeof checkpoint>}[]=[];
  for(const job of pending){
   const before=checkpoint();
   let selected=job,failure=place(job);
   if(failure&&job.peer!==undefined&&!manualLabels.has(labelKey(job.net.id,job.end.terminal,job.peer))){
    const local=plans.find(plan=>plan.net===job.net)?.local??[];
    for(const end of local.filter(end=>end!==job.end).slice(0,4)){
     const another={...job,end};
     if(place(another))continue;
     selected=another;failure=undefined;
     // A relocated port still needs the original physical pin on its local net.
     enqueue(job.net,job.end);
     break;
    }
   }
   if(!failure){recent.push({job:selected,before});if(recent.length>2)recent.shift();continue;}
   const d=pinDirection(job.end.placed,job.end.pin);
   const eligible=recent.findLastIndex(({job:prior})=>{
    const other=pinDirection(prior.end.placed,prior.end.pin);
    return prior.end.placed!==job.end.placed||other.x!==d.x||other.y!==d.y||
     manualLabels.has(labelKey(prior.net.id,prior.end.terminal,prior.peer));
   });
   const displaced=recent.slice(eligible+1);
   if(displaced.length&&!manualLabels.has(labelKey(job.net.id,job.end.terminal,job.peer))){
    const start=displaced[0].before;
    const savedRoutes=routes.splice(start.routes),savedInk=sheetRoutes.splice(start.ink);
    const savedLabels=labels.splice(start.labels),savedBoxes=labelBoxes.splice(start.boxes);
    let success=true;
    const reordered=[job,...displaced.map(entry=>entry.job)],next:typeof recent=[];
    for(const candidate of reordered){
     const before=checkpoint();
     if(place(candidate)){success=false;break;}
     next.push({job:candidate,before});
    }
    if(success){recent.splice(0,recent.length,...next.slice(-2));continue;}
    routes.splice(start.routes,routes.length-start.routes,...savedRoutes);
    sheetRoutes.splice(start.ink,sheetRoutes.length-start.ink,...savedInk);
    labels.splice(start.labels,labels.length-start.labels,...savedLabels);
    labelBoxes.splice(start.boxes,labelBoxes.length-start.boxes,...savedBoxes);
   }
   issues.push(failure);
  }
  pending.length=0;
  }
  placeLabels();
 return {routes,labels,issues,retry};
}

export function routeSheetBatch(s:Schematic,sections:PlacedSection[],sheetIds:readonly string[],memo?:SheetRouteMemo):RoutedSheets{
 const endpoints=terminalGraph(sections),netIds=new Map(s.nets.map((net,i)=>[net,i]));
 const reserved=new Set(s.layout.routes.filter(r=>r.locked).map(r=>r.id));
 const pairs=continuationPairs(s,new Map([...endpoints].map(([key,e])=>[key,e.placed.sheet_id])));
 const batches=sheetIds.map(sheet=>{
  const calculate=()=>{
   let best=routeOneSheet(s,sections,sheet,endpoints,netIds,reserved,pairs);
   const localSections=sections.filter(section=>section.sheet_id===sheet);
   const localSchematic={...s,sheets:s.sheets.filter(page=>page.id===sheet),nets:s.nets.map(net=>({
    ...net,pins:net.pins.filter(pin=>endpoints.get(terminalKey(pin))?.placed.sheet_id===sheet)
   }))};
   const quality=(r:RoutedSheets)=>measureQuality({
    schematic:localSchematic,sections:localSections,issues:r.issues,
    routes:[...s.layout.routes.filter(route=>route.locked&&route.sheet_id===sheet),...r.routes],
    labels:r.labels.map(label=>({...label,peerSheet:undefined,pairId:undefined,continuation:false}))
   });
   let bestQuality:ReturnType<typeof quality>|undefined;
   for(const contactsFirst of [true,false]){
    if(!best.issues.some(i=>i.severity==='error')&&!(contactsFirst&&best.retry&&s.nets.length<=80&&s.components.length<=80))break;
    const failed=new Set(best.issues.flatMap(i=>i.pins?.map(terminalKey)??[]));
    const other=routeOneSheet(s,sections,sheet,endpoints,netIds,reserved,pairs,best.retry,contactsFirst,failed);
    const otherQuality=quality(other);
    bestQuality??=quality(best);
    if(betterQuality(otherQuality,bestQuality)){best=other;bestQuality=otherQuality;}
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
 for(const r of routes)if(r.points.some(p=>p.x<20||p.x>415||p.y<5||p.y>292))issues.push({severity:'error',code:'ROUTE_OUT_OF_BOUNDS',message:`Маршрут ${r.id} выходит за рамку А3`});
 return {routes,labels:batches.flatMap(b=>b.labels),issues};
}

export function routeSchematic(s:Schematic,sections:PlacedSection[]):RoutedSheets{
 return mergeRoutedSheets(s,[routeSheetBatch(s,sections,s.sheets.map(sh=>sh.id))]);
}
