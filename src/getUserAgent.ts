import fse from "fs-extra";
import path from "path";

const pkgPromise = fse.readJSON(path.resolve(__dirname, "../package.json"), {
    encoding: "utf-8"
});

export default async function getUserAgent() {
    const pkg = await pkgPromise;
    return `${pkg.name}/${pkg.version}`;
}
