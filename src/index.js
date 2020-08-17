"use strict";

const
    PromFactory = require("./PromFactory"),
    onFinished = require("on-finished");

function filterArrayByRegExps(array, regexps) {
    return array.filter(element => {
        for (let regexp of regexps) {
            if (regexp instanceof RegExp) {
                if (element.match(regexp)) {
                    return true;
                }
            } else if (element == regexp) {
                return true;
            }
        }
        return false;
    });
}

function prepareMetricNames(opts, metricTemplates) {
    let names = Object.keys(metricTemplates);
    if (opts.whitelist) {
        if (opts.blacklist) {
            throw new Error("you cannot have whitelist and blacklist at the same time");
        }
        return filterArrayByRegExps(names, opts.whitelist);
    }
    if (opts.blacklist) {
        const blacklisted = filterArrayByRegExps(names, opts.blacklist);
        return names.filter(name => blacklisted.indexOf(name) === -1);
    }
    return names;
}

function main(opts) {
    if (arguments[2] && arguments[1] && arguments[1].send) {
        arguments[1].status(500)
            .send("<h1>500 Error</h1>\n"
                + "<p>Unexapected 3d param.\n"
                + "<p>Did you just put express-prom-bundle into app.use "
                + "without calling it as a function first?");
        return;
    }

    let factory = new PromFactory(opts);

    const metricTemplates = {
        "up": () => factory.newGauge(
            "up",
            "1 = up, 0 = not up"
        ),
        "nodejs_memory_heap_total_bytes": () => factory.newGauge(
            "nodejs_memory_heap_total_bytes",
            "value of process.memoryUsage().heapTotal"
        ),
        "nodejs_memory_heap_used_bytes": () => factory.newGauge(
            "nodejs_memory_heap_used_bytes",
            "value of process.memoryUsage().heapUsed"
        ),
        "http_request_seconds": () => {
            const metric = factory.newHistogram(
                "http_request_seconds",
                "number of http responses labeled with status code",
                {
                    buckets: [0.003, 0.03, 0.1, 0.3, 1.5, 10]
                }
            );
            metric.labelNames = ["status_code"];
            return metric;
        },
        "http_request_detail_duration": () => {
            const metric = factory.newHistogram(
                "http_request_detail_duration",
                "Duration of HTTP requests(Detailed)",
                {
                    buckets: [0.003, 0.03, 0.1, 0.3, 1.5, 10]
                }
            );
            metric.labelNames = ["method", "route", "status_code"];
            return metric;
        },
        "http_request_long_duration": () => {
            const metric = factory.newHistogram(
                "http_request_long_duration",
                "Long Duration of HTTP requests(Detailed)",
                {
                    buckets: [0.3, 1.5, 3, 5, 10]
                }
            );
            metric.labelNames = ["method", "url", "status_code"];
            return metric;
        },
    };

    const
        metrics = {},
        names = prepareMetricNames(opts, metricTemplates);


    for (let name of names) {
        metrics[name] = metricTemplates[name]();
    }

    if (metrics.up) {
        metrics.up.set(1);
    }

    let middleware = function (req, res, next) {
        let timer, labels, timer_duration, labels_duration, timer_long_duration, labels_long_duration;

        if (metrics["http_request_seconds"]) {
            labels = {"status_code": 0};
            timer = metrics["http_request_seconds"].startTimer(labels);
        }

        if (metrics["http_request_detail_duration"]) {
            labels_duration = {"method": req.method, "route":req.url, "status_code": 0};
            timer_duration = metrics["http_request_detail_duration"].startTimer(labels_duration);
        }

        if (metrics["http_request_long_duration"]) {
            labels_long_duration = {"method": req.method, "url":req.url, "status_code": 0};
            timer_long_duration = metrics["http_request_long_duration"].startTimer(labels_long_duration);
        }

        if (req.path == "/metrics") {
            let memoryUsage = process.memoryUsage();
            if (metrics["nodejs_memory_heap_total_bytes"]) {
                metrics["nodejs_memory_heap_total_bytes"].set(memoryUsage.heapTotal);
            }
            if (metrics["nodejs_memory_heap_used_bytes"]) {
                metrics["nodejs_memory_heap_used_bytes"].set(memoryUsage.heapUsed);
            }

            res.contentType("text/plain")
                .send(factory.promClient.register.metrics());
            return;
        }

        if (timer) {
            onFinished(res, () => {
                if (res.statusCode) {
                    labels["status_code"] = res.statusCode;
                    timer();
                    if (res.req && res.req.route) {
                        labels_duration["route"] = res.req.route.path;
                    }
                    labels_duration["status_code"] = res.statusCode;
                    timer_duration();
                    if(opts.routes_to_detail && res.req && res.req.route && opts.routes_to_detail.indexOf(res.req.route.path) !== -1) {
                        labels_long_duration["status_code"] = res.statusCode;
                        timer_long_duration();
                    }
                }
            });
        }

        next();
    };

    middleware.factory = factory;
    middleware.metricTemplates = metricTemplates;
    middleware.metrics = metrics;
    middleware.promClient = factory.promClient;

    return middleware;
}

module.exports = main;