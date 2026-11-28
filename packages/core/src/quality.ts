import {PAGE,placedBodyBounds,placedBounds,pinDirection,pinPosition,round,segmentHitsBounds} from './geometry.js';
import {distance,physicalPinKey} from './conductors.js';
import {localEdges} from './auto-placement.js';
import {auditConnections} from './connections.js';
import type {Resolved} from './types.js';

const area=(b:{x:number;y:number;right:number;bottom:number})=>(b.right-b.x)*(b.bottom-b.y);

export function measureQuality(r:Resolved,audit=auditConnections(r)){
 const {crossings,spacingViolations,ambiguousContacts,missingTerminals,disconnectedGroups,orphanLabels,unpairedPorts,foreignPins,duplicateGrounds,missingGrounds,invalidLabels}=audit;
 let length=0,bends=0,excessLength=0,linkedSpan=0,labelRun=0,reverseLabels=0,shortBends=0;
 const branches:number[]=[];
 for(const wire of r.routes){
  let previous:boolean|undefined,travel=0;
  for(let i=1;i<wire.points.length;i++){
   const a=wire.points[i-1],b=wire.points[i],step=distance(a,b);
   if(!step)continue;
   const vertical=a.x===b.x;
   if(previous!==undefined&&vertical!==previous){bends++;if(step<1.25&&i<wire.points.length-1)shortBends++;}
   previous=vertical;travel+=step;
  }
  branches.push(travel);
  length+=travel;
  if(wire.points.length)excessLength+=travel-distance(wire.points[0],wire.points.at(-1)!);
 }
 branches.sort((a,b)=>a-b);
 for(const label of r.labels){
  const terminal=label.pin&&audit.expected.get(physicalPinKey(label.pin.instance_id,label.pin.number));
  if(terminal){
   labelRun+=distance(terminal.point,label.point);
   const pin=terminal.owner.section.pins.find(p=>p.number===label.pin?.number);
   if(pin&&label.role!=='ground'){
    const d=pinDirection(terminal.owner,pin);
    if((label.point.x-terminal.point.x)*d.x+(label.point.y-terminal.point.y)*d.y<0)reverseLabels++;
   }
  }
 }
 for(const net of r.schematic.nets){
  if(net.role&&net.role!=='signal')continue;
  const bounds=new Map<string,{x:number;y:number;right:number;bottom:number}>();
  for(const pin of net.pins){
   const terminal=audit.expected.get(physicalPinKey(pin.instance_id,pin.number));
   if(!terminal)continue;
   const {point:p,owner}=terminal;
   const b=bounds.get(owner.sheet_id)??{x:p.x,y:p.y,right:p.x,bottom:p.y};
   b.x=Math.min(b.x,p.x);b.right=Math.max(b.right,p.x);b.y=Math.min(b.y,p.y);b.bottom=Math.max(b.bottom,p.y);
   bounds.set(owner.sheet_id,b);
  }
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
 let blockedCorridors=0;
 for(const sheet of boxes.keys()){
  const sections=r.sections.filter(a=>a.sheet_id===sheet),bodies=sections.map(section=>({section,box:placedBodyBounds(section)}));
  for(const edge of localEdges(sections,r.schematic.nets)){
   const a=pinPosition(edge.from,edge.pinFrom),b=pinPosition(edge.to,edge.pinTo);
   const count=(corner:typeof a)=>bodies.filter(({section,box})=>box&&section!==edge.from&&section!==edge.to&&
    (segmentHitsBounds(a,corner,box)||segmentHitsBounds(corner,b,box))).length;
   blockedCorridors+=Math.min(count({x:a.x,y:b.y}),count({x:b.x,y:a.y}));
  }
 }
 const errors=r.issues.filter(i=>i.severity==='error').length;
 const hardGeometry=r.issues.filter(i=>['OVERLAP','OUT_OF_BOUNDS','LABEL_OVERLAP','LABEL_OUT_OF_BOUNDS','LOCKED_ROUTE_CLEARANCE','LOCKED_ROUTE_OBSTACLE','ROUTE_CLEARANCE','ROUTE_OBSTACLE','ROUTE_OUT_OF_BOUNDS','NO_SPACE'].includes(i.code)).length;
 // Hard counts are compared lexicographically before the weighted engineering
 // trade-off. Millimetres are the unit; a bend costs 8 mm, a crossing 22 mm.
 const electrical=missingTerminals+disconnectedGroups+orphanLabels+ambiguousContacts+unpairedPorts+foreignPins+duplicateGrounds+missingGrounds+invalidLabels;
 const hard=hardGeometry+spacingViolations;
 const maxBranch=round(branches.at(-1)??0),p95Branch=round(branches[Math.max(0,Math.ceil(branches.length*.95)-1)]??0);
 const cost=round(length+8*bends+22*crossings+.6*excessLength+.08*labelRun+6*r.labels.length+.22*linkedSpan+
  .006*envelopeArea+4*shortBends+7*reverseLabels+12*blockedCorridors+.6*p95Branch+.15*maxBranch+
  5*r.issues.filter(i=>i.code==='AUTO_LABEL_FALLBACK').length);
 return {errors,electrical,hard,cost,length:round(length),bends,crossings,labels:r.labels.length,excessLength:round(excessLength),spacingViolations,ambiguousContacts,missingTerminals,disconnectedGroups,orphanLabels,unpairedPorts,foreignPins,duplicateGrounds,missingGrounds,invalidLabels,maxBranch,p95Branch,shortBends,reverseLabels,blockedCorridors,labelRun:round(labelRun),linkedSpan:round(linkedSpan),envelopeArea:round(envelopeArea),sectionArea:round(sectionArea),packing:round(sectionArea/(envelopeArea||1)),pageUtilization:round(envelopeArea/((boxes.size||1)*area(PAGE.drawing)))};
}
export type SchematicQuality=ReturnType<typeof measureQuality>;
export function betterQuality(a:SchematicQuality,b:SchematicQuality){
 for(const k of ['electrical','errors','hard','cost'] as const)if(a[k]!==b[k])return a[k]<b[k];
 return false;
}
