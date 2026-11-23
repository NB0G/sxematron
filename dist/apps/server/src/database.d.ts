import { DatabaseSync } from 'node:sqlite';
import type { ComponentDefinition } from '../../../packages/core/src/types.js';
export declare class LibraryDatabase {
    readonly db: DatabaseSync;
    readonly filename: string;
    constructor(dataDir: string);
    list(): ComponentDefinition[];
    get(code: string): ComponentDefinition | undefined;
    reserved(code: string): boolean;
    create(component: ComponentDefinition): void;
    update(component: ComponentDefinition): void;
    remove(code: string): void;
    transaction<T>(fn: () => T): T;
    close(): void;
}
