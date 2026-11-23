import type { Issue, Library, Schematic } from './types.js';
export { componentSchema, schematicSchema } from './schemas.js';
export declare function validateComponent(value: unknown): Issue[];
export declare function expandRepeats(input: Schematic): {
    schematic: Schematic;
    issues: Issue[];
};
export declare function validateSchematic(value: unknown, library: Library): Issue[];
