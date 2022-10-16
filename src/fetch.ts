import type { RequestInfo, RequestInit, Response } from "node-fetch";
import _importDynamic from "./_importDynamic";

export type { RequestInfo, RequestInit, Response } from "node-fetch";

export default async function fetch(
    url: RequestInfo,
    init?: RequestInit
): Promise<Response> {
    const { default: fetch } = await _importDynamic<
        typeof import("node-fetch")
    >("node-fetch");
    return fetch(url, init);
}
