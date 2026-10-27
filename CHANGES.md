# 3.1.0

-   Upgrade to Node.js 22: the docker image now uses `node:22-alpine` (was `node:18-alpine`), and CI uses Node.js 22
-   Upgrade GitHub Actions (checkout, setup-node, setup-qemu & setup-buildx) to current versions

# 3.0.0

-   Upgrade nodejs to version 18
-   Upgrade to Magda minion SDK v3
-   Fixed support for checking internal storage resource links

# 2.0.0

-   Upgrade nodejs to version 14
-   Upgrade other dependencies
-   Release all artifacts to GitHub Container Registry (instead of docker.io & https://charts.magda.io)
-   Upgrade magda-common chart version
-   Upgrade api to batch/v1 to be compatible with k8s 1.25 (now requires >=1.21)

# 1.0.0

-   Upgrade dependencies
-   Upgrade CI scripts
-   Related to https://github.com/magda-io/magda/issues/3229, Use magda-common for docker image related logic
