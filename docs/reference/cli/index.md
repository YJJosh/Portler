# CLI overview

```text
portler setup [docker] [service...] [--prod]
portler start [service] [--prod] [--drain-ms <ms>]
portler up [service...] [--detach] [--prod] [--setup|--no-setup] [--volume-set <name>] [--image <service>=<image>]
portler up docker [service...] [--detach] [--prod] [--setup|--no-setup] [--volume-set <name>] [--image <service>=<image>]
portler up k8s [service...] [--detach] [--image <service>=<image>]
portler down [docker|k8s] [service...] [--volumes] [--force]
portler k8s render [service...]
portler restart [docker] [service...] [--prod] [--setup|--no-setup] [--image <service>=<image>] [--volume-set <name>]
portler ps [service...]
portler logs [service...] [-f|--follow]
portler ports
portler env [service] [--prod] [--reveal]
portler clean [--ports] [--global] [--force]
portler volumes [list] [--prod]
portler volumes fork <volume> <new-set> [--prod]
portler volumes remove <volume> [--force] [--prod]
portler init
```

## Global options

| Flag | Description |
| --- | --- |
| `-f, --file <path>` | Use a specific portler.yml file (for `logs`, `-f` means `--follow`; use `--file` there) |
| `-h, --help` | Show help |

## Command options

| Flag | Applies to | Description |
| --- | --- | --- |
| `--prod` | `setup`, `start`, `up`, `restart`, `env`, `volumes` | Use production overrides (not Kubernetes; `restart` refuses to change a running service's mode) |
| `--setup` / `--no-setup` | `up`, `restart` | Force / skip setup (not Kubernetes) |
| `-d, --detach` | `up` | Start services in the background |
| `-f, --follow` | `logs` | Keep streaming new output |
| `--reveal` | `env` | With `--prod`, print secret-looking values instead of `***` |
| `--drain-ms <ms>` | `start` | After the shell exits, wait up to `<ms>` for the rest of its process group (default 10000) |
| `--image <service>=<image>` | `up`, `restart` | Run that Docker service from this image instead of building it (repeatable) |
| `--volumes` | `down k8s` | Also delete the project's PersistentVolumeClaims |
| `--ports` | `clean` | Only release this project's ports |
| `--global` | `clean` | Prune stale entries from the global registry |
| `--force` | `clean`, `volumes remove`, `down` | Stop running services first (or, with `clean --global`, reset a corrupt registry) / remove a volume in use / **dangerous last resort:** signal a pid `down` cannot identify ([PID safety](/reference/cli/down#pid-safety)) |
| `--volume-set <name>` | `up`, `restart`, `volumes` | Use the `<volume>--<name>` variants of managed `@` volumes (env fallback: `PORTLER_VOLUME_SET`) |

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
| [`portler setup`](/reference/cli/setup) | Run installation/build/generation without starting services |
| [`portler start`](/reference/cli/start) | Run one foreground local process for deployment |
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
