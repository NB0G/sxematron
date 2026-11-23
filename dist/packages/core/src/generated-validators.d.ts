declare var validateComponentJson: typeof validate10;
declare function validate10(data: any, { instancePath, parentData, parentDataProperty, rootData }?: {
    instancePath?: string | undefined;
    rootData?: any;
}): boolean;
declare var validateSchematicJson: typeof validate13;
declare function validate13(data: any, { instancePath, parentData, parentDataProperty, rootData }?: {
    instancePath?: string | undefined;
    rootData?: any;
}): boolean;
export { validateComponentJson, validateSchematicJson };
