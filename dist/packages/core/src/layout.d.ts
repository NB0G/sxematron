import type { ComponentDefinition, Library, Resolved, Schematic } from './types.js';
export declare function fingerprint(c: ComponentDefinition): string;
export declare function assignDesignators(s: Schematic, lib: Library, reset?: boolean): void;
/** Explicit user action only: sheet order, then top-to-bottom and left-to-right. */
export declare function renumberByPosition(s: Schematic): void;
export declare function emptySchematic(): Schematic;
export declare function newId(prefix?: string): string;
export declare function buildSchematic(input: Schematic, lib: Library, options?: {
    reset?: boolean;
}): Promise<Resolved>;
