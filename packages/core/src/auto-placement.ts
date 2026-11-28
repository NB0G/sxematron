import type {Bounds} from './geometry.js';
import {PAGE,intersects,pinDirection,pinPosition,sectionBounds,segmentHitsBounds} from './geometry.js';
import type {Net,Pin,PlacedSection,Point} from './types.js';

type ElkNode={id:string;width:number;height:number;x?:number;y?:number};
export type AutoEdge={from:PlacedSection;to:PlacedSection;pinFrom:Pin;pinTo:Pin;weight?:number};
export type LayoutElk={layout:(graph:{id:string;layoutOptions:Record<string,string>;children:ElkNode[];edges:{id:string;sources:string[];targets:string[]}[]})=>Promise<{children?:ElkNode[]}>};
export type AutoShape={rotations:number[];offsets:Point[]};
const rail=(n:Net)=>!!n.role&&n.role!=='signal';
const terminal=(id:string,pin:string)=>id+'\0'+pin;
export function pinNets(nets:Net[]){
 const map=new Map<string,Net>();
 for(const n of nets)for(const p of n.pins)map.set(terminal(p.instance_id,p.number),n);
 return map;
}

/** Small logical clusters without merging everything that shares a supply. */
export function placementGroups(sections:PlacedSection[],nets:Net[]):PlacedSection[][]{
 const parents=new Map<PlacedSection,PlacedSection>(), sizes=new Map<PlacedSection,number>();
 const terminals=new Map<string,PlacedSection>(), first=new Map<string,PlacedSection>();
 const root=(a:PlacedSection):PlacedSection=>{const p=parents.get(a);if(!p)return a;const r=root(p);parents.set(a,r);return r;};
 function join(a:PlacedSection,b:PlacedSection,limit:number){
  a=root(a);b=root(b);
  const size=(sizes.get(a)??1)+(sizes.get(b)??1);
  if(a!==b&&size<=limit){parents.set(b,a);sizes.set(a,size);}
 }
 for(const a of sections){
  const key=a.sheet_id+'|'+(a.instance.tag!==undefined?'tag:'+a.instance.tag:'id:'+a.instance.id);
  const prev=first.get(key);if(prev)join(prev,a,Infinity);else first.set(key,a);
  for(const p of a.section.pins)terminals.set(terminal(a.instance.id,p.number),a);
 }
 for(const n of nets){
  if(rail(n)||n.pins.length>6)continue;
  const connected=n.pins.map(p=>terminals.get(terminal(p.instance_id,p.number))).filter((a):a is PlacedSection=>!!a&&!a.instance.tag);
  for(let i=1;i<connected.length;i++)if(connected[0].sheet_id===connected[i].sheet_id)join(connected[0],connected[i],12);
 }
 const groups=new Map<PlacedSection,PlacedSection[]>();
 for(const a of sections){const k=root(a),list=groups.get(k);if(list)list.push(a);else groups.set(k,[a]);}
 return [...groups.values()];
}

export function localEdges(list:PlacedSection[],nets:Net[]):AutoEdge[]{
 const terminals=new Map(list.flatMap(a=>a.section.pins.map(pin=>[terminal(a.instance.id,pin.number),{a,pin}] as const)));
 return nets.flatMap(net=>{
  const pins=net.pins.flatMap(p=>terminals.get(terminal(p.instance_id,p.number))??[])
   .sort((a,b)=>a.a.key.localeCompare(b.a.key)||a.pin.number.localeCompare(b.pin.number));
  const participants=new Set(pins.map(end=>end.a)).size;
  if(rail(net)||participants<2||pins.length>24)return [];
  const weight=1/Math.sqrt(participants-1),edges:AutoEdge[]=[];
  const tree=[pins[0]],remaining=new Set(pins.slice(1));
  while(remaining.size){
   let cost=Infinity,source=tree[0],target=remaining.values().next().value!;
   for(const a of tree)for(const b of remaining){
    const p=pinPosition(a.a,a.pin),q=pinPosition(b.a,b.pin),da=pinDirection(a.a,a.pin),db=pinDirection(b.a,b.pin);
    const d=Math.abs(p.x-q.x)+Math.abs(p.y-q.y)+8*Number(da.x===db.x&&da.y===db.y);
    if(d<cost){cost=d;source=a;target=b;}
   }
   remaining.delete(target);tree.push(target);
   if(source.a!==target.a){
    const [a,b]=source.pin.side==='left'&&target.pin.side==='right'?[target,source]:[source,target];
    edges.push({from:a.a,to:b.a,pinFrom:a.pin,pinTo:b.pin,weight});
   }
  }
  return edges;
 });
}

function orientedStarts(list:PlacedSection[],edges:AutoEdge[],rotations:number[],boxes:Bounds[],gap:number):Point[]|undefined{
 const adjacent=list.map(a=>edges.flatMap(edge=>edge.from===a?[{pin:edge.pinFrom,peer:list.indexOf(edge.to),other:edge.pinTo,weight:edge.weight??1}]:
  edge.to===a?[{pin:edge.pinTo,peer:list.indexOf(edge.from),other:edge.pinFrom,weight:edge.weight??1}]:[]));
 const poses=list.map((section,i)=>({...section,rotation:rotations[i],position:{x:0,y:0}}));
 const occupied=new Map<number,Bounds>();
 const remaining=new Set(list.map((_,i)=>i));
 const margin=gap/2;
 function world(i:number,p:Point):Bounds{
  const b=boxes[i];return {x:p.x+b.x,y:p.y+b.y,right:p.x+b.right,bottom:p.y+b.bottom};
 }
 while(remaining.size){
  const i=[...remaining].sort((a,b)=>{
   const degree=(j:number)=>adjacent[j].reduce((n,e)=>n+e.weight*(occupied.has(e.peer)?100:1),0);
   return degree(b)-degree(a)||list[a].key.localeCompare(list[b].key);
  })[0];
  remaining.delete(i);
  const attached=adjacent[i].filter(e=>occupied.has(e.peer));
  const candidates:Point[]=[];
  const add=(x:number,y:number)=>candidates.push({x,y});
  const b=boxes[i];
  for(const edge of attached){
   const a=poses[edge.peer],p=pinPosition(a,edge.other),from=pinDirection(a,edge.other);
   const q=pinPosition(poses[i],edge.pin);
   const box=occupied.get(edge.peer)!;
   for(const gap of [5,12,22])for(const shift of [0,8,-8,18,-18]){
    const x=p.x-q.x,y=p.y-q.y;
    if(from.x)add(from.x>0?box.right-b.x+gap:box.x-b.right-gap,y+shift);
    else add(x+shift,from.y>0?box.bottom-b.y+gap:box.y-b.bottom-gap);
   }
  }
  for(const box of occupied.values()){
   add(box.right+gap-b.x,box.y-b.y);
   add(box.x-b.right-gap,box.y-b.y);
   add(box.x-b.x,box.bottom+gap-b.y);
   add(box.x-b.x,box.y-b.bottom-gap);
  }
  if(!occupied.size)add(-b.x,-b.y);
  let best:Point|undefined,cost=Infinity;
  for(const p of candidates){
   const test=world(i,p);
   if([...occupied.values()].some(o=>intersects(test,o,margin)))continue;
   const trial={...poses[i],position:p};
   let score=.09*(Math.abs(p.x)+Math.abs(p.y));
   for(const edge of attached){
    const a=poses[edge.peer],q=pinPosition(a,edge.other),u=pinPosition(trial,edge.pin);
    const d=pinDirection(trial,edge.pin),v=pinDirection(a,edge.other),dx=q.x-u.x,dy=q.y-u.y;
    const blockers=(corner:Point)=>[...occupied].filter(([index,box])=>index!==edge.peer&&(segmentHitsBounds(u,corner,box)||segmentHitsBounds(corner,q,box))).length;
    score+=edge.weight*(Math.abs(dx)+Math.abs(dy)+8*Number(dx!==0&&dy!==0)+12*Number(d.x*dx+d.y*dy<0)+12*Number(v.x*dx+v.y*dy>0)+16*Math.min(blockers({x:u.x,y:q.y}),blockers({x:q.x,y:u.y})));
   }
   if(score<cost){cost=score;best=p;}
  }
  if(!best)return;
  poses[i].position=best;occupied.set(i,world(i,best));
 }
 const x=Math.min(...[...occupied.values()].map(b=>b.x)),y=Math.min(...[...occupied.values()].map(b=>b.y));
 return list.map((_,i)=>({x:occupied.get(i)!.x-x,y:occupied.get(i)!.y-y}));
}

function canTurn(a:PlacedSection,turnable:ReadonlySet<string>){
 if(a.placement.rotation!==undefined||!turnable.has(a.key)||a.section.pins.length!==2)return false;
 const [p,q]=a.section.pins;return (p.side==='left'&&q.side==='right')||(q.side==='left'&&p.side==='right')||(p.side==='top'&&q.side==='bottom')||(p.side==='bottom'&&q.side==='top');
}
function rotation(a:PlacedSection,vertical:boolean,byPin:Map<string,Net>,turnable:ReadonlySet<string>,allowRotate:boolean){
 if(!allowRotate||!canTurn(a,turnable))return a.rotation;
 const [p,q]=a.section.pins;
 const n=byPin.get(terminal(a.instance.id,p.number)),m=byPin.get(terminal(a.instance.id,q.number));
 const anchor=n&&m&&rail(n)&&rail(m)&&n.role!==m.role
  ? (n.role==='ground'||m.role==='positive_supply'?[p,n] as const:[q,m] as const)
  : n&&rail(n)&&(!m||!rail(m))?[p,n] as const:m&&rail(m)&&(!n||!rail(n))?[q,m] as const:undefined;
 if(anchor){
  const [pin,net]=anchor,sign=net.role==='positive_supply'?-1:1;
  return [0,90,270,180].find(r=>pinDirection({...a,rotation:r},pin).y===sign)??a.rotation;
 }
 return vertical&&pinDirection(a,p).x!==0?(pinDirection({...a,rotation:90},p).y<0?90:270):a.rotation;
}

function bounds(a:PlacedSection,r:number){return sectionBounds(a.section,r,a.mirror,{...a.instance,label_padding:a.label_padding});}

export async function chooseAutoShape(list:PlacedSection[],edges:AutoEdge[],byPin:Map<string,Net>,turnable:ReadonlySet<string>,elk:()=>Promise<LayoutElk>,hardGroup:boolean):Promise<{shape:AutoShape;elkFailed:boolean}>{
 const index=new Map(list.map((a,i)=>[a,i]));
 let best:AutoShape|undefined, bestCost=Infinity, elkFailed=false;
 const gap=7;
 function candidate(rotations:number[],boxes:Bounds[],positions:Point[],bias=1){
  if(positions.length!==list.length)return;
  const offsets=positions.map((p,i)=>({x:p.x-boxes[i].x,y:p.y-boxes[i].y}));
  const width=Math.max(...positions.map((p,i)=>p.x+boxes[i].right-boxes[i].x));
  const height=Math.max(...positions.map((p,i)=>p.y+boxes[i].bottom-boxes[i].y));
  const max=Math.max(width,height),min=Math.min(width,height);
  let cost=width+height+.38*max+.12*(max-min);
  cost+=10*Math.max(0,width-(PAGE.drawing.right-PAGE.drawing.x-10),height-(PAGE.drawing.bottom-PAGE.drawing.y-10));
  for(const edge of edges){
   const i=index.get(edge.from)!,j=index.get(edge.to)!;
   const a={...edge.from,position:offsets[i],rotation:rotations[i]},b={...edge.to,position:offsets[j],rotation:rotations[j]};
   const p=pinPosition(a,edge.pinFrom),q=pinPosition(b,edge.pinTo),dp=pinDirection(a,edge.pinFrom),dq=pinDirection(b,edge.pinTo);
   const dx=q.x-p.x,dy=q.y-p.y;
   const blockers=(corner:Point)=>positions.filter((o,k)=>k!==i&&k!==j&&[
    [p,corner],[corner,q]
   ].some(([u,v])=>segmentHitsBounds(u,v,{x:o.x,y:o.y,right:o.x+boxes[k].right-boxes[k].x,bottom:o.y+boxes[k].bottom-boxes[k].y}))).length;
   cost+=(edge.weight??1)*(.85*(Math.abs(dx)+Math.abs(dy))+9*Number(dp.x*dx+dp.y*dy<-.01)+9*Number(dq.x*dx+dq.y*dy>.01)+20*Math.min(blockers({x:p.x,y:q.y}),blockers({x:q.x,y:p.y})));
  }
  cost*=bias;
  if(cost<bestCost){best={rotations,offsets};bestCost=cost;}
 }
 for(const vertical of (list.length===1||hardGroup?[false]:[false,true])){
  const rotations=list.map(a=>rotation(a,vertical,byPin,turnable,!hardGroup));
  const boxes=list.map((a,i)=>bounds(a,rotations[i]));
  if(list.length===1){candidate(rotations,boxes,[{x:0,y:0}]);continue;}
  const sizes=boxes.map(b=>({w:b.right-b.x,h:b.bottom-b.y}));
  // A balanced shelf is bounded and remains available when layered ELK
  // gives a pipeline longer than the page.
  if(!hardGroup){
   const proximity=edges.length&&list.length<=80?orientedStarts(list,edges,rotations,boxes,gap):undefined;
   if(proximity)candidate(rotations,boxes,proximity);
   const total=sizes.reduce((n,p)=>n+(p.w+gap)*(p.h+gap),0);
   for(const factor of [1,1.35]){
    const rowWidth=Math.max(Math.sqrt(total)*factor,...sizes.map(s=>s.w));
    let x=0,y=0,rowHeight=0;
    const points=sizes.map(p=>{if(x&&x+p.w>rowWidth){y+=rowHeight+gap;x=0;rowHeight=0;}const point={x,y};x+=p.w+gap;rowHeight=Math.max(rowHeight,p.h);return point;});
    candidate(rotations,boxes,points);
   }
  }
  if(list.length<=80&&(edges.length||hardGroup))try{
   const graph=await (await elk()).layout({id:'root',layoutOptions:{'elk.algorithm':'layered','elk.direction':vertical?'DOWN':'RIGHT','elk.randomSeed':'1','elk.spacing.nodeNode':'10','elk.layered.spacing.nodeNodeBetweenLayers':'12','elk.padding':'[top=0,left=0,bottom=0,right=0]'},
    children:list.map((a,i)=>({id:a.key,width:sizes[i].w+gap,height:sizes[i].h+gap})),
    edges:edges.map((e,i)=>({id:'e'+i,sources:[e.from.key],targets:[e.to.key]}))});
   const byId=new Map(graph.children?.map(a=>[a.id,a]));
   if(list.every(a=>byId.has(a.key)))candidate(rotations,boxes,list.map(a=>({x:byId.get(a.key)!.x??0,y:byId.get(a.key)!.y??0})));
  }catch{elkFailed=true;}
  if(hardGroup&&!best)candidate(rotations,boxes,list.map((_,i)=>({x:(i%6)*60,y:Math.floor(i/6)*55})));
 }
 // A long series chain can fold into rows. Vertical turnable at the
 // turns connect two parallel rows without a broad return wire.
 if(!hardGroup&&list.length>=6&&list.length<=40&&edges.length===list.length-1&&list.every(a=>canTurn(a,turnable)&&!a.section.pins.some(p=>{const n=byPin.get(terminal(a.instance.id,p.number));return n&&rail(n);}))){
  const adj=new Map(list.map(a=>[a,[] as {peer:PlacedSection;pin:Pin}[]]));
  for(const e of edges){adj.get(e.from)!.push({peer:e.to,pin:e.pinFrom});adj.get(e.to)!.push({peer:e.from,pin:e.pinTo});}
  const start=list.find(a=>adj.get(a)!.length===1);
  if(start&&list.every(a=>adj.get(a)!.length>0&&adj.get(a)!.length<=2)){
   const run=Math.max(3,Math.ceil(Math.sqrt(list.length)));
   const dirs=[{x:1,y:0},{x:0,y:1},{x:-1,y:0}];
   const rotations:number[]=[],boxes:Bounds[]=[],positions:Point[]=[],seen=new Set<PlacedSection>();
   let a:PlacedSection|undefined=start,previous:PlacedSection|undefined,end:Point={x:0,y:0},prior:Point=dirs[0],i=0;
   while(a&&!seen.has(a)){
    seen.add(a);
    const d=i%(run+1)===run?dirs[1]:dirs[2*(Math.floor(i/(run+1))%2)];
    const here:{peer:PlacedSection;pin:Pin}[]=adj.get(a)!;
    const next=here.find(e=>e.peer!==previous),prev=here.find(e=>e.peer===previous);
    const output=next?.pin??a.section.pins.find(p=>p!==prev?.pin)!;
    const input=prev?.pin??a.section.pins.find(p=>p!==output)!;
    const r=[0,90,180,270].find(r=>{const f=pinDirection({...a!,rotation:r},output);return f.x===d.x&&f.y===d.y;});
    if(r===undefined||input===output)break;
    const zero={...a,rotation:r,position:{x:0,y:0}},inlet=pinPosition(zero,input),outlet=pinPosition(zero,output);
    const turn=i>0&&(d.x!==prior.x||d.y!==prior.y);
    const b=bounds(a,r),j=index.get(a)!;
    const planned={x:end.x+(turn?16*prior.x+12*d.x:i?10*d.x:0)-inlet.x,y:end.y+(turn?16*prior.y+12*d.y:i?10*d.y:0)-inlet.y};
    let origin:Point|undefined;
    for(let extra=0;extra<=30;extra+=2){
     const p={x:planned.x+extra*d.x,y:planned.y+extra*d.y},test={x:p.x+b.x,y:p.y+b.y,right:p.x+b.right,bottom:p.y+b.bottom};
     if(!positions.some((q,k)=>intersects(test,{...q,right:q.x+boxes[k].right-boxes[k].x,bottom:q.y+boxes[k].bottom-boxes[k].y},7))){origin=p;break;}
    }
    if(!origin)break;
    rotations[j]=r;boxes[j]=b;positions[j]={x:origin.x+b.x,y:origin.y+b.y};
    end={x:origin.x+outlet.x,y:origin.y+outlet.y};prior=d;previous=a;a=next?.peer;i++;
   }
   if(i===list.length){
    const placed=positions.map((p,j)=>({...p,right:p.x+boxes[j].right-boxes[j].x,bottom:p.y+boxes[j].bottom-boxes[j].y}));
    if(!placed.some((b,j)=>placed.slice(j+1).some(c=>intersects(b,c,7)))){
     const left=Math.min(...placed.map(b=>b.x)),top=Math.min(...placed.map(b=>b.y));
     candidate(rotations,boxes,positions.map(p=>({x:p.x-left,y:p.y-top})),.9);
    }
   }
  }
 }
 return {shape:best!,elkFailed};
}

/** Fill a compact region first instead of scanning the entire page width. */
export function compactOrigins(step:number,maxX:number,maxY:number):Point[]{
 const {x,y}=PAGE.drawing;
 const points:Point[]=[];
 for(let py=y;py<=maxY;py+=step)for(let px=x;px<=maxX;px+=step)points.push({x:px,y:py});
 const rank=(p:Point)=>Math.max((p.x-x)*.8,p.y-y);
 return points.sort((a,b)=>rank(a)-rank(b)||(a.x+a.y)-(b.x+b.y)||a.y-b.y||a.x-b.x);
}
