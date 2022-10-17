import AbortController from "abort-controller";
import fetch, { Response, RequestInit } from "./fetch";
import getUserAgent from "./getUserAgent";

// in seconds
let CONNECTION_TIMEOUT = 31;

export function setConnectionTimeout(timeout: number) {
    CONNECTION_TIMEOUT = timeout;
}

export function getConnectionTimeout() {
    return CONNECTION_TIMEOUT;
}

/**
 * Depends on statusCode, determine a request is failed or not
 * @param response http.IncomingMessage
 */
function processResponse(response: Response) {
    if (
        (response.status >= 200 && response.status <= 299) ||
        response.status === 429
    ) {
        return response.status;
    } else {
        throw new BadHttpResponseError(response.statusText, response.status);
    }
}

/**
 * Send head request to the URL
 * Received data will be discarded
 * @param url String: url to be tested
 */
export async function headRequest(
    url: string,
    requestOpts: RequestInit = {}
): Promise<number> {
    return doRequest(url, "head", requestOpts);
}

/**
 * Send head request to the URL
 * Received data will be discarded
 * @param url String: url to be tested
 */
export async function getRequest(
    url: string,
    requestOpts: RequestInit = {}
): Promise<number> {
    return doRequest(url, "get", {
        ...requestOpts,
        headers: {
            Range: "bytes=0-50"
        }
    });
}

/**
 * Send request to the URL
 * Received data will be discarded
 * @param url String: url to be tested
 */
export async function doRequest(
    url: string,
    method: "get" | "head",
    requestOpts: RequestInit = {}
): Promise<number> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort();
    }, CONNECTION_TIMEOUT * 1000);

    console.info(`${method} ${url}`);

    let res: Response;
    try {
        res = await fetch(url, {
            method,
            redirect: "follow",
            headers: {
                ...(requestOpts?.headers ? requestOpts.headers : {}),
                "User-Agent": await getUserAgent()
            },
            signal: controller.signal
        });
        console.info(`Got ${res.status} from ${method} ${url}`);
        return processResponse(res);
    } catch (e) {
        throw e;
    } finally {
        controller.abort();
        clearTimeout(timeout);
    }
}

export class BadHttpResponseError extends Error {
    public httpStatusCode: number;

    constructor(message?: string, httpStatusCode?: number) {
        super(message);
        this.message = message;
        this.httpStatusCode = httpStatusCode;
    }
}
