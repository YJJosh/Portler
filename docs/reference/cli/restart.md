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
- **Without flags, `restart` replays how the services were started.** `pids.json` records, per service, whether it was started with `--prod`, in which run mode (`docker` or plain), with which `--image` pin, and whether with `--no-setup`. A routine `portler restart api` on a production Docker stack therefore comes back as a production container, from the same pinned image, without running setup steps. The notice `restart keeps the recorded launch: ...` says what was replayed.
- **Flags override, for the services the restart starts again.** `--prod` restarts with the production overrides like `up --prod`; `docker` restarts in [Docker mode](/guide/docker#docker-mode-portler-up-docker); `--image <service>=<image>` replaces a recorded pin ([prebuilt images](/guide/docker#prebuilt-images)); `--setup` forces the plain setup steps and `--no-setup` skips them (receipts are still reconciled). A recorded pin that does not apply in the chosen run mode is dropped with a notice.
- **What the restart leaves running has to agree.** A dependency left running in the other mode (development next to a production restart, or the reverse), or started in the other run mode, is refused before anything is stopped, naming it. Restarting everything (`portler restart --prod` with no names) may switch the whole stack, since nothing is left behind; so may `down` and then `up`. A stack whose recorded services mix the two modes cannot be replayed and needs the flag. Setup is one choice for the whole restart, so the same holds when the recorded services it starts again (a dead dependency that comes back included) were started some with `--no-setup` and some without: pass `--setup` or `--no-setup`.
- A restart without names stops every recorded service, including ones removed from the config since they started, and replays their mode for the current config.
- A replayed `--prod` narrows to `prod.services` like a typed one: a service it leaves out is the deployment's, so a development copy of it that happens to be running is neither stopped, started nor counted when the mode to replay is decided. It narrows to `prod.services` as they are now: a service recorded with `--prod` that has since been dropped from them is refused by name, as `restart --prod` refuses it, before anything is stopped.
- With `--prod`, typed or replayed, `prod.require` is checked before anything is stopped, so a deployment value that has gone missing leaves the running services up instead of taking them down and failing to start them again.
- The launch is checked against the current config before anything is stopped too: a replayed Docker mode for a service whose `docker:` block has since been removed, a service with neither a command nor Docker config, or an `--image` the run mode cannot use is refused while the services are still up.
- A running dependency that exits on its own while the restart is stopping the requested services is started again with them, and with its own recorded launch: the restart plans again from what is running after the stop, so the dependency's record takes part in the choices above and the same checks run. If its record disagrees with the rest (for example, it was started with `--no-setup` and they were not), the restart stops there and says so; the requested services are then stopped and nothing has been started.

::: warning No Kubernetes mode
`portler restart k8s` is rejected, and so is a plain `portler restart` of anything `portler up k8s` started, before anything is stopped. Restarting a Kubernetes stack has to re-apply manifests and re-establish port-forwards, which `restart` does not do. Run the two steps instead:

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
portler restart api --prod   # restart in production mode (a plain restart keeps it)
portler restart --no-setup   # restart without running setup steps (receipts are still reconciled)
portler restart --prod       # switch a whole development stack to production
```
