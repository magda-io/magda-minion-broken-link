import {} from "mocha";
import { expect } from "chai";
import sinon from "sinon";
import nock from "nock";
import _ from "lodash";
import Ajv from "ajv";
import urijs from "urijs";

import { Record, AuthorizedRegistryClient } from "@magda/minion-sdk";
import { encodeURIComponentWithApost } from "@magda/utils";

import onRecordFound from "../onRecordFound.js";
import { BrokenLinkAspect } from "../brokenLinkAspectDef.js";
import {
    setDefaultDomainWaitTime,
    getDefaultDomainWaitTime
} from "../getUrlWaitTime.js";
import { buildJwt } from "@magda/utils";

const defaultStorageApiBaseUrl = "http://storage-api/v0";
const defaultDatasetBucketName = "magda-datasets";
const jwtSecret = "sdsfsfdsfsddsfsdfdsfds2323432423";
const actionUserId = "user-id-1";
const schema = require("@magda/registry-aspects/source-link-status.schema.json");

describe("Test Internal Storage URL", function (this: Mocha.Suite) {
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
            `Match failure. \n Req: ${req.method} ${req.host}${req.path} \n interceptor: ${interceptor.href}`
        );
    };

    after(() => {
        setDefaultDomainWaitTime(orignalDefaultDomainWaitTime);

        (console.info as any).restore();

        nock.emitter.removeListener("no match", onMatchFail);
    });

    beforeEach(() => {
        registryScope = nock(registryUrl); //.log(console.log);
    });

    afterEach(() => {
        nock.cleanAll();
    });

    /**
     * Generator-driven super-test: generates records and runs them through the
     * onRecordFound function, listening for HTTP and FTP calls made and returning
     * success or failure based on generated outcomes, then checks that they're
     * recorded on a by-distribution basis as link status as well as on a by-record
     * basis as a part of dataset quality.
     */
    it("Should correctly record link statuses", async () => {
        const ajv = new Ajv();
        const validate = ajv.compile(schema);

        const testRecord: Record = {
            id: "dist-1",
            name: "Test Record",
            sourceTag: "test-source",
            tenantId: 1,
            aspects: {
                "dcat-distribution-strings": {
                    accessURL: "magda://storage-api/ds-1/dist-1/test-file1.pdf"
                }
            }
        };

        const defaultStorageApiBaseUri = urijs(defaultStorageApiBaseUrl);
        const jwt = buildJwt(jwtSecret, actionUserId);
        const storageApiScope = nock(
            defaultStorageApiBaseUri.clone().path("").toString(),
            {
                reqheaders: {
                    "X-Magda-Session": jwt
                }
            }
        );
        storageApiScope
            .head(
                `${defaultStorageApiBaseUri.path()}/${defaultDatasetBucketName}/ds-1/dist-1/test-file1.pdf`
            )
            .reply(200);

        ["dist-1"].forEach((distId) => {
            registryScope
                .put(
                    `/records/${encodeURIComponentWithApost(
                        distId
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
                        console.log(body);
                        expect(body.status).to.equal("active");
                        return true;
                    }
                )
                .reply(201);
        });

        await onRecordFound(
            testRecord,
            registry,
            defaultStorageApiBaseUrl,
            defaultDatasetBucketName,
            jwtSecret,
            actionUserId,
            0,
            0,
            {},
            {}
        );

        registryScope.done();
        storageApiScope.done();
    });
});
