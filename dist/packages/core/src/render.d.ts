import type { Primitive, Resolved, ComponentDefinition } from './types.js';
export declare const escapeXml: (s: unknown) => string;
export declare function renderPrimitive(p: Primitive): string;
export declare function renderSheet(res: Resolved, sheetId: string, options?: {
    interactive?: boolean;
    outlineFont?: any;
}): string;
export declare function exportSheets(res: Resolved, options?: {
    textMode?: 'outline' | 'editable';
    sheetId?: string;
}): {
    name: string;
    bytes: Uint8Array;
    mime: string;
};
export declare function componentPreview(d: ComponentDefinition, variantCode?: string, sectionId?: string): string;
