const _importDynamic: <T>(modulePath: string) => Promise<T> = new Function(
    "modulePath",
    "return import(modulePath);"
) as any;
export default _importDynamic;
