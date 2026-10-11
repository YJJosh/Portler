# portler restart

Restart services in the background.

```bash
portler restart [docker] [service...] [--prod] [--setup|--no-setup]
```

## Behavior

- Stops the named services (all by default) and starts them again **detached**, like `up -d`.
- Restarted services keep their previously assigned ports whenever they are still free.
- `portler restart api` restarts a single service: dependencies that are **not** running are started too; running ones are left untouched.
- `portler restart docker api` restarts in [Docker mode](/guide/docker#docker-mode-portler-up-docker).
- `portler restart api --prod` restarts with the production overrides, like `up --prod`. `restart` keeps the mode a service was started in: a service started with `--prod` refuses a plain `restart`, and a service running in development mode refuses `restart --prod`. The check covers the dependencies a restart leaves running and, on a restart without names, every recorded service including ones removed from the config since they started, so a routine restart can neither flip a production stack back to development nor put a production service on top of development dependencies. Switching modes is `down` and then `up`.
- `--setup` and `--no-setup` work like on `up` for the services the restart starts again: `--no-setup` runs no setup steps (receipts are still reconciled), `--setup` forces the plain ones. Without a flag, `restart` runs setup like `up` does, so a server without the source toolchain restarts with `--no-setup`.

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
