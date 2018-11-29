import * as _ from "lodash";
import request from "@magda/typescript-common/dist/request";
import * as http from "http";

import retryBackoff from "@magda/typescript-common/dist/retryBackoff";
import Registry from "@magda/typescript-common/dist/registry/AuthorizedRegistryClient";
import { Record } from "@magda/typescript-common/dist/generated/registry/api";
import unionToThrowable from "@magda/typescript-common/dist/util/unionToThrowable";
import { BrokenLinkAspect, RetrieveResult } from "./brokenLinkAspectDef";
import FTPHandler from "./FtpHandler";
import parseUriSafe from "./parseUriSafe";
import * as URI from "urijs";

const DevNull = require("dev-null");

// --- for domain without specified wait time,
// --- this default value (in second) will be used.
const defaultDomainWaitTime = 1;
// --- record next access time (i.e. no request can be made before the time)
// --- for all domains (only create entries on domain access)
const domainAccessTimeStore: any = {};

function getHostWaitTime(host: string, domainWaitTimeConfig: any) {
    if (
        domainWaitTimeConfig[host] &&
        typeof domainWaitTimeConfig[host] === "number"
    ) {
        return domainWaitTimeConfig[host];
    }
    return defaultDomainWaitTime;
}

/**
 * For given url, return the required waitTime (in milliseconds) from now before the request can be sent.
 * This value can be used to set a timer to trigger the request at the later time.
 *
 * @param url String: the url that to be tested
 * @param domainWaitTimeConfig object: domainWaitTimeConfig
 */
function getUrlWaitTime(url: string, domainWaitTimeConfig: any) {
    const uri = new URI(url);
    const host = uri.hostname();
    const hostWaitTime = getHostWaitTime(host, domainWaitTimeConfig);
    const now = new Date().getTime();
    if (domainAccessTimeStore[host]) {
        if (domainAccessTimeStore[host] < now) {
            // --- allow to request now & need to set the new wait time
            domainAccessTimeStore[host] = now + hostWaitTime * 1000;
            return 0; //--- no need to wait
        } else {
            // --- need to wait
            domainAccessTimeStore[host] += hostWaitTime * 1000;
            // --- wait time should be counted from now
            return domainAccessTimeStore[host] - now;
        }
    } else {
        // --- first request && allow to request now
        domainAccessTimeStore[host] = now + hostWaitTime * 1000;
        return 0; //--- no need to wait
    }
}

export default async function onRecordFound(
    record: Record,
    registry: Registry,
    retries: number = 1,
    baseRetryDelaySeconds: number = 1,
    ftpHandler: FTPHandler = new FTPHandler(),
    domainWaitTimeConfig: object = {}
) {
    const distributions: Record[] =
        record.aspects["dataset-distributions"] &&
        record.aspects["dataset-distributions"].distributions;

    if (!distributions || distributions.length === 0) {
        return Promise.resolve();
    }

    // Check each link
    const linkChecks: DistributionLinkCheck[] = _.flatMap(
        distributions,
        (distribution: Record) =>
            checkDistributionLink(
                distribution,
                distribution.aspects["dcat-distribution-strings"],
                baseRetryDelaySeconds,
                retries,
                ftpHandler,
                _.partialRight(getUrlWaitTime, domainWaitTimeConfig)
            )
    );

    // Group the checks against their host so that we're only making one request per site simultaneously.
    const brokenLinkChecksByHost: Promise<BrokenLinkSleuthingResult[]>[] = _(
        linkChecks
    )
        .groupBy(check => check.host)
        .values()
        .map((checks: DistributionLinkCheck[]) => checks.map(check => check.op))
        .map(checksForHost =>
            // Make the checks for this host run one after the other but return their results as an array.
            checksForHost.reduce(
                (
                    megaPromise: Promise<BrokenLinkSleuthingResult[]>,
                    promiseLambda: () => Promise<BrokenLinkSleuthingResult>
                ) =>
                    megaPromise.then(
                        (megaResult: BrokenLinkSleuthingResult[]) =>
                            promiseLambda().then(promiseResult =>
                                megaResult.concat([promiseResult])
                            )
                    ),
                Promise.resolve([])
            )
        )
        .value();

    const checkResultsPerHost: BrokenLinkSleuthingResult[][] = await Promise.all(
        brokenLinkChecksByHost
    );

    const allResults = _.flatten(checkResultsPerHost);

    const bestResultPerDistribution = _(allResults)
        .groupBy(result => result.distribution.id)
        .values()
        .map((results: BrokenLinkSleuthingResult[]) =>
            _(results)
                .sortBy(result => {
                    return (
                        { none: 1, downloadURL: 2, accessURL: 3 }[
                            result.urlType
                        ] || Number.MAX_VALUE
                    );
                })
                .sortBy(result => {
                    return (
                        { active: 1, unknown: 2, broken: 3 }[
                            result.aspect.status
                        ] || Number.MAX_VALUE
                    );
                })
                .head()
        )
        .value();

    // Record a broken links aspect for each distribution.
    const brokenLinksAspectPromise = Promise.all(
        bestResultPerDistribution.map((result: BrokenLinkSleuthingResult) => {
            return recordBrokenLinkAspect(registry, result);
        })
    );

    await brokenLinksAspectPromise;
}

function recordBrokenLinkAspect(
    registry: Registry,
    result: BrokenLinkSleuthingResult
): Promise<Record> {
    return registry
        .putRecordAspect(
            result.distribution.id,
            "source-link-status",
            result.aspect
        )
        .then(unionToThrowable);
}

type DistributionLinkCheck = {
    host?: string;
    op: () => Promise<BrokenLinkSleuthingResult>;
};

/**
 * Checks a distribution's URL. Returns a tuple of the distribution's host and a no-arg function that when executed will fetch the url, returning a promise.
 *
 * @param distribution The distribution Record
 * @param distStringsAspect The dcat-distributions-strings aspect for this distribution
 * @param baseRetryDelay The first amount of time that will be waited between retries - it increases exponentially on subsequent retries
 * @param retries Number of retries before giving up
 * @param ftpHandler The FTP handler to use for FTP addresses
 */
function checkDistributionLink(
    distribution: Record,
    distStringsAspect: any,
    baseRetryDelay: number,
    retries: number,
    ftpHandler: FTPHandler,
    getUrlWaitTime: (url: string) => number
): DistributionLinkCheck[] {
    type DistURL = {
        url?: uri.URI;
        type: "downloadURL" | "accessURL";
    };

    const urls: DistURL[] = [
        {
            url: distStringsAspect.downloadURL as string,
            type: "downloadURL" as "downloadURL"
        },
        {
            url: distStringsAspect.accessURL as string,
            type: "accessURL" as "accessURL"
        }
    ]
        .map(urlObj => ({ ...urlObj, url: parseUriSafe(urlObj.url) }))
        .filter(x => x.url && x.url.protocol().length > 0);

    if (urls.length === 0) {
        return [
            {
                op: () =>
                    Promise.resolve({
                        distribution,
                        urlType: "none" as "none",
                        aspect: {
                            status: "broken" as RetrieveResult,
                            errorDetails: new Error(
                                "No distribution urls to check."
                            )
                        }
                    })
            }
        ];
    }

    return urls.map(({ type, url: parsedURL }) => {
        return {
            host: (parsedURL && parsedURL.host()) as string,
            op: () => {
                console.info("Retrieving " + parsedURL);

                return retrieve(
                    parsedURL,
                    baseRetryDelay,
                    retries,
                    ftpHandler,
                    getUrlWaitTime
                )
                    .then(aspect => {
                        console.info("Finished retrieving  " + parsedURL);
                        return aspect;
                    })
                    .then(aspect => ({
                        distribution,
                        urlType: type,
                        aspect
                    }))
                    .catch(err => ({
                        distribution,
                        urlType: type,
                        aspect: {
                            status: "broken" as RetrieveResult,
                            errorDetails: err
                        }
                    })) as Promise<BrokenLinkSleuthingResult>;
            }
        };
    });
}

function retrieve(
    parsedURL: uri.URI,
    baseRetryDelay: number,
    retries: number,
    ftpHandler: FTPHandler,
    getUrlWaitTime: (url: string) => number
): Promise<BrokenLinkAspect> {
    if (parsedURL.protocol() === "http" || parsedURL.protocol() === "https") {
        return retrieveHttp(
            parsedURL.toString(),
            baseRetryDelay,
            retries,
            getUrlWaitTime
        );
    } else if (parsedURL.protocol() === "ftp") {
        return retrieveFtp(parsedURL, ftpHandler);
    } else {
        console.info(`Unrecognised URL: ${parsedURL.toString()}`);
        return Promise.resolve({
            status: "unknown" as "unknown",
            errorDetails: new Error(
                "Could not check protocol " + parsedURL.protocol()
            )
        });
    }
}

function retrieveFtp(
    parsedURL: uri.URI,
    ftpHandler: FTPHandler
): Promise<BrokenLinkAspect> {
    const port = +(parsedURL.port() || 21);
    const pClient = ftpHandler.getClient(parsedURL.hostname(), port);

    return pClient.then(client => {
        return new Promise<BrokenLinkAspect>((resolve, reject) => {
            client.list(parsedURL.path(), (err, list) => {
                if (err) {
                    reject(err);
                } else if (list.length === 0) {
                    reject(
                        new Error(`File "${parsedURL.toString()}" not found`)
                    );
                } else {
                    resolve({ status: "active" as "active" });
                }
            });
        });
    });
}

/**
 * Wait for `waitMilliSeconds` before resolve the promise
 */
function wait(waitMilliSeconds: number) {
    return new Promise((resolve, reject) => {
        setTimeout(() => resolve(), waitMilliSeconds);
    });
}

/**
 * Depends on statusCode, determine a request is failed or not
 * @param response http.IncomingMessage
 */
function processResponse(response: http.IncomingMessage) {
    if (
        (response.statusCode >= 200 && response.statusCode <= 299) ||
        response.statusCode === 429
    ) {
        return response.statusCode;
    } else {
        throw new BadHttpResponseError(
            response.statusMessage,
            response,
            response.statusCode
        );
    }
}

/**
 * Send head request to the URL
 * Received data will be discarded
 * @param url String: url to be tested
 */
function headRequest(url: string): Promise<number> {
    return new Promise((resolve, reject) => {
        request
            .head(url)
            .on("error", err => reject(err))
            .on("response", (response: http.IncomingMessage) => {
                try {
                    resolve(processResponse(response));
                } catch (e) {
                    reject(e);
                }
            })
            .pipe(DevNull());
    });
}

/**
 * Send head request to the URL
 * Received data will be discarded
 * @param url String: url to be tested
 */
function getRequest(url: string): Promise<number> {
    return new Promise((resolve, reject) => {
        request
            .get(url, {
                headers: {
                    Range: "bytes=0-50"
                }
            })
            .on("error", err => reject(err))
            .on("response", (response: http.IncomingMessage) => {
                try {
                    resolve(processResponse(response));
                } catch (e) {
                    reject(e);
                }
            })
            .pipe(DevNull());
    });
}

/**
 * Retrieves an HTTP/HTTPS url
 *
 * @param url The url to retrieve
 */
async function retrieveHttp(
    url: string,
    baseRetryDelay: number,
    retries: number,
    getUrlWaitTime: (url: string) => number
): Promise<BrokenLinkAspect> {
    async function operation() {
        try {
            await wait(getUrlWaitTime(url));
            return await headRequest(url);
        } catch (e) {
            if (e.httpStatusCode && e.httpStatusCode === 405) {
                // --- HEAD Method not allowed
                await wait(getUrlWaitTime(url));
                return await getRequest(url);
            }
            throw e;
        }
    }

    const onRetry = (err: BadHttpResponseError, retries: number) => {
        console.info(
            `Downloading ${url} failed: ${err.httpStatusCode ||
                err} (${retries} retries remaining)`
        );
    };

    const innerOp = () =>
        retryBackoff(operation, baseRetryDelay, retries, onRetry);

    const outerOp: () => Promise<BrokenLinkAspect> = () =>
        innerOp().then(
            code => {
                if (code === 429) {
                    throw new Error("429 encountered");
                } else {
                    return {
                        status: "active" as "active",
                        httpStatusCode: code
                    };
                }
            },
            error => {
                return {
                    status: "broken" as "broken",
                    httpStatusCode: error.httpStatusCode,
                    errorDetails: error
                };
            }
        );

    return retryBackoff(
        outerOp,
        baseRetryDelay,
        retries,
        onRetry,
        (x: number) => x * 5
    ).catch(err => ({
        status: "unknown" as "unknown",
        errorDetails: err,
        httpStatusCode: 429
    }));
}

class BadHttpResponseError extends Error {
    public response: http.IncomingMessage;
    public httpStatusCode: number;

    constructor(
        message?: string,
        response?: http.IncomingMessage,
        httpStatusCode?: number
    ) {
        super(message);
        this.message = message;
        this.response = response;
        this.httpStatusCode = httpStatusCode;
        this.stack = new Error().stack;
    }
}

interface BrokenLinkSleuthingResult {
    distribution: Record;
    aspect?: BrokenLinkAspect;
    urlType: "downloadURL" | "accessURL" | "none";
}
