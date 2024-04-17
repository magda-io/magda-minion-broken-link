import minion, { commonYargs } from "@magda/minion-sdk";
import onRecordFound from "./onRecordFound.js";
import brokenLinkAspectDef from "./brokenLinkAspectDef.js";
import { CoreOptions } from "request";
import { coerceJson } from "@magda/utils";

const ID = "minion-broken-link";

const argv = commonYargs(6111, "http://localhost:6111", (argv) =>
    argv
        .option("externalRetries", {
            describe:
                "Number of times to retry external links when checking whether they're broken",
            type: "number",
            default: 1
        })
        .option("domainWaitTimeConfig", {
            describe:
                "A object that defines wait time for each of domain. " +
                "Echo property name of the object would be the domain name and property value is the wait time in seconds",
            coerce: coerceJson("domainWaitTimeConfig"),
            default: process.env.DOMAIN_WAIT_TIME_CONFIG || JSON.stringify({})
        })
        .option("requestOpts", {
            describe:
                "The default options to use for the JS request library when making HTTP HEAD/GET requests",
            type: "string",
            coerce: coerceJson("requestOpts"),
            default:
                process.env.REQUEST_OPTS || JSON.stringify({ timeout: 20000 })
        })
        .option("storageApiBaseUrl", {
            describe:
                "The base URL of the storage API to use when generating access URLs for internal stored resources",
            type: "string",
            default: process.env.STORAGE_API_BASE_URL || "http://storage-api/v0"
        })
        .option("datasetBucketName", {
            describe:
                "The name of the storage bucket where all dataset files are stored.",
            type: "string",
            default: process.env.DATASET_BUCKET_NAME || "magda-datasets"
        })
);

console.log(
    "domainWaitTimeConfig: ",
    JSON.stringify(argv.domainWaitTimeConfig as any, null, 2)
);

function sleuthBrokenLinks() {
    return minion({
        argv,
        id: ID,
        aspects: ["dcat-distribution-strings"],
        optionalAspects: [],
        async: true,
        writeAspectDefs: [brokenLinkAspectDef],
        dereference: false,
        onRecordFound: (record, registry) =>
            onRecordFound(
                record,
                registry,
                argv.storageApiBaseUrl,
                argv.datasetBucketName,
                argv.jwtSecret,
                argv.userId,
                argv.externalRetries,
                1,
                argv.domainWaitTimeConfig as any,
                argv.requestOpts as CoreOptions
            )
    });
}

sleuthBrokenLinks().catch((e) => {
    console.error("Error: " + e.message, e);
    process.exit(1);
});
