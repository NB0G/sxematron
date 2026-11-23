import type { Point, Section, PlacedSection, Pin } from './types.js';
export declare const PAGE: {
    width: number;
    height: number;
    frame: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    drawing: {
        x: number;
        y: number;
        right: number;
        bottom: number;
    };
    stamp: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    grid: number;
};
export type Bounds = {
    x: number;
    y: number;
    right: number;
    bottom: number;
};
export declare const round: (n: number) => number;
export declare const snap: (n: number, step?: number) => number;
export declare const same: (a: Point, b: Point) => boolean;
export declare function transform(p: Point, rotation?: number, mirror?: boolean): Point;
export declare function sectionBounds(s: Section, rotation?: number, mirror?: boolean, caption?: {
    value?: string;
    designator?: string;
    label_padding?: Partial<Record<'left' | 'right' | 'top' | 'bottom', number>>;
}): Bounds;
export declare function placedBounds(s: PlacedSection, padding?: number): Bounds;
export declare function intersects(a: Bounds, b: Bounds, gap?: number): boolean;
export declare function inside(p: Point, b: Bounds): boolean;
export declare function pinPosition(s: PlacedSection, p: Pin): Point;
export declare function pinDirection(s: PlacedSection, p: Pin): Point;
export declare function simplify(points: Point[]): Point[];
export declare function pointOnSegment(p: Point, a: Point, b: Point): boolean;
