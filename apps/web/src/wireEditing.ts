import type {Point} from '../../../packages/core/src/types.js';
export const samePoint=(a:Point,b:Point)=>a.x===b.x&&a.y===b.y;
const orth=(a:Point,b:Point)=>a.x===b.x||a.y===b.y;
const copy=(points:Point[])=>points.map(p=>({...p}));
function distinct(points:Point[]){return copy(points.filter((p,i)=>!i||!samePoint(p,points[i-1])));}
export function simplifyOrthogonal(points:Point[]):Point[]{
 const out:Point[]=[];
 for(const p of distinct(points)){out.push(p);while(out.length>=3){const [a,b,c]=out.slice(-3);if((a.x===b.x&&b.x===c.x)||(a.y===b.y&&b.y===c.y))out.splice(out.length-2,1);else break;}}
 return out;
}
const span=(a:number,b:number,n:number)=>Math.min(a,b)<=n&&n<=Math.max(a,b);
export function onWire(p:Point,points:Point[]){
 return points.some((b,i)=>i>0&&orth(p,b)&&((points[i-1].x===b.x&&p.x===b.x&&span(points[i-1].y,b.y,p.y))||(points[i-1].y===b.y&&p.y===b.y&&span(points[i-1].x,b.x,p.x))));
}
export function nearestWireSegment(points:Point[],p:Point):number {
 let best=-1,dist=Infinity;
 for(let i=0;i<points.length-1;i++){
  const a=points[i],b=points[i+1];
  if(samePoint(a,b))continue;
  const x=Math.max(Math.min(a.x,b.x),Math.min(Math.max(a.x,b.x),p.x));
  const y=Math.max(Math.min(a.y,b.y),Math.min(Math.max(a.y,b.y),p.y));
  const d=(x-p.x)**2+(y-p.y)**2;if(d<dist){best=i;dist=d;}
 }
 return best;
}
export function insertWireVertex(points:Point[],index:number,target:Point):Point[]{
 const a=points[index],b=points[index+1];
 if(!a||!b)return copy(points);
 const p=a.x===b.x?{x:a.x,y:target.y}:{x:target.x,y:a.y};
 if(!onWire(p,[a,b])||samePoint(p,a)||samePoint(p,b))return copy(points);
 return copy([...points.slice(0,index+1),p,...points.slice(index+1)]);
}
type Axis='x'|'y';
const axis=(a:Point,b:Point):Axis=>a.x===b.x?'y':'x';
const normal=(axis:Axis):Axis=>axis==='x'?'y':'x';
const shift=(p:Point,coord:Axis,n:number)=>({...p,[coord]:n});
function adjustNeighbor(points:Point[],index:number,neighbor:number,coord:Axis,position:number){
 const fixed=points[index],outer=points[neighbor],moved=shift(fixed,coord,position);
 // The adjacent perpendicular leg slides along itself; terminal and explicit
 // collinear waypoints stay where the user put them.
 if(outer&&outer[normal(coord)]===fixed[normal(coord)]&&!samePoint(outer,fixed))return [moved];
 return neighbor<index?[fixed,moved]:[moved,fixed];
}
export function moveWireSegment(points:Point[],index:number,target:Point):Point[]{
 const a=points[index],b=points[index+1];
 if(!a||!b||samePoint(a,b))return copy(points);
 const coord=normal(axis(a,b)),at=target[coord];
 if(at===a[coord])return copy(points);
 return distinct([...points.slice(0,index),...adjustNeighbor(points,index,index-1,coord,at),...adjustNeighbor(points,index+1,index+2,coord,at),...points.slice(index+2)]);
}
export function moveWireVertex(points:Point[],index:number,target:Point):Point[]{
 const a=points[index-1],old=points[index],b=points[index+1];
 if(!a||!old||!b||samePoint(target,old))return copy(points);
 const first=normal(axis(a,old)),last=normal(axis(old,b));
 const before=adjustNeighbor(points,index-1,index-2,first,target[first]);
 const after=adjustNeighbor(points,index+1,index+2,last,target[last]);
 return distinct([...points.slice(0,index-1),...before,target,...after,...points.slice(index+2)]);
}
export function removeWireVertex(points:Point[],index:number):Point[]{
 const a=points[index-1],old=points[index],b=points[index+1];
 if(!a||!old||!b)return copy(points);
 if(orth(a,b))return distinct([...points.slice(0,index),...points.slice(index+1)]);
 // Prefer dropping the complete local jog; when an L bend is necessary use
 // the other corner. Never create a diagonal or move the terminals.
 for(const [left,right] of [[index-2,index+1],[index-1,index+2],[index-2,index+2]]){
  if(left>=0&&right<points.length&&orth(points[left],points[right]))return distinct([...points.slice(0,left+1),...points.slice(right)]);
 }
 const corner=a.x===old.x?{x:b.x,y:a.y}:{x:a.x,y:b.y};
 return distinct([...points.slice(0,index),corner,...points.slice(index+1)]);
}

export function wireAnchors(points:Point[],others:Point[][],terminals:Point[]):Point[]{
 const anchors=terminals.filter(p=>onWire(p,points));
 for(const other of others){
  anchors.push(...other.filter(p=>onWire(p,points)),...points.filter(p=>onWire(p,other)));
  for(let i=1;i<points.length;i++)for(let j=1;j<other.length;j++){
   const a=points[i-1],b=points[i],c=other[j-1],d=other[j];
   if(axis(a,b)===axis(c,d))continue;
   const cross=a.x===b.x?{x:a.x,y:c.y}:{x:c.x,y:a.y};
   if(onWire(cross,[a,b])&&onWire(cross,[c,d]))anchors.push(cross);
  }
 }
 return anchors;
}
