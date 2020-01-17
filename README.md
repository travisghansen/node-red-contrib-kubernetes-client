# node-red-contrib-kubernetes-client

A `Node-RED` node that supports interacting with Kubernetes API via `watches` and `HTTP` requests.

[GitHub](https://github.com/travisghansen/node-red-contrib-kubernetes-client)

# Install

```
npm install --save node-red-contrib-kubernetes-client
```

# Documentation

The nodes are properly documented in `Node-RED` itself. In short there are 2 nodes:

- `kubernetes-client-watch` - produces messages for configured `watch` endpoints.
- `kubernetes-client-http` - allows complete interaction with Kubernetes API via **ALL** HTTP `endpoints` and `verbs` etc.

`Watches` ouput a `msg.payload` with the following structure (as a `json` object in `Node-RED` but shared here as `yaml` for readability):

```
# example event
---
type: ADDED || MODIFIED || DELETED || ERROR
object:
  kind: ...
  apiVersion: ...
  metadata:
    ...
  ...

# example error
---
type: ERROR
object:
  kind: Status
  apiVersion: v1
  metadata: {}
  status: Failure
  message: 'too old resource version: 1 (78390381)'
  reason: Gone
  code: 410

```

`msg.payload.object` contains the full resource from Kubernetes.

# Development

Some helpful command variants for testing/developing:

```
# show event output structure
kubectl -v6 get nodes --watch --output-watch-events -o yaml

# manually specify URL
kubectl -v6 get --raw '/api/v1/nodes?resourceVersion=1&watch=true'

# watch response error structure
---
type: ERROR
object:
  kind: Status
  apiVersion: v1
  metadata: {}
  status: Failure
  message: 'too old resource version: 1 (78383979)'
  reason: Gone
  code: 410

```

# License

See [license](https://github.com/travisghansen/node-red-contrib-kubernetes-client/blob/master/LICENSE) (MIT).
