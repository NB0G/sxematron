import type { Schematic, PlacedSection, WireRoute, Issue, RenderedLabel } from './types.js';
export declare function routeSchematic(s: Schematic, sections: PlacedSection[]): {
    routes: WireRoute[];
    labels: RenderedLabel[];
    issues: Issue[];
};
