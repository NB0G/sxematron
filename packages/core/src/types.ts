export type Point={x:number;y:number};
export type Primitive={id:string;kind:'line'|'polyline'|'rectangle'|'circle'|'arc'|'polygon'|'text'|'group';x?:number;y?:number;x2?:number;y2?:number;width?:number;height?:number;r?:number;start?:number;end?:number;text?:string;align?:'left'|'center'|'right';points?:Point[];children?:Primitive[];rotation?:number;mirror?:boolean};
export type Pin={number:string;x:number;y:number;side:'left'|'right'|'top'|'bottom';length?:number};
export type Section={section_id:string;graphics:Primitive[];pins:Pin[]};
export type Variant={variant_code:string;name:string;sections:Section[]};
export type ComponentDefinition={format_version:'1.0';component_code:string;name:string;category:string;positional_prefix:string;description?:string;rotationLocked?:boolean;physical_pins:{number:string}[];variants:Variant[]};
export type Placement={sheet_id?:string;position?:Point;locked?:boolean;rotation?:number;mirror?:boolean;relative?:boolean};
export type Instance={id:string;component_code:string;variant_code:string;value?:string;tag?:string;designator?:string;definition_fingerprint?:string;sections:Record<string,Placement>};
export type Terminal={instance_id:string;number:string};
export type Net={id:string;name?:string;render:'wire'|'label'|'auto';role?:'signal'|'positive_supply'|'negative_supply'|'ground';pins:Terminal[]};
export type Group={id:string;tag:string;sheet_id?:string;position?:Point;locked?:boolean;order?:number};
export type Sheet={id:string;title?:string};
export type WireRoute={id:string;net_id:string;sheet_id:string;points:Point[];locked?:boolean};
export type LabelPosition={peerSheet?:string;net_id:string;instance_id:string;number:string;position:Point;locked?:boolean};
export type RepeatTemplate={id:string;components:Instance[];nets:Net[];ports:Record<string,Terminal[]>};
export type RepeatInstance={id:string;template_id:string;count:number;tag?:string;sheet_id?:string;connections?:Record<string,string>};
export type Schematic={format_version:'1.0';document:{title:string;designation:string;author?:string;checked?:string;approved?:string;organization?:string;date?:string};sheets:Sheet[];groups:Group[];components:Instance[];nets:Net[];templates?:RepeatTemplate[];repeat_instances?:RepeatInstance[];layout:{mode:'mixed';unit:'mm';settings?:RoutingSettings;routes:WireRoute[];labels?:LabelPosition[]}};
export type Issue={severity:'error'|'warning';code:string;message:string;path?:string};
export type PlacedSection={key:string;instance:Instance;section:Section;placement:Placement;sheet_id:string;position:Point;rotation:number;mirror:boolean;width:number;height:number;label_padding?:Partial<Record<'left'|'right'|'top'|'bottom',number>>};
export type Resolved={quality?:import('./quality.js').SchematicQuality;schematic:Schematic;sections:PlacedSection[];routes:WireRoute[];issues:Issue[];labels:RenderedLabel[]};
export type RenderedLabel={net_id:string;sheet_id:string;point:Point;text:string;role?:Net['role'];pin?:Terminal;continuation?:boolean;peerSheet?:string;approach?:'left'|'right'|'down'|'up';alignLeft?:boolean};
export type Library=ComponentDefinition[];


export type RoutingSettings={iterations?:number;bodyClearance?:number;wireDensity?:number};
export const routingLimits={
 iterations:{min:1,max:8,default:2},
 bodyClearance:{min:0.5,max:5,default:1.25},
 wireDensity:{min:0,max:100,default:50}
} as const;

/** Called after schema validation. An omitted option and its explicit default are identical. */
export function routingSettings(layout:Schematic['layout']):Required<RoutingSettings>{
 return {
  iterations:layout.settings?.iterations??routingLimits.iterations.default,
  bodyClearance:layout.settings?.bodyClearance??routingLimits.bodyClearance.default,
  wireDensity:layout.settings?.wireDensity??routingLimits.wireDensity.default
 };
}
