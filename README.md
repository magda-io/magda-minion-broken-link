## Magda broken-link Minion

![CI Workflow](https://github.com/magda-io/magda-minion-broken-link/workflows/Main%20CI%20Workflow/badge.svg?branch=master) [![Release](https://img.shields.io/github/release/magda-io/magda-minion-broken-link.svg)](https://github.com/magda-io/magda-minion-broken-link/releases)

A [Magda](https://github.com/magda-io/magda) minion is a service that listens for new records or changes to existing records, performs some kind of operation and then writes the result back to the registry. For instance, we have a broken link minion that listens for changes to distributions, retrieves the URLs described, records whether they were able to be accessed successfully and then writes that back to the registry in its own aspect.

Other aspects exist that are written to by many minions - for instance, we have a "quality" aspect that contains a number of different quality ratings from different sources, which are averaged out and used by search.

This magda minion will test if a distribution is still available and record the link status accordingly.

### Helm Chart

It's recommanded to deploy minions with as [dependencies](https://helm.sh/docs/topics/chart_best_practices/dependencies/) of a Magda helm deployment. Example can be found from [here](https://github.com/magda-io/magda-config).

-   Magda Helm Charts Repository Url: https://charts.magda.io

The [helm chart](https://helm.sh/docs/topics/charts/) for this minion is auto released when a [Github Release](https://help.github.com/en/github/administering-a-repository/creating-releases) is created for this repo.

-   Add repository to helm:

```bash
helm repo add magda-io https://charts.magda.io
```

### Docker Image

Docker image releases can be found from Docker Hub:

https://hub.docker.com/r/data61/magda-minion-broken-link/

Development releases (per commit) are also available from [GitHub Registry](https://github.com/magda-io/magda-minion-broken-link/packages) and accessible with access token.
