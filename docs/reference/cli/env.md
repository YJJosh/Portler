# portler env

Print generated and resolved environment values.

```bash
portler env [service] [--prod] [--reveal]
portler env docker|k8s [service] [--prod] [--reveal]
```

`--prod` prints what `up --prod` hands the service: the production overrides applied, the deployment's values with their precedence (process env, then the `use_env` file, then config), and only the keys the service receives. Secret-looking values are masked unless `--reveal` is given: a name containing `SECRET`, `TOKEN`, `PASS`, `PWD`, `PRIVATE`, `CREDENTIAL`, `SALT` or `APIKEY`, or `KEY` or `CERT` as a word (`SIGNING_KEY`, `SSH_KEY`), and the password in a URL, and missing `prod.require` keys are reported on stderr. Port assignment is the same as `up`; `start` uses the platform's `PORT` instead.

## Behavior

- Without a service: prints the generated [`PORTLER_*` variables](/reference/environment) plus the resolved top-level `env:`.
- With a service: additionally layers the service's own `env:` and `port_env` values — everything the service would receive on top of your shell environment and `.env` files.
- **A service that was started shows the environment of that launch.** `pids.json` records, per service, the run mode and whether it was started with `--prod`; while that entry exists (running, or stopped without `down`), `env <service>` resolves with them. A backend started by `portler up docker` shows its `docker.env` overrides and `port_env` as the declared container `port:`, not the local values, and one started with `--prod` shows the masked production view (`--reveal` is allowed then). A notice on stderr names the launch. A Kubernetes service without a port has no port-forward and so no entry, and a stopped entry from an earlier launch says nothing about a later `up k8s`. So when a service has no running entry and this checkout has rendered Kubernetes manifests (`.portler/k8s/` exists), `env` asks the cluster, and a service whose Deployment is there gets the k8s view. If the cluster cannot be asked, a notice says so and the recorded launch, or the development view, is shown. Any other service with no entry, or one started by plain `up` without `--prod`, gets the development view as before, with no notice.
- **A typed mode or `--prod` wins over the record**, as it does for [`restart`](/reference/cli/restart): `env docker backend` shows the Docker-mode environment and `env --prod backend` the production one, and if that differs from how the service was started, the notice says so. There is no flag to go back to the development view of a service started with `--prod`; `down` it first. `--prod` does not combine with k8s mode, typed or recorded, since `up k8s` has no production mode. A typed mode is refused for a service that mode cannot run, or that depends on one it cannot run, with the same error `up docker` or `up k8s` gives (for example a service with no container config under `env k8s`); with no service named, every service is checked, as `up docker` and `up k8s` do.

Useful for debugging [references](/guide/services#service-references); in development the output can be sourced into other tooling.

Port assignments for running services are preserved when missing or stale state is refreshed, including Docker containers whose supervisor has exited or whose liveness cannot be checked. When neither `state.json` nor the global port registry still has a running service's port, it is read from `.portler/pids.json`.

## Example

```bash
$ portler env backend
PORTLER_SERVICE_NAMES=backend,frontend,postgres
PORTLER_BACKEND_PORT=51235
PORTLER_BACKEND_URL=http://localhost:51235
...
DATABASE_URL=postgres://app:app@localhost:51234/app
PORT=51235
```
