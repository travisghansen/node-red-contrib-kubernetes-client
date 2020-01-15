# node-red-contrib-kubernetes-client

A `Node-RED` node that supports interacting with Kubernetes API via `watches` and `HTTP` requests. [github](https://github.com/travisghansen/node-red-contrib-kubernetes-client)

# Install

```
npm install --save node-red-contrib-kubernetes-client
```

# Documentation

The nodes are properly documented in `Node-RED` itself. In short there are 2 nodes:

- `kubernetes-client-watch` - produces messages for configured `watch` endpoint.
- `kubernetes-client-http` - allows complete interaction with Kubernetes API via **ALL** HTTP `verbs` etc.

# License

See [license](https://github.com/travisghansen/node-red-contrib-kubernetes-client/blob/master/LICENSE) (MIT).
