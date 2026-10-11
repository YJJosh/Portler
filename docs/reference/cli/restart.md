# portler restart

Restart services in the background.

```bash
portler restart [docker] [service...] [--image <service>=<image>]
```

## Behavior

- Stops the named services (all by default) and starts them again **detached**, like `up -d`.
- Restarted services keep their previously assigned ports whenever they are still free.
- `portler restart api` restarts a single service: dependencies that are **not** running are started too; running ones are left untouched.
- `portler restart docker api` restarts in [Docker mode](/guide/docker#docker-mode-portler-up-docker).
- `--image <service>=<image>` works as in [`up`](/reference/cli/up): the restarted service runs from the pinned image instead of being rebuilt ([prebuilt images](/guide/docker#prebuilt-images)). A target this restart leaves running is rejected before anything is stopped. A pin lasts for one invocation: `restart` without `--image` rebuilds or pulls the service as `portler.yml` declares it, replacing the pinned image.

::: warning No Kubernetes mode
`portler restart k8s` is rejected. Restarting a Kubernetes stack has to re-apply manifests and re-establish port-forwards, which `restart` does not do. Run the two steps instead:

```bash
portler down k8s && portler up k8s
```

(Earlier versions accepted `restart k8s` and quietly did the wrong thing: they applied the Kubernetes config overlay — in-cluster DNS hostnames and `k8s.env` — and then ran the services as **local** processes, never touching the cluster.)
:::

## Examples

```bash
portler restart              # restart everything, detached
portler restart backend      # restart one service
portler restart docker api   # restart in Docker mode
```
