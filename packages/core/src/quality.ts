import {PAGE,pinPosition,placedBounds,pointOnSegment,round} from './geometry.js';
import type {Point,Resolved} from './types.js';

const distance=(a:Point,b:Point)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
const key=(id:string,pin:string)=>id+'\0'+pin;
const area=(b:{x:number;y:number;right:number;bottom:number})=>(b.right-b.x)*(b.bottom-b.y);

/** Measure the drawn geometry, not the netlist alone: two stubs on the same
 * named net need a continuous conductor or an attached network symbol. */
export function measureQuality(r:Resolved){
 type Segment={a:Point;b:Point;wire:number;net:string;vertical:boolean};
 const ink=new Map<string,Segment[]>(),perNet=new Map<string,Segment[]>(),parents=r.routes.map((_,i)=>i);
 function root(i:number):number{while(parents[i]!==i){parents[i]=parents[parents[i]];i=parents[i];}return i;}
 function join(i:number,j:number){parents[root(i)]=root(j);}
 let length=0,bends=0,excessLength=0,crossings=0,spacingViolations=0,ambiguousContacts=0;
 for(const [i,w] of r.routes.entries()){
  const page=ink.get(w.sheet_id)??[],parts=perNet.get(key(w.sheet_id,w.net_id))??[];
  ink.set(w.sheet_id,page);perNet.set(key(w.sheet_id,w.net_id),parts);
  let previous:boolean|undefined,travel=0;
  for(let j=1;j<w.points.length;j++){
   const a=w.points[j-1],b=w.points[j],d=distance(a,b);if(!d)continue;
   const segment={a,b,wire:i,net:w.net_id,vertical:a.x===b.x};
   if(previous!==undefined&&previous!==segment.vertical)bends++;
   previous=segment.vertical;page.push(segment);parts.push(segment);travel+=d;
  }
  length+=travel;if(w.points.length)excessLength+=travel-distance(w.points[0],w.points.at(-1)!);
 }
 for(const page of ink.values()){
  // Sweep the x intervals: disjoint parts of a sparse sheet never meet.
  page.sort((p,q)=>Math.min(p.a.x,p.b.x)-Math.min(q.a.x,q.b.x));
  for(let i=0;i<page.length;i++)for(let j=i+1;j<page.length;j++){
   const p=page[i],q=page[j];if(Math.min(q.a.x,q.b.x)>Math.max(p.a.x,p.b.x)+3)break;
   if(p.wire===q.wire)continue;
   const same=p.net===q.net;
   if(p.vertical===q.vertical){
    const [axis,along]=p.vertical?['x','y'] as const:['y','x'] as const;
    const overlap=Math.min(Math.max(p.a[along],p.b[along]),Math.max(q.a[along],q.b[along]))-Math.max(Math.min(p.a[along],p.b[along]),Math.min(q.a[along],q.b[along]));
    const gap=Math.abs(p.a[axis]-q.a[axis]);if(overlap<0)continue;
    if(!gap){if(same)join(p.wire,q.wire);else ambiguousContacts++;}
    else if(!same&&overlap>.001&&gap<2.999)spacingViolations++;
   }else{
    const [v,h]=p.vertical?[p,q]:[q,p],point={x:v.a.x,y:h.a.y};
    if(!pointOnSegment(point,v.a,v.b)||!pointOnSegment(point,h.a,h.b))continue;
    if(same){join(p.wire,q.wire);continue;}
    if([p.a,p.b,q.a,q.b].some(end=>distance(end,point)<.001))ambiguousContacts++;else crossings++;
   }
  }
 }
 const contacts=(sheet:string,net:string,point:Point)=>(perNet.get(key(sheet,net))??[]).filter(p=>pointOnSegment(point,p.a,p.b)).map(p=>p.wire);
 const labeled=new Map<string,number>();
 let orphanLabels=0;
 for(const label of r.labels){
  const wires=contacts(label.sheet_id,label.net_id,label.point);
  if(!wires.length){orphanLabels++;continue;}
  const symbol=labeled.get(label.net_id)??wires[0];labeled.set(label.net_id,symbol);
  for(const wire of wires)join(symbol,wire);
 }
 const terminals=new Map(r.sections.flatMap(a=>a.section.pins.map(p=>[key(a.instance.id,p.number),{sheet:a.sheet_id,p:pinPosition(a,p)}] as const)));
 let missingTerminals=0,disconnectedGroups=0,linkedSpan=0;
 for(const net of r.schematic.nets){
  const components=new Set<number>(),bounds=new Map<string,{x:number;y:number;right:number;bottom:number}>();
  for(const t of net.pins){
   const e=terminals.get(key(t.instance_id,t.number));
   const wires=e?contacts(e.sheet,net.id,e.p):[];
   if(!wires.length){missingTerminals++;continue;}
   components.add(root(wires[0]));
   if(e&&(!net.role||net.role==='signal')&&net.render!=='label'){
    const b=bounds.get(e.sheet)??{x:e.p.x,right:e.p.x,y:e.p.y,bottom:e.p.y};b.x=Math.min(b.x,e.p.x);b.right=Math.max(b.right,e.p.x);b.y=Math.min(b.y,e.p.y);b.bottom=Math.max(b.bottom,e.p.y);bounds.set(e.sheet,b);
   }
  }
  disconnectedGroups+=Math.max(0,components.size-1);
  for(const b of bounds.values())linkedSpan+=b.right-b.x+b.bottom-b.y;
 }
 let envelopeArea=0,sectionArea=0;
 const boxes=new Map<string,ReturnType<typeof placedBounds>>();
 for(const a of r.sections){
  const b=placedBounds({...a,label_padding:undefined}),envelope=boxes.get(a.sheet_id);
  sectionArea+=area(b);
  if(envelope){envelope.x=Math.min(envelope.x,b.x);envelope.right=Math.max(envelope.right,b.right);envelope.y=Math.min(envelope.y,b.y);envelope.bottom=Math.max(envelope.bottom,b.bottom);}else boxes.set(a.sheet_id,{...b});
 }
 for(const b of boxes.values())envelopeArea+=area(b);
 const errors=r.issues.filter(i=>i.severity==='error').length;
 const hardGeometry=r.issues.filter(i=>['OVERLAP','OUT_OF_BOUNDS','LABEL_OVERLAP','LABEL_OUT_OF_BOUNDS','LOCKED_ROUTE_CLEARANCE','LOCKED_ROUTE_OBSTACLE','ROUTE_OUT_OF_BOUNDS'].includes(i.code)).length;
 // Hard counts are compared lexicographically before the weighted engineering
 // trade-off. Millimetres are the unit; a bend costs 8 mm, a crossing 22 mm.
 const electrical=missingTerminals+disconnectedGroups+orphanLabels+ambiguousContacts;
 const hard=hardGeometry+spacingViolations;
 const cost=round(length+8*bends+22*crossings+.6*excessLength+6*r.labels.length+.22*linkedSpan+.006*envelopeArea+5*r.issues.filter(i=>i.code==='AUTO_LABEL_FALLBACK').length);
 return {errors,electrical,hard,cost,length:round(length),bends,crossings,labels:r.labels.length,excessLength:round(excessLength),spacingViolations,ambiguousContacts,missingTerminals,disconnectedGroups,orphanLabels,linkedSpan:round(linkedSpan),envelopeArea:round(envelopeArea),sectionArea:round(sectionArea),packing:round(sectionArea/(envelopeArea||1)),pageUtilization:round(envelopeArea/((boxes.size||1)*area(PAGE.drawing)))};
}
export type SchematicQuality=ReturnType<typeof measureQuality>;
export function betterQuality(a:SchematicQuality,b:SchematicQuality){
 for(const k of ['electrical','errors','hard','cost'] as const)if(a[k]!==b[k])return a[k]<b[k];
 return false;
}
