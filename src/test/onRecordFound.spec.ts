import {} from "mocha";
import { expect } from "chai";
import sinon from "sinon";
import nock from "nock";
import jsc from "jsverify";
import _ from "lodash";
import Client from "ftp";
import URI from "urijs";
import Ajv from "ajv";

import { Record, AuthorizedRegistryClient } from "@magda/minion-sdk";
import { encodeURIComponentWithApost } from "@magda/utils";
import {
    specificRecordArb,
    distUrlArb,
    arrayOfSizeArb,
    arbFlatMap,
    recordArbWithDistArbs
} from "@magda/arbitraries";

import onRecordFound from "../onRecordFound.js";
import { BrokenLinkAspect } from "../brokenLinkAspectDef.js";
import urlsFromDataSet from "./urlsFromDataSet.js";
import {
    CheckResult,
    recordArbWithSuccesses,
    KNOWN_PROTOCOLS,
    httpOnlyRecordArb,
    failureCodeArb
} from "./arbitraries.js";
import FtpHandler from "../FtpHandler.js";
import parseUriSafe from "../parseUriSafe.js";
import RandomStream from "./RandomStream.js";
import {
    setDefaultDomainWaitTime,
    getDefaultDomainWaitTime
} from "../getUrlWaitTime.js";

const defaultStorageApiBaseUrl = "http://storage-api/v0";
const defaultDatasetBucketName = "magda-datasets";
const jwtSecret = "sdsfsfdsfsddsfsdfdsfds2323432423";
const actionUserId = "user-id-1";
const schema = require("@magda/registry-aspects/source-link-status.schema.json");

describe("onRecordFound", function (this: Mocha.Suite) {
    this.timeout(20000);
    nock.disableNetConnect();
    const registryUrl = "http://example.com";
    const secret = "secret!";
    const registry = new AuthorizedRegistryClient({
        baseUrl: registryUrl,
        jwtSecret: secret,
        userId: "1",
        maxRetries: 0,
        tenantId: 1
    });
    let registryScope: nock.Scope;
    let clients: { [s: string]: Client[] };
    let ftpSuccesses: { [url: string]: CheckResult };
    const orignalDefaultDomainWaitTime: number = getDefaultDomainWaitTime();

    before(() => {
        // --- set default domain wait time to 0 second (i.e. for any domains that has no specific setting)
        // --- Otherwise, it will take too long to complete property tests
        setDefaultDomainWaitTime(0);

        sinon.stub(console, "info");
        nock.disableNetConnect();

        nock.emitter.on("no match", onMatchFail);
    });

    const onMatchFail = (req: any, interceptor: any) => {
        console.error(
            `Match failure: ${req.method ? req.method : interceptor.method} ${
                req.host ? req.host : interceptor.host
            }${req.path}`
        );
    };

    after(() => {
        setDefaultDomainWaitTime(orignalDefaultDomainWaitTime);

        (console.info as any).restore();

        nock.emitter.removeListener("no match", onMatchFail);
    });

    const beforeEachProperty = () => {
        registryScope = nock(registryUrl); //.log(console.log);
        clients = {};
        ftpSuccesses = {};
    };

    const afterEachProperty = () => {
        nock.cleanAll();
    };

    /**
     * Builds FTP clients that have all their important methods stubbed out - these
     * will respond based on the current content of ftpSuccesses.
     */
    const clientFactory = () => {
        const client = new Client();
        let readyCallback: () => void;
        let key: string;
        sinon
            .stub(client, "connect")
            .callsFake(({ host, port }: Client.Options) => {
                const keyPort = port !== 21 ? `:${port}` : "";
                key = `${host}${keyPort}`;
                if (!clients[key]) {
                    clients[key] = [];
                }
                clients[key].push(client);
                readyCallback();
            });
        sinon
            .stub(client, "on")
            .callsFake((event: string | symbol, callback: () => void) => {
                if (event === "ready") {
                    readyCallback = callback;
                }
                return client;
            });
        sinon.stub(client, "list").callsFake(((
            path: string,
            callback: (err: Error, list: string[]) => void
        ) => {
            try {
                expect(key).not.to.be.undefined;
                const url = `ftp://${key}${path}`;

                const success = ftpSuccesses[url];
                expect(success).not.to.be.undefined;

                if (success === "success") {
                    callback(null, ["file"]);
                } else if (success === "notfound") {
                    callback(null, []);
                } else {
                    callback(new Error("Fake error!"), null);
                }
            } catch (e) {
                console.error(e);
                callback(e as Error, null);
            }
        }) as any);
        return client;
    };

    const fakeFtpHandler = new FtpHandler(clientFactory);

    /**
     * Generator-driven super-test: generates records and runs them through the
     * onRecordFound function, listening for HTTP and FTP calls made and returning
     * success or failure based on generated outcomes, then checks that they're
     * recorded on a by-distribution basis as link status as well as on a by-record
     * basis as a part of dataset quality.
     */
    it("Should correctly record link statuses", function () {
        const ajv = new Ajv();
        const validate = ajv.compile(schema);
        return jsc.assert(
            jsc.forall(
                recordArbWithSuccesses,
                jsc.integer(1, 100),
                function (
                    { record, successLookup, disallowHead },
                    streamWaitTime
                ) {
                    beforeEachProperty();

                    // Tell the FTP server to return success/failure for the various FTP
                    // paths with this dodgy method. Note that because the FTP server can
                    // only see paths and not host, we only send it the path of the req.
                    ftpSuccesses = _.pickBy(successLookup, (value, url) =>
                        hasProtocol(url, "ftp")
                    );

                    const allDists =
                        record.aspects["dataset-distributions"].distributions;

                    const httpDistUrls = _(urlsFromDataSet(record))
                        .filter((url: string) => hasProtocol(url, "http"))
                        .map((url: string) => ({
                            url,
                            success: successLookup[url]
                        }))
                        .value();

                    // Set up a nock scope for every HTTP URL - the minion will actually
                    // attempt to download these but it'll be intercepted by nock.
                    const distScopes = httpDistUrls.map(
                        ({
                            url,
                            success
                        }: {
                            url: string;
                            success: CheckResult;
                        }) => {
                            const scope = nock(url, {
                                reqheaders: { "User-Agent": /magda.*/ }
                            });

                            const scopeHead = scope.head(
                                url.endsWith("/") ? "/" : ""
                            );
                            const scopeGet = scope.get(
                                url.endsWith("/") ? "/" : ""
                            );

                            if (success !== "error") {
                                if (!disallowHead && success === "success") {
                                    scopeHead.reply(200);
                                } else {
                                    if (disallowHead) {
                                        // Not everything returns a 405 for HEAD not allowed :()
                                        scopeHead.reply(
                                            success === "success" ? 405 : 400
                                        );
                                    } else {
                                        scopeHead.replyWithError("fail");
                                    }

                                    if (success === "success") {
                                        scopeGet.reply(200, () => {
                                            const s = new RandomStream(
                                                streamWaitTime
                                            );

                                            return s;
                                        });
                                    } else {
                                        scopeGet.reply(404);
                                    }
                                }
                            } else {
                                scopeHead.replyWithError("fail");
                                scopeGet.replyWithError("fail");
                            }

                            return scope;
                        }
                    );

                    allDists.forEach((dist: Record) => {
                        const { downloadURL, accessURL } =
                            dist.aspects["dcat-distribution-strings"];
                        const success =
                            successLookup[downloadURL] === "success"
                                ? "success"
                                : successLookup[accessURL];

                        const isUnknownProtocol = (url: string) => {
                            if (!url) {
                                return false;
                            }
                            const protocol = new URI(url).protocol();
                            return (
                                protocol &&
                                protocol.length > 0 &&
                                KNOWN_PROTOCOLS.indexOf(protocol) === -1
                            );
                        };

                        const downloadUnknown = isUnknownProtocol(downloadURL);
                        const accessUnknown = isUnknownProtocol(accessURL);

                        const result =
                            success === "success"
                                ? "active"
                                : downloadUnknown || accessUnknown
                                  ? "unknown"
                                  : "broken";

                        registryScope
                            .put(
                                `/records/${encodeURIComponentWithApost(
                                    dist.id
                                )}/aspects/source-link-status?merge=true`,
                                (body: BrokenLinkAspect) => {
                                    const validationResult = validate(body);
                                    if (!validationResult) {
                                        throw new Error(
                                            "Json schema validation error: \n" +
                                                validate.errors
                                                    .map(
                                                        (error) =>
                                                            `${error.dataPath}: ${error.message}`
                                                    )
                                                    .join("\n")
                                        );
                                    }

                                    const doesStatusMatch =
                                        body.status === result;

                                    const isDownloadUrlHttp = hasProtocol(
                                        downloadURL,
                                        "http"
                                    );
                                    const isAccessUrlHttp = hasProtocol(
                                        accessURL,
                                        "http"
                                    );

                                    const isDownloadUrlHttpSuccess =
                                        isDownloadUrlHttp &&
                                        successLookup[downloadURL] ===
                                            "success";

                                    const isDownloadUrlFtpSuccess =
                                        !isDownloadUrlHttp &&
                                        successLookup[downloadURL] ===
                                            "success";

                                    const isAccessURLHttpSuccess =
                                        isAccessUrlHttp &&
                                        successLookup[accessURL] === "success";

                                    const isHttpSuccess: boolean =
                                        isDownloadUrlHttpSuccess ||
                                        (!isDownloadUrlFtpSuccess &&
                                            isAccessURLHttpSuccess);

                                    const downloadUri =
                                        parseUriSafe(downloadURL);
                                    const isDownloadUrlDefined =
                                        _.isUndefined(downloadUri) ||
                                        !downloadUri.scheme() ||
                                        parseUriSafe(downloadURL).scheme()
                                            .length === 0;

                                    const is404: boolean =
                                        result === "broken" &&
                                        ((isDownloadUrlHttp &&
                                            successLookup[downloadURL] ===
                                                "notfound") ||
                                            (isDownloadUrlDefined &&
                                                isAccessUrlHttp &&
                                                successLookup[accessURL] ===
                                                    "notfound"));

                                    const doesResponseCodeMatch = ((
                                        code?: number
                                    ) => {
                                        if (isHttpSuccess) {
                                            return code === 200;
                                        } else if (is404) {
                                            return code === 404;
                                        } else {
                                            return _.isUndefined(code);
                                        }
                                    })(body.httpStatusCode);

                                    const doesErrorMatch = ((arg?: Error) =>
                                        success === "success"
                                            ? _.isUndefined(arg)
                                            : !_.isUndefined(arg))(
                                        body.errorDetails
                                    );

                                    // console.log(
                                    //     `${
                                    //         dist.id
                                    //     }: ${doesStatusMatch} && ${doesResponseCodeMatch} && ${doesErrorMatch} `
                                    // );

                                    return (
                                        doesStatusMatch &&
                                        doesResponseCodeMatch &&
                                        doesErrorMatch
                                    );
                                }
                            )
                            .reply(201);
                    });

                    const allOnRecordsTasks = allDists.map((dist: Record) =>
                        onRecordFound(
                            dist,
                            registry,
                            defaultStorageApiBaseUrl,
                            defaultDatasetBucketName,
                            jwtSecret,
                            actionUserId,
                            0,
                            0,
                            {},
                            {},
                            fakeFtpHandler
                        )
                    );

                    return Promise.all(allOnRecordsTasks)
                        .then(() => {
                            distScopes.forEach((scope) => scope.done());
                            registryScope.done();
                        })
                        .then(() => {
                            afterEachProperty();
                            return true;
                        })
                        .catch((e) => {
                            afterEachProperty();
                            throw e;
                        });
                }
            ),
            {
                tests: 50
            }
        );
    });

    /**
     * Runs onRecordFound with a number of failing codes, testing whether the
     * minion retries the correct number of times, and whether it correctly
     * records a success after retries or a failure after the retries run out.
     *
     * This tests both 429 retries and other retries - this involves different
     * behaviour as the retry for 429 (which indicates rate limiting) require
     * a much longer cool-off time and hence are done differently.
     *
     * @param caption The caption to use for the mocha "it" call.
     * @param result Whether to test for a number of retries then a success, a
     *                number of retries then a failure because of too many 429s,
     *                or a number of retries then a failure because of too many
     *                non-429 failures (e.g. 404s)
     */
    const retrySpec = (
        caption: string,
        result: "success" | "fail429" | "failNormal"
    ) => {
        it(caption, function () {
            const retryCountArb = jsc.integer(0, 5);

            type FailuresArbResult = {
                retryCount: number;
                allResults: number[][];
            };

            /**
             * Generates a retryCount and a nested array of results to return to the
             * minion - the inner arrays are status codes to be returned (in order),
             * after each inner array is finished a 429 will be returned, then the
             * next array of error codes will be returned.
             */
            const failuresArb: jsc.Arbitrary<FailuresArbResult> = arbFlatMap<
                number,
                FailuresArbResult
            >(
                retryCountArb,
                (retryCount: number) => {
                    /** Generates how many 429 codes will be returned */
                    const count429Arb =
                        result === "fail429"
                            ? jsc.constant(retryCount)
                            : jsc.integer(0, retryCount);

                    /** Generates how long the array of non-429 failures should be. */
                    const failureCodeLengthArb = jsc.integer(0, retryCount);

                    const allResultsArb = arbFlatMap<number, number[]>(
                        count429Arb,
                        (count429s) =>
                            arrayOfSizeArb(count429s + 1, failureCodeLengthArb),
                        (failureCodeArr: number[]) => failureCodeArr.length
                    ).flatMap<number[][]>(
                        (failureCodeArrSizes: number[]) => {
                            const failureCodeArbs = failureCodeArrSizes.map(
                                (size) => arrayOfSizeArb(size, failureCodeArb)
                            );

                            if (result === "failNormal") {
                                failureCodeArbs[failureCodeArbs.length - 1] =
                                    arrayOfSizeArb(
                                        retryCount + 1,
                                        failureCodeArb
                                    );
                            }

                            return failureCodeArrSizes.length > 0
                                ? jsc.tuple(failureCodeArbs)
                                : jsc.constant([]);
                        },
                        (failures) => failures.map((inner) => inner.length)
                    );

                    const combined = jsc.record<FailuresArbResult>({
                        retryCount: jsc.constant(retryCount),
                        allResults: allResultsArb
                    });

                    return combined;
                },
                ({ retryCount }: FailuresArbResult) => {
                    return retryCount;
                }
            );

            return jsc.assert(
                jsc.forall(
                    httpOnlyRecordArb,
                    failuresArb,
                    (
                        record: Record,
                        { retryCount, allResults }: FailuresArbResult
                    ) => {
                        beforeEachProperty();

                        const distScopes = urlsFromDataSet(record).map(
                            (url) => {
                                const scope = nock(url); //.log(console.log);

                                allResults.forEach((failureCodes, i) => {
                                    failureCodes.forEach((failureCode) => {
                                        scope
                                            .head(url.endsWith("/") ? "/" : "")
                                            .reply(failureCode);

                                        scope
                                            .get(url.endsWith("/") ? "/" : "")
                                            .reply(failureCode);
                                    });
                                    if (
                                        i < allResults.length - 1 ||
                                        result === "fail429"
                                    ) {
                                        scope
                                            .head(url.endsWith("/") ? "/" : "")
                                            .reply(429);
                                    }
                                });

                                if (result === "success") {
                                    scope
                                        .head(url.endsWith("/") ? "/" : "")
                                        .reply(200);
                                }

                                return scope;
                            }
                        );

                        const allDists =
                            record.aspects["dataset-distributions"]
                                .distributions;

                        allDists.forEach((dist: Record) => {
                            registryScope
                                .put(
                                    `/records/${encodeURIComponentWithApost(
                                        dist.id
                                    )}/aspects/source-link-status?merge=true`,
                                    (response: any) => {
                                        const statusMatch =
                                            response.status ===
                                            {
                                                success: "active",
                                                failNormal: "broken",
                                                fail429: "unknown"
                                            }[result];
                                        const codeMatch =
                                            !_.isUndefined(
                                                response.httpStatusCode
                                            ) &&
                                            response.httpStatusCode ===
                                                {
                                                    success: 200,
                                                    failNormal: _.last(
                                                        _.last(allResults)
                                                    ),
                                                    fail429: 429
                                                }[result];

                                        return statusMatch && codeMatch;
                                    }
                                )
                                .reply(201);
                        });

                        return Promise.all(
                            allDists.map((dist: Record) =>
                                onRecordFound(
                                    dist,
                                    registry,
                                    defaultStorageApiBaseUrl,
                                    defaultDatasetBucketName,
                                    jwtSecret,
                                    actionUserId,
                                    retryCount,
                                    0
                                )
                            )
                        )
                            .then(() => {
                                registryScope.done();
                                distScopes.forEach((scope) => scope.done());
                            })
                            .then(() => {
                                afterEachProperty();
                                return true;
                            })
                            .catch((e) => {
                                afterEachProperty();
                                throw e;
                            });
                    }
                ),
                {
                    tests: 10
                }
            );
        });
    };

    retrySpec(
        "Should result in success if the last retry is successful",
        "success"
    );
    retrySpec(
        "Should result in failures if the max number of retries is exceeded",
        "failNormal"
    );
    retrySpec(
        "Should result in failures if the max number of 429s is exceeded",
        "fail429"
    );

    it("Should only try to make one request per host at a time", function () {
        const urlArb = (jsc as any).nonshrink(
            distUrlArb({
                schemeArb: jsc.elements(["http", "https"]),
                hostArb: jsc.elements(["example1", "example2", "example3"])
            })
        );

        const thisRecordArb = jsc.suchthat(
            recordArbWithDistArbs({ url: urlArb }),
            (record) => {
                const urls: string[] = urlsFromDataSet(record);
                const hosts: string[] = urls.map((url) => {
                    const uri = new URI(url);

                    return uri.scheme() + "://" + uri.host();
                });

                return !_.isEqual(_.uniq(hosts), hosts);
            }
        );

        return jsc.assert(
            jsc.forall(
                thisRecordArb,
                jsc.nearray(failureCodeArb),
                jsc.integer(0, 25),
                (record: Record, failures: number[], delayMs: number) => {
                    beforeEachProperty();

                    const delayConfig = {} as any;

                    const distScopes = urlsFromDataSet(record).reduce(
                        (scopeLookup, url) => {
                            const uri = new URI(url);
                            const base = uri.scheme() + "://" + uri.host();
                            delayConfig[uri.hostname()] = (delayMs + 10) / 1000;

                            if (!scopeLookup[base]) {
                                scopeLookup[base] = nock(base);
                            }

                            const scope = scopeLookup[base];

                            failures.forEach((failureCode) => {
                                scope
                                    .head(uri.path())
                                    .delay(delayMs)
                                    .reply(failureCode);

                                scope
                                    .get(uri.path())
                                    .delay(delayMs)
                                    .reply(failureCode);
                            });

                            scope.head(uri.path()).delay(delayMs).reply(200);
                            return scopeLookup;
                        },
                        {} as { [host: string]: nock.Scope }
                    );

                    _.forEach(distScopes, (scope: nock.Scope, host: string) => {
                        let countForThisScope = 0;

                        scope.on("request", () => {
                            countForThisScope++;
                            expect(countForThisScope).to.equal(1);
                        });

                        scope.on("replied", () => {
                            countForThisScope--;
                            expect(countForThisScope).to.equal(0);
                        });
                    });

                    const allDists =
                        record.aspects["dataset-distributions"].distributions;

                    registryScope.put(/.*/).times(allDists.length).reply(201);

                    return Promise.all(
                        allDists.map((dist: Record) =>
                            onRecordFound(
                                dist,
                                registry,
                                defaultStorageApiBaseUrl,
                                defaultDatasetBucketName,
                                jwtSecret,
                                actionUserId,
                                failures.length,
                                0,
                                delayConfig
                            )
                        )
                    )
                        .then(() => {
                            _.values(distScopes).forEach((scope) =>
                                scope.done()
                            );
                        })
                        .then(() => {
                            afterEachProperty();
                            return true;
                        })
                        .catch((e: any) => {
                            afterEachProperty();
                            throw e;
                        });
                }
            ),
            {
                tests: 10
            }
        );
    });

    const emptyRecordArb = jsc.oneof([
        specificRecordArb({
            "dcat-dataset-strings": jsc.constant({})
        }),
        specificRecordArb({})
    ]);

    jsc.property(
        "Should do nothing if no distributions",
        emptyRecordArb,
        (record: Record) => {
            beforeEachProperty();

            return onRecordFound(
                record,
                registry,
                defaultStorageApiBaseUrl,
                defaultDatasetBucketName,
                jwtSecret,
                actionUserId
            ).then(() => {
                afterEachProperty();

                registryScope.done();
                return true;
            });
        }
    );
});

function hasProtocol(url: string, protocol: string) {
    const uri = parseUriSafe(url);

    return uri && uri.protocol().startsWith(protocol);
}
