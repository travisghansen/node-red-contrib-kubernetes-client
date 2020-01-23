"use strict";
const k8s = require("@kubernetes/client-node");
const LRU = require("lru-cache");
const queryString = require("query-string");
const request = require("request");
const URI = require("uri-js");

class KubeConfig extends k8s.KubeConfig {
  constructor() {
    super(...arguments);
    this.discoveryCache = new LRU({ maxAge: 1 * 60 * 60 * 1000 }); // 1 hour
  }

  /**
   * creates a new watch instance
   */
  createWatch() {
    return new k8s.Watch(this);
  }

  /**
   * msg.method
   * msg.topic
   * msg.payload
   *
   * @param {*} msg
   */
  async makeHttpRestRequest(msg) {
    const kc = this;
    return new Promise(async (resolve, reject) => {
      let endpoint = msg.topic;
      if (typeof endpoint == "object") {
        try {
          endpoint = await this.buildResourceSelfLink(msg.topic);
        } catch (err) {
          reject(err);
        }
      }
      endpoint = kc.buildWatchlessURI(endpoint);
      msg.method = msg.method || "GET";
      const options = {
        method: msg.method.toUpperCase(),
        url: `${kc.getCurrentCluster().server}${endpoint}`,
        headers: {
          Accept: "application/json",
          "User-Agent": "Node-RED",
          "Content-Type": "application/json"
        },
        json: true
        //agentOptions: {
        //  rejectUnauthorized: false
        //}
      };

      kc.applyToRequest(options);

      if (msg.method.includes("PATCH")) {
        /**
         * https://github.com/kubernetes/community/blob/master/contributors/devel/api-conventions.md#patch-operations
         * https://github.com/kubernetes/community/blob/master/contributors/devel/strategic-merge-patch.md
         *
         * Content-Type: application/json-patch+json
         * Content-Type: application/merge-patch+json
         * Content-Type: application/strategic-merge-patch+json
         */
        switch (msg.method) {
          case "PATCH-JSON":
            options["headers"]["Content-Type"] = "application/json-patch+json";
            break;
          case "PATCH-STRATEGIC-MERGE":
            options["headers"]["Content-Type"] =
              "application/strategic-merge-patch+json";
            break;
          case "PATCH":
          case "PATCH-MERGE":
          default:
            options["headers"]["Content-Type"] = "application/merge-patch+json";
            break;
        }

        options.method = "PATCH";
      }

      switch (options.method.toUpperCase()) {
        case "GET":
          options.qs = msg.payload;
          break;
        default:
          options.body = msg.payload;
          break;
      }

      request(options, function(err, res, body) {
        if (err) {
          reject(err);
        }
        resolve(res);
      });
    });
  }

  /**
   * Given a URI, remove parts of the path that equal 'watch'
   * and also remove any 'watch' parameters from the query string
   *
   * @param {*} uri
   */
  buildWatchlessURI(uri) {
    const suri = URI.parse(URI.normalize(uri));
    const path = suri.path;
    const query = suri.query;

    const pathParts = path.split("/");
    const pathPartsWithoutWatch = pathParts.filter(item => {
      if (item.toLowerCase() != "watch") {
        return true;
      }
      return false;
    });

    const squery = queryString.parse(query);
    delete squery["watch"];

    const newPath = pathPartsWithoutWatch.join("/");
    const newUri = URI.serialize({
      path: newPath,
      query: queryString.stringify(squery)
    });

    return newUri;
  }

  async buildResourceSelfLink(kind, apiVersion, name, namespace) {
    let res;
    if (arguments.length == 1) {
      res = kind;

      if (res.metadata && res.metadata.selfLink) {
        return res.metadata.selfLink;
      }

      kind = res.kind;
      apiVersion = res.apiVersion;
      if (res.metadata) {
        name = res.metadata.name || res.name;
        namespace = res.metadata.namespace || res.namespace || null;
      } else {
        // this support the involvedObject syntax of Events
        name = res.name;
        namespace = res.namespace || null;
      }
    }

    if (kind == "Node" && apiVersion == undefined) {
      apiVersion = "v1";
    }

    if (apiVersion == undefined || apiVersion === null) {
      throw new Error("missing apiVersion");
    }

    let prefix = "/apis";
    if (apiVersion == "v1") {
      prefix = "/api";
    }
    //console.log(kind, apiVersion, name, namespace);

    //res = await this.makeHttpRestRequest({ topic: "/api" });
    //console.log(res.body);

    //res = await this.makeHttpRestRequest({ topic: "/apis" });
    //console.log(res.body);

    /**
     * cache each unique resource as a key
     * allows for JIT lookup and freshness on a per-resource basis
     */
    let cacheKey = `${prefix}/${apiVersion}`;
    res = this.discoveryCache.get(cacheKey);
    if (res === undefined) {
      res = await this.makeHttpRestRequest({
        topic: `${prefix}/${apiVersion}`
      });

      if (res.stausCode == 200) {
        res = res.body;
        this.discoveryCache.set(cacheKey, res);
      } else {
        res = res.body;
        this.discoveryCache.set(cacheKey, res, 5 * 60 * 1000); // 5 minute cache for failures
      }
    }

    let resource = res.resources.find(resource => {
      return resource.kind == kind;
    });

    if (resource) {
      let endpoint = "";
      if (resource.namespaced) {
        endpoint = `${prefix}/${apiVersion}/namespaces/${namespace}/${resource.name}/${name}`;
      } else {
        endpoint = `${prefix}/${apiVersion}/${resource.name}/${name}`;
      }

      return endpoint;
    } else {
      throw new Error("failure to lookup resource selfLink");
    }
  }

  async dressEventResource(event, removeOld = true) {
    event.involvedObject.metadata = event.involvedObject.metadata || {};

    [
      "name",
      "namespace",
      "uid",
      "resourceVersion",
      "creationTimestamp"
    ].forEach(attribute => {
      if (
        event.involvedObject.hasOwnProperty(attribute) &&
        !event.involvedObject.metadata.hasOwnProperty(attribute)
      ) {
        event.involvedObject.metadata[attribute] =
          event.involvedObject[attribute];

        if (removeOld) {
          delete event.involvedObject[attribute];
        }
      }
    });

    if (!event.involvedObject.metadata.hasOwnProperty("selfLink")) {
      try {
        let selfLink = await this.buildResourceSelfLink(event.involvedObject);

        event.involvedObject.metadata.selfLink = selfLink;
      } catch (err) {}
    }
  }
}

module.exports.KubeConfig = KubeConfig;
