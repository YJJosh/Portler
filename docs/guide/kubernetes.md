# Kubernetes mode

`portler up k8s` runs the whole project in a **local** Kubernetes cluster.

```bash
portler up k8s          # build, load, apply, port-forward
portler down k8s        # delete workloads, stop port-forwards (keeps volumes)
portler down k8s --volumes  # also delete the namespace and its PVCs
portler k8s render      # only generate and print the manifests
```

## Local clusters only

Portler **refuses to run against a kubectl context it does not recognize as local**. `up k8s` applies manifests and `down k8s` deletes resources — doing either against a staging or production cluster just because it happened to be the active context is not a recoverable mistake.

Recognized: **kind** (`kind-*`), **k3d** (`k3d-*`), **minikube**, **Docker Desktop**, **Rancher Desktop**, **OrbStack**, and **colima**.

Anything else fails with a message telling you to switch context. If you genuinely have a local cluster under an unusual context name, allow that exact name:

```bash
PORTLER_ALLOW_K8S_CONTEXT=my-lab-cluster portler up k8s
```

The override must name the exact context, so a stale `export` cannot silently authorize whatever context is active later.

Portler also pins `--context` on every `kubectl` call it makes, so switching contexts while a command is running cannot redirect an apply or a delete to another cluster.

### The endpoint is checked too, not just the name

A context name is a convention, not a fact: anything can be *named* `minikube`, and `kubectl config rename-context` takes two seconds. So Portler resolves the context's **API server endpoint** and checks that as well. Both gates must pass, and the endpoint gate **fails closed**.

Accepted on its own: an endpoint that is plainly **on this machine** — a loopback address (`127.0.0.1`, `::1`, `0.0.0.0`) or a host alias a local runtime publishes (`kubernetes.docker.internal`, `host.docker.internal`, `host.lima.internal`, `host.orb.internal`). That covers kind, k3d, colima, Docker Desktop, Rancher Desktop and OrbStack out of the box.

Everything else must be authorized explicitly, by naming the exact API server URL:

```bash
PORTLER_ALLOW_K8S_ENDPOINT=https://192.168.49.2:8443 portler up k8s
```

| Endpoint | Portler |
| -------- | ------- |
| Loopback / local runtime alias | Runs. |
| **Private / LAN** (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `100.64/10`, IPv6 ULA/link-local) | **Refuses** unless `PORTLER_ALLOW_K8S_ENDPOINT` names it exactly. |
| Routable address or DNS name (`https://….eks.amazonaws.com`) | **Refuses** unless `PORTLER_ALLOW_K8S_ENDPOINT` names it exactly. |
| Unreadable, unparseable, or empty | **Refuses.** No override. |

::: warning minikube needs the override
minikube's API server usually lives on its VM at `https://192.168.49.2:8443`, which is a **private** address — and "private" means "not routable from the internet", not "on your machine". The cluster on the office LAN and the one at the far end of a VPN are private addresses too, and Portler cannot tell them apart from your VM. Since `up k8s` applies manifests and `down k8s` deletes namespaces, it makes you say which one you mean:

```bash
kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'   # read the exact URL
export PORTLER_ALLOW_K8S_ENDPOINT=https://192.168.49.2:8443                # then authorize it
```

(A `minikube --driver=docker` cluster that publishes its API server on `127.0.0.1` needs nothing.)
:::

An endpoint Portler **cannot read** (kubectl reports no server, or an unparseable one) is refused outright, with no override: the override names an exact URL, and there is none to name. A tool that deletes namespaces does not get to proceed against a cluster it cannot identify on the strength of a context *name*.

## What `up k8s` does

1. **Builds Docker images** for services with a `build` config (same resolution as `up docker`: the service's `docker:` key wins over top-level `image`/`build`).
2. **Resolves and validates the cluster** from the active kubectl context, then loads locally built images into it (`kind load docker-image` / `k3d image import` / `minikube image load`; Docker Desktop, Rancher Desktop, OrbStack and colima share the host Docker daemon). No registry push is needed. Registry images like `postgres:16-alpine` are pulled by the cluster itself.
3. **Generates manifests** into `.portler/k8s/`: a Namespace, plus a Deployment, a Service (when the service has a `port`), and a PersistentVolumeClaim (when `k8s.volume` is set) per service.
4. **Applies one dependency level at a time**: a service's manifests are not applied until every dependency's pods have rolled out, stayed stable (ready with no new restarts for a few seconds), and answered through their port-forward — mirroring local and Docker startup ordering.
5. **Port-forwards each in-cluster Service** to its Portler-assigned localhost port, so generated URLs and env values keep working exactly like local and Docker modes. The supervisor re-establishes the forward when a pod restart kills it (capped backoff, a few retries) and keeps running after `up k8s -d` exits. Before reporting the stack up, Portler re-probes every forwarded port over TCP and fails loudly if one refuses connections.

## Namespace ownership

Everything lives in a project-scoped namespace (`portler-<project>-<hash>`, override with a top-level `k8s_namespace:`), labelled `app.kubernetes.io/managed-by=portler` and `portler.dev/project=<digest>`.

The `portler.dev/project` value is a **SHA-256 digest of the project directory** (truncated to 128 bits). It is what authorizes a delete, so it must not collide: under the short 32-bit hash Portler 0.1.x used, two project paths that collided would each have seen the other's namespace and Deployments as its own — and a 32-bit collision is brute-forceable in seconds.

::: warning Kubernetes mode: 0.1.x resources are not adopted
The ownership label changed value in 0.2.0, so resources deployed by a 0.1.x Portler are **not recognized as this project's**. `up k8s` and `down k8s` will refuse to touch that namespace (it reads as foreign) rather than adopt it.

Kubernetes mode was beta in 0.1.x and there is no in-place migration. Clean up the old namespace once, by hand:

```bash
kubectl get namespace -l app.kubernetes.io/managed-by=portler   # find it
kubectl delete namespace <the-old-portler-namespace>            # deletes its PVCs too
```

Then run `portler up k8s` again: the namespace is recreated with the new label, and nothing else changes. Back up any data in a PVC you care about first — deleting the namespace destroys it.
:::

**Portler only ever touches a namespace it created.** If the namespace already exists without those labels, both `up k8s` and `down k8s` fail rather than adopting it. This is what stops `k8s_namespace: default` (or a shared team namespace) from turning `portler down k8s` into a cluster-wide deletion of other people's workloads.

The namespace is **created** (`kubectl create`), never applied. `kubectl apply` would *adopt* a namespace that appeared between the ownership check and the apply — stamping Portler's labels onto someone else's namespace, and thereby authorizing a later `down k8s --volumes` to delete it. `create` fails with `AlreadyExists` instead; Portler then re-reads the namespace and continues only if it really is this project's. For the same reason the namespace manifest is not part of the manifest set `up k8s` applies (it is still written to `.portler/k8s/` and printed by `portler k8s render`, for you to read).

A namespace whose ownership Portler **cannot read** — the API server is unreachable, or you lack permission to `get namespaces` — is not treated as absent. `up k8s` and `down k8s` both fail with that error rather than assuming an empty cluster and creating or deleting on a guess. A failed delete is reported as a failure too: `down k8s` exits non-zero instead of printing a warning and releasing the ports as if the workloads were gone.

Deletes are scoped by the project label too — even a partial `portler down k8s api` selects on the project, not just on `app=api`, so it cannot match another project's identically-named Deployment.

::: warning Your data survives `down k8s`
`portler down k8s` deletes Deployments and Services but **keeps PersistentVolumeClaims and the namespace**, so a database's data survives a down/up cycle.

Pass `--volumes` to delete the namespace and everything in it, including the PVCs:

```bash
portler down k8s --volumes    # destroys stored data
```
:::

When `--volumes` is used, `down k8s` waits (up to 60s) for the namespace to finish terminating, and a later `up k8s` waits out a still-terminating namespace instead of failing.

## Restarting

There is no `portler restart k8s`. A Kubernetes restart has to re-apply manifests and re-establish port-forwards, which `restart` does not do — run `portler down k8s` followed by `portler up k8s`.

## Per-service `k8s:` options

```yaml
services:
  postgres:
    image: postgres:16-alpine
    port: 5432
    env:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    k8s:
      volume:
        size: 1Gi
        mount_path: /var/lib/postgresql/data

  api:
    docker:
      build:
        context: .
        dockerfile: apps/api/Dockerfile
    port: 4000
    port_env: PORT
    depends_on:
      - postgres
    k8s:
      replicas: 1
      env:
        DATABASE_URL: postgres://app:app@postgres:5432/app
```

| Option | Meaning |
| --- | --- |
| `replicas` | Deployment replica count (default `1`) |
| `env` | Env overrides for in-cluster consumption; layered over the service's Docker-mode env |
| `volume` | Creates a PersistentVolumeClaim of the given `size`, mounted at `mount_path` |

- **`env`**: inside the cluster, services reach each other through Kubernetes DNS service names (`postgres:5432`), just like Docker network aliases in Docker mode. Host-facing URLs (`backend.url`, generated `PORTLER_*`) keep using the port-forwarded localhost ports. Deployment manifests include only env-file/config/generated keys Portler composed; inherited host `PORTLER_*` controls, paths, secrets, and internal package-manager defaults are not serialized.
- **`volume`**: `mount_path` defaults to the container path of the first Docker volume, or `/data`. A plain string is shorthand for the size: `volume: 1Gi`.
- `k8s: true` is shorthand for the defaults (`replicas: 1`, no overrides).

## Ports and readiness

As with Docker services, `port:` is the internal container port; the in-cluster Service exposes it and Portler forwards a dynamic localhost port to it. `replicas` must be at least `1`: Portler's `up` lifecycle waits for a stable pod and cannot establish a port-forward to a scaled-to-zero Deployment.

When a top-level [`proxy:`](/guide/proxy) is configured, it runs as a host process after the port-forwards are ready and routes to those forwarded ports, so the project URL and `PORTLER_PROXY_*` variables work in Kubernetes mode too.

`command` healthchecks are **ignored** in Kubernetes mode (they usually shell into Docker containers); readiness uses the Deployment rollout plus a TCP check through the port-forward.

::: warning
`k8s` is a reserved word on the command line (`portler up k8s`) and cannot be used as a service name.
:::
