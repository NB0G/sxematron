import type { Font } from 'opentype.js';
export declare const DRAWING_FONT_FAMILY = "OpenGOST type B";
export declare const DRAWING_FONT_SCALE = 1.7;
export declare const DRAWING_FONT_URL = "/fonts/OpenGOSTTypeB-Regular.ttf";
export declare function parseDrawingFont(buffer: ArrayBuffer): Font;
/** Convert text emitted by the shared renderer into paths; all coordinates remain mm. */
export declare function outlineSvgText(svg: string, fontBuffer: ArrayBuffer | Font): string;
/** Embed the unchanged OFL font into editable SVG; use paths for printer portability. */
export declare function embedDrawingFont(svg: string, fontBase64: string): string;
