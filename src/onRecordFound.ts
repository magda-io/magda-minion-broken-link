import _ from "lodash";
import { CoreOptions } from "request";
import { retryBackoff, unionToThrowable } from "@magda/utils";
import {
    AuthorizedRegistryClient as Registry,
    Record
} from "@magda/minion-sdk";
import { getStorageApiResourceAccessUrl } from "@magda/utils";
import { BrokenLinkAspect, RetrieveResult } from "./brokenLinkAspectDef.js";
import FTPHandler from "./FtpHandler.js";
import parseUriSafe from "./parseUriSafe.js";
import {
    headRequest,
    getRequest,
    BadHttpResponseError
} from "./HttpRequests.js";
import getUrlWaitTime from "./getUrlWaitTime.js";
import wait from "./wait.js";
import { buildJwt } from "@magda/utils";

export default async function onRecordFound(
    record: Record,
    registry: Registry,
    storageApiBaseUrl: string,
    datasetBucketName: string,
    jwtSecret: string,
    actionUserId: string,
    retries: number = 1,
    baseRetryDelaySeconds: number = 1,
    domainWaitTimeConfig: { [domain: string]: number } = {},
    requestOpts: CoreOptions = {},
    ftpHandler: FTPHandler = new FTPHandler()
) {
    const distributions: Record[] = [record];
    const dcatDistributionsStringsAspect =
        record?.aspects?.["dcat-distribution-strings"];
    if (!dcatDistributionsStringsAspect) {
        return Promise.resolve();
    }

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
                _.partialRight(getUrlWaitTime, domainWaitTimeConfig),
                requestOpts,
                storageApiBaseUrl,
                datasetBucketName,
                jwtSecret,
                actionUserId
            )
    );

    // Group the checks against their host so that we're only making one request per site simultaneously.
    const brokenLinkChecksByHost: Promise<BrokenLinkSleuthingResult[]>[] = _(
        linkChecks
    )
        .groupBy((check) => check.host)
        .values()
        .map((checks: DistributionLinkCheck[]) =>
            checks.map((check) => check.op)
        )
        .map((checksForHost) =>
            // Make the checks for this host run one after the other but return their results as an array.
            checksForHost.reduce(
                (
                    megaPromise: Promise<BrokenLinkSleuthingResult[]>,
                    promiseLambda: () => Promise<BrokenLinkSleuthingResult>
                ) =>
                    megaPromise.then(
                        (megaResult: BrokenLinkSleuthingResult[]) =>
                            promiseLambda().then((promiseResult) =>
                                megaResult.concat([promiseResult])
                            )
                    ),
                Promise.resolve([])
            )
        )
        .value();

    const checkResultsPerHost: BrokenLinkSleuthingResult[][] =
        await Promise.all(brokenLinkChecksByHost);

    const allResults = _.flatten(checkResultsPerHost);

    const bestResultPerDistribution = _(allResults)
        .groupBy((result) => result.distribution.id)
        .values()
        .map((results: BrokenLinkSleuthingResult[]) =>
            _(results)
                .sortBy((result) => {
                    return (
                        { none: 1, downloadURL: 2, accessURL: 3 }[
                            result.urlType
                        ] || Number.MAX_VALUE
                    );
                })
                .sortBy((result) => {
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
            return recordBrokenLinkAspect(registry, record, result);
        })
    );

    await brokenLinksAspectPromise;
}

function recordBrokenLinkAspect(
    registry: Registry,
    record: Record,
    result: BrokenLinkSleuthingResult
): Promise<Record> {
    const theTenantId = record.tenantId;
    const { errorDetails, ...aspectDataWithNoErrorDetails } = result.aspect;
    const aspectData = errorDetails
        ? {
              ...aspectDataWithNoErrorDetails,
              errorDetails: `${
                  errorDetails.httpStatusCode
                      ? `Http Status Code: ${errorDetails.httpStatusCode}: `
                      : ""
              }${errorDetails}`
          }
        : aspectDataWithNoErrorDetails;

    return registry
        .putRecordAspect(
            result.distribution.id,
            "source-link-status",
            aspectData,
            true,
            theTenantId
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
 * @param getUrlWaitTime The function to use to get the wait time before the next request can be made for a URL
 * @param requestOpts The base options to use for the request library (e.g. timeouts, headers etc)
 */
function checkDistributionLink(
    distribution: Record,
    distStringsAspect: any,
    baseRetryDelay: number,
    retries: number,
    ftpHandler: FTPHandler,
    getUrlWaitTime: (url: string) => number,
    requestOpts: CoreOptions,
    storageApiBaseUrl: string,
    datasetBucketName: string,
    jwtSecret: string,
    actionUserId: string
): DistributionLinkCheck[] {
    type DistURL = {
        url?: URI;
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
        .map((urlObj) => {
            return { ...urlObj, url: parseUriSafe(urlObj.url) };
        })
        .filter((x) => x.url && x.url.protocol().length > 0);

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
                    getUrlWaitTime,
                    requestOpts,
                    storageApiBaseUrl,
                    datasetBucketName,
                    jwtSecret,
                    actionUserId
                )
                    .then((aspect) => {
                        console.info("Finished retrieving  " + parsedURL);
                        return aspect;
                    })
                    .then((aspect) => ({
                        distribution,
                        urlType: type,
                        aspect
                    }))
                    .catch((err) => ({
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
    parsedURL: URI,
    baseRetryDelay: number,
    retries: number,
    ftpHandler: FTPHandler,
    getUrlWaitTime: (url: string) => number,
    requestOpts: CoreOptions,
    storageApiBaseUrl: string,
    datasetBucketName: string,
    jwtSecret: string,
    actionUserId: string
): Promise<BrokenLinkAspect> {
    if (
        parsedURL.protocol() === "http" ||
        parsedURL.protocol() === "https" ||
        (parsedURL.protocol() === "magda" &&
            parsedURL.hostname() === "storage-api")
    ) {
        return retrieveHttp(
            parsedURL.toString(),
            baseRetryDelay,
            retries,
            getUrlWaitTime,
            requestOpts,
            storageApiBaseUrl,
            datasetBucketName,
            jwtSecret,
            actionUserId
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
    parsedURL: URI,
    ftpHandler: FTPHandler
): Promise<BrokenLinkAspect> {
    const port = +(parsedURL.port() || 21);
    const pClient = ftpHandler.getClient(parsedURL.hostname(), port);

    return pClient.then((client) => {
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
 * Retrieves an HTTP/HTTPS url
 *
 * @param url The url to retrieve
 */
async function retrieveHttp(
    url: string,
    baseRetryDelay: number,
    retries: number,
    getUrlWaitTime: (url: string) => number,
    requestOpts: CoreOptions,
    storageApiBaseUrl: string,
    datasetBucketName: string,
    jwtSecret: string,
    actionUserId: string
): Promise<BrokenLinkAspect> {
    const isInternalStorageRes = url.indexOf("magda://storage-api/") === 0;
    const resUrl = getStorageApiResourceAccessUrl(
        url,
        storageApiBaseUrl,
        datasetBucketName
    );
    const runtimeRequestOpts = { ...requestOpts };
    if (requestOpts?.headers) {
        runtimeRequestOpts.headers = {
            ...requestOpts.headers
        };
    }
    if (isInternalStorageRes) {
        if (!runtimeRequestOpts?.headers) {
            runtimeRequestOpts.headers = {};
        }
        runtimeRequestOpts.headers = {
            ...runtimeRequestOpts.headers,
            "X-Magda-Session": buildJwt(jwtSecret, actionUserId)
        };
    }
    async function operation() {
        try {
            await wait(getUrlWaitTime(resUrl));
            return await headRequest(resUrl, runtimeRequestOpts);
        } catch (e) {
            // --- HEAD Method not allowed
            await wait(getUrlWaitTime(resUrl));
            return await getRequest(resUrl, runtimeRequestOpts);
        }
    }

    const onRetry = (err: BadHttpResponseError, retries: number) => {
        console.info(
            `Downloading ${url} failed: ${
                err.httpStatusCode || err
            } (${retries} retries remaining)`
        );
    };

    const innerOp = () =>
        retryBackoff(operation, baseRetryDelay, retries, onRetry);

    const outerOp: () => Promise<BrokenLinkAspect> = () =>
        innerOp().then(
            (code) => {
                if (code === 429) {
                    throw { message: "429 encountered", httpStatusCode: 429 };
                } else {
                    return {
                        status: "active" as "active",
                        httpStatusCode: code
                    };
                }
            },
            (error) => {
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
    ).catch((err) => ({
        status: "unknown" as "unknown",
        errorDetails: err,
        httpStatusCode: 429
    }));
}

interface BrokenLinkSleuthingResult {
    distribution: Record;
    aspect?: BrokenLinkAspect;
    urlType: "downloadURL" | "accessURL" | "none";
}
