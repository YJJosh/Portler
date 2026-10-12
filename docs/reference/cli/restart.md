# portler restart

Restart services in the background.

```bash
portler restart [docker] [service...] [--prod] [--setup|--no-setup] [--image <service>=<image>]
```

## Behavior

- Stops the named services (all by default) and starts them again **detached**, like `up -d`.
- Restarted services keep their previously assigned ports whenever they are still free.
- `portler restart api` restarts a single service: dependencies that are **not** running are started too; running ones are left untouched.
- `portler restart docker api` restarts in [Docker mode](/guide/docker#docker-mode-portler-up-docker).
- `portler restart api --prod` restarts with the production overrides, like `up --prod`. `restart` keeps the mode a service was started in: a service started with `--prod` refuses a plain `restart`, and a service running in development mode refuses `restart --prod`. The check covers the dependencies a restart leaves running and, on a restart without names, every recorded service including ones removed from the config since they started, so a routine restart can neither flip a production stack back to development nor put a production service on top of development dependencies. Switching modes is `down` and then `up`. With `--prod`, `prod.require` is checked before anything is stopped, so a deployment value that has gone missing leaves the running services up instead of taking them down and failing to start them again. The run mode is kept the same way: a service that `up docker` started as a container from its `docker:` block refuses a plain `restart`, which would relaunch it as a local process, and wants `restart docker`; a local process refuses `restart docker`. Services with a top-level `image` or `build` run in Docker either way and are not affected.
- `--setup` and `--no-setup` work like on `up` for the services the restart starts again: `--no-setup` runs no setup steps (receipts are still reconciled), `--setup` forces the plain ones. Without a flag, `restart` runs setup like `up` does, so a server without the source toolchain restarts with `--no-setup`.
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
portler restart api --prod   # restart in production mode
portler restart --no-setup   # restart without running setup steps (receipts are still reconciled)
```
