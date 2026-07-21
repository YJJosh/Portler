# portler up

Start services: assign ports, resolve env, and launch in dependency order.

```bash
portler up [service...] [--detach] [--volume-set <name>]
portler up docker [service...] [--detach] [--volume-set <name>]
portler up k8s [service...] [--detach]
```

## Behavior

- Assigns a free port to every service that declares one (see [Ports](/guide/ports)) and prints the `SERVICE / PORT / URL` table.
- Starts services in [dependency order](/guide/dependencies), waiting for each dependency's healthcheck.
- With service names, starts only those services **plus their dependencies**.
- In the foreground (default), `Ctrl+C` stops the stack. With `-d/--detach`, services keep running in the background — use [`portler ps`](/reference/cli/ps), [`portler logs`](/reference/cli/logs), and [`portler down`](/reference/cli/down).
- When a [`proxy:`](/guide/proxy) block exists, the proxy starts with the stack and the project URL is printed.

## Run modes

| Invocation | Meaning |
| --- | --- |
| `portler up` | Local mode: `command` services run as local processes; services with Docker config (e.g. `image:`) run in Docker |
| `portler up docker` | [Docker mode](/guide/docker#docker-mode-portler-up-docker): every service with any Docker config runs in a container; per-service `docker:` overrides apply |
| `portler up k8s` | [Kubernetes mode](/guide/kubernetes): build, load, apply manifests to a local cluster, port-forward back to localhost |

## Options

| Flag | Description |
| --- | --- |
| `-d, --detach` | Start in the background; local service output is captured to `.portler/logs/` |
| `--volume-set <name>` | Run against the `--<name>` variants of all managed `@` volumes ([volume sets](/guide/volumes#volume-sets)); env fallback `PORTLER_VOLUME_SET` |
| `-f, --file <path>` | Use a specific portler.yml |

## Examples

```bash
portler up                       # everything, foreground
portler up -d                    # everything, background
portler up backend               # backend + its dependencies
portler up docker -d             # full Docker mode, detached
portler up --volume-set my-branch   # forked data variants
```
