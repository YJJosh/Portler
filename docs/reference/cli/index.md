# CLI overview

```text
portler up [service...] [--detach] [--volume-set <name>]
portler up docker [service...] [--detach] [--volume-set <name>]
portler up k8s [service...] [--detach]
portler down [docker|k8s] [service...]
portler k8s render [service...]
portler restart [docker] [service...]
portler ps [service...]
portler logs [service...] [--follow]
portler ports
portler env [service]
portler clean [--ports] [--global] [--force]
portler volumes [list]
portler volumes fork <volume> <new-set>
portler volumes remove <volume> [--force]
portler init
```

## Global options

| Flag | Description |
| --- | --- |
| `-f, --file <path>` | Use a specific portler.yml file |
| `-h, --help` | Show help |

## Command options

| Flag | Applies to | Description |
| --- | --- | --- |
| `-d, --detach` | `up` | Start services in the background |
| `--follow` | `logs` | Keep streaming new output |
| `--ports` | `clean` | Only release this project's ports |
| `--global` | `clean` | Prune stale entries from the global registry |
| `--force` | `clean`, `volumes remove`, `down` | Stop running services first (or, with `clean --global`, reset a corrupt registry) / remove a volume in use / **dangerous last resort:** signal a pid `down` cannot identify ([PID safety](/reference/cli/down#pid-safety)) |
| `--volume-set <name>` | `up` | Use the `<volume>--<name>` variants of managed `@` volumes (env fallback: `PORTLER_VOLUME_SET`) |

## Run modes

`docker` and `k8s` are reserved words selecting the [Docker](/guide/docker#docker-mode-portler-up-docker) and [Kubernetes](/guide/kubernetes) run modes, and cannot be used as service names:

```bash
portler up             # local mode (Docker only for services with Docker config)
portler up docker      # everything with Docker config runs in containers
portler up k8s         # everything runs in a local Kubernetes cluster
```

## Commands

| Command | Description |
| --- | --- |
| [`portler up`](/reference/cli/up) | Start services (local, Docker, or Kubernetes mode) |
| [`portler down`](/reference/cli/down) | Stop services started by Portler |
| [`portler restart`](/reference/cli/restart) | Restart services in the background |
| [`portler ps`](/reference/cli/ps) | Show running services |
| [`portler logs`](/reference/cli/logs) | Show captured output of detached services |
| [`portler ports`](/reference/cli/ports) | Show assigned ports |
| [`portler env`](/reference/cli/env) | Print resolved environment values |
| [`portler clean`](/reference/cli/clean) | Remove runtime files and release ports |
| [`portler volumes`](/reference/cli/volumes) | List, fork, and remove managed volumes |
| [`portler k8s render`](/reference/cli/k8s-render) | Generate Kubernetes manifests without applying |
| [`portler init`](/reference/cli/init) | Write a starter portler.yml |
