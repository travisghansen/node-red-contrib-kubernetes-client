"use strict";
const k8s = require("@kubernetes/client-node");
const LRU = require("lru-cache");
const queryString = require("query-string");
const request = require("request");
const URI = require("uri-js");

const FAILURE_CACHE_TIME = 5 * 60 * 1000; // 5 minutes
const SUCCESS_CACHE_TIME = 1 * 60 * 60 * 1000; // 1 hour
class KubeConfig extends k8s.KubeConfig {
  constructor() {
    super(...arguments);
    this.discoveryCache = new LRU({ maxAge: SUCCESS_CACHE_TIME });
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

  async getAPIGroups() {
    let res;
    let cacheKey = "__APIGroups";
    res = this.discoveryCache.get(cacheKey);
    if (res === undefined) {
      res = await this.makeHttpRestRequest({
        topic: "/apis"
      });

      if (res.stausCode == 200) {
        res = res.body;
        this.discoveryCache.set(cacheKey, res);
      } else {
        res = res.body;
        this.discoveryCache.set(cacheKey, res, FAILURE_CACHE_TIME);
      }
    }

    return res;
  }

  async getAPIResources(preferredVersions = false) {
    this.locks = this.locks || {};
    let cacheKey = "__APIResources";

    function sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    let i = 0;
    while (this.locks[cacheKey]) {
      i++;
      await sleep(1000);

      if (i > 10) {
        break;
      }
    }

    // test cache lock and wait
    let resources = this.discoveryCache.get(cacheKey);

    if (resources === undefined) {
      // apply lock
      this.locks[cacheKey] = true;

      resources = [];

      try {
        let apiGroups = await this.getAPIGroups();
        let api = await this.makeHttpRestRequest({ topic: "/api" });

        if (api.statusCode == 200) {
          await Promise.all(
            api.body.versions.map(async version => {
              let res = await this.makeHttpRestRequest({
                topic: `/api/${version}`
              });

              if (res.statusCode == 200) {
                resources.push(res.body);
              }
            })
          );
        }

        if (apiGroups.groups) {
          await Promise.all(
            apiGroups.groups.map(async group => {
              await Promise.all(
                group.versions.map(async version => {
                  let res = await this.makeHttpRestRequest({
                    topic: `/apis/${version.groupVersion}`
                  });

                  if (res.statusCode == 200) {
                    resources.push(res.body);
                  }
                })
              );
            })
          );
        }
      } catch (err) {}

      if (resources.length > 0) {
        this.discoveryCache.set(cacheKey, resources);
      }

      // remove lock
      this.locks[cacheKey] = false;
    }

    if (preferredVersions) {
      let apiGroups = await this.getAPIGroups();
      resources = resources.filter(resource => {
        // apiVersion is not present on core api resource list
        if (!resource.apiVersion) {
          return true;
        }
        return apiGroups.groups.some(group => {
          return group.preferredVersion.groupVersion == resource.groupVersion;
        });
      });
    }

    return resources;
  }

  /**
   * 
   * @param {*} kind 
   * @param {*} version 
   */
  async getApiGroupVersion(kind, version) {
    const resources = await this.getAPIResources(true);
    let matches = resources.filter(resourceList => {
      let groupVersionVersion = resourceList.groupVersion.split("/").pop();
      if (version && !(groupVersionVersion == version)) {
        return false;
      }

      return resourceList.resources.some(resource => {
        return resource.kind.toLowerCase() == kind.toLowerCase();
      });
    });

    if (matches.length == 1) {
      return matches[0].groupVersion;
    }
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

    // for testing
    //apiVersion = undefined;

    if (!apiVersion) {
      apiVersion = await this.getApiGroupVersion(kind);
    }

    if (apiVersion == undefined || apiVersion === null) {
      throw new Error("missing apiVersion");
    }

    let prefix = "/apis";
    if (apiVersion == "v1") {
      prefix = "/api";
    }

    //console.log(kind, apiVersion, name, namespace);

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

      if (res.statusCode == 200) {
        res = res.body;
        this.discoveryCache.set(cacheKey, res);
      } else if (res.statusCode == 404) {
        // assume in incomplete apiVersion (ie: only the version and not groupVersion)
        // attempt to find full groupVersion

        let newApiVersion = await this.getApiGroupVersion(kind, apiVersion);
        // try again
        if (newApiVersion && newApiVersion != apiVersion) {
          apiVersion = newApiVersion;
          res = await this.makeHttpRestRequest({
            topic: `${prefix}/${apiVersion}`
          });

          if (res.statusCode == 200) {
            res = res.body;
            this.discoveryCache.set(cacheKey, res);
          } else {
            res = res.body;
            this.discoveryCache.set(cacheKey, res, FAILURE_CACHE_TIME);
          }
        } else {
          res = res.body;
          this.discoveryCache.set(cacheKey, res, FAILURE_CACHE_TIME);
        }
      } else {
        res = res.body;
        this.discoveryCache.set(cacheKey, res, FAILURE_CACHE_TIME);
      }
    }

    if (!res.resources) {
      return;
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
    if (!event) {
      return;
    }
    if (!event.involvedObject) {
      return;
    }

    // move traditional metadata fields to metadata block
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

    // attempt to cleanup incomplete apiVersion (ie: not including the group)
    // if applicable
    let newApiVersion = await this.getApiGroupVersion(
      event.involvedObject.kind,
      event.involvedObject.apiVersion
    );

    if (newApiVersion) {
      if (!event.involvedObject.apiVersion) {
        event.involvedObject.apiVersion = newApiVersion;
      } else if (event.involvedObject.apiVersion != newApiVersion) {
        event.involvedObject.apiVersion = newApiVersion;
      }
    }

    // attempt to create selfLink
    if (!event.involvedObject.metadata.hasOwnProperty("selfLink")) {
      try {
        let selfLink = await this.buildResourceSelfLink(event.involvedObject);

        event.involvedObject.metadata.selfLink = selfLink;
      } catch (err) {}
    }
  }
}

module.exports.KubeConfig = KubeConfig;
