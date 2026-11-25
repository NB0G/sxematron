import type {Bounds} from './geometry.js';
import {PAGE,intersects,pinDirection,pinPosition,sectionBounds} from './geometry.js';
import type {Net,Pin,PlacedSection,Point} from './types.js';

type ElkNode={id:string;width:number;height:number;x?:number;y?:number};
export type AutoEdge={from:PlacedSection;to:PlacedSection;pinFrom:Pin;pinTo:Pin};
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
  if(rail(n)||n.render==='label'||n.pins.length>6)continue;
  const connected=n.pins.map(p=>terminals.get(terminal(p.instance_id,p.number))).filter((a):a is PlacedSection=>!!a&&!a.instance.tag);
  for(let i=1;i<connected.length;i++)if(connected[0].sheet_id===connected[i].sheet_id)join(connected[0],connected[i],12);
 }
 const groups=new Map<PlacedSection,PlacedSection[]>();
 for(const a of sections){const k=root(a),list=groups.get(k);if(list)list.push(a);else groups.set(k,[a]);}
 return [...groups.values()];
}

function canTurn(a:PlacedSection,passives:ReadonlySet<string>){
 if(a.placement.rotation!==undefined||!passives.has(a.instance.component_code)||a.section.pins.length!==2)return false;
 const [p,q]=a.section.pins;return (p.side==='left'&&q.side==='right')||(q.side==='left'&&p.side==='right')||(p.side==='top'&&q.side==='bottom')||(p.side==='bottom'&&q.side==='top');
}
function rotation(a:PlacedSection,vertical:boolean,byPin:Map<string,Net>,passives:ReadonlySet<string>,allowRotate:boolean){
 if(!allowRotate||!canTurn(a,passives))return a.rotation;
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

export async function chooseAutoShape(list:PlacedSection[],edges:AutoEdge[],byPin:Map<string,Net>,passives:ReadonlySet<string>,elk:()=>Promise<LayoutElk>,hardGroup:boolean):Promise<{shape:AutoShape;elkFailed:boolean}>{
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
   cost+=.62*(Math.abs(dx)+Math.abs(dy)) + 9*Number(dp.x*dx+dp.y*dy<-.01)+9*Number(dq.x*dx+dq.y*dy>.01);
  }
  cost*=bias;
  if(cost<bestCost){best={rotations,offsets};bestCost=cost;}
 }
 for(const vertical of (list.length===1||hardGroup?[false]:[false,true])){
  const rotations=list.map(a=>rotation(a,vertical,byPin,passives,!hardGroup));
  const boxes=list.map((a,i)=>bounds(a,rotations[i]));
  if(list.length===1){candidate(rotations,boxes,[{x:0,y:0}]);continue;}
  const sizes=boxes.map(b=>({w:b.right-b.x,h:b.bottom-b.y}));
  // A balanced shelf is bounded and remains available when layered ELK
  // gives a pipeline longer than the page.
  if(!hardGroup){
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
 // A long series chain can fold into rows. Vertical passives at the
 // turns connect two parallel rows without a broad return wire.
 if(!hardGroup&&list.length>=6&&list.length<=40&&edges.length===list.length-1&&list.every(a=>canTurn(a,passives)&&!a.section.pins.some(p=>{const n=byPin.get(terminal(a.instance.id,p.number));return n&&rail(n);}))){
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
