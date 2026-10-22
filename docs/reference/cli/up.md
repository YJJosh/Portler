# portler up

Start services: assign ports, resolve env, and launch in dependency order.

```bash
portler up [service...] [--detach] [--volume-set <name>] [--prod] [--setup|--no-setup] [--image <service>=<image>]
portler up docker [service...] [--detach] [--volume-set <name>] [--prod] [--setup|--no-setup] [--image <service>=<image>]
portler up k8s [service...] [--detach] [--image <service>=<image>]
```

## Behavior

- Runs setup automatically: root setup before any starts, service setup just before its service starts, after dependency readiness. A plain step runs when it has never succeeded in this checkout or its definition changed, and a `watch` step also when one of its listed files changed (receipts live in `.portler/setup.json`, separately for dev/prod and local/Docker modes); an `if_missing` step runs while its path is absent; an `always` step runs every time. See [Setup & production](/guide/setup-and-production).
- Existing running-service overlaps are rejected, running as [`portler ps`](/reference/cli/ps) reports it: a Docker service whose container runs on after its `docker run` process has gone counts, so `up` does not replace that container. A surviving process group whose leader has exited also blocks startup: Portler keeps its PID entry and warns that ownership cannot be verified, rather than starting an untracked second copy. A proven reused PID is stale, not such an overlap. Containers whose liveness cannot be checked also block startup. These overlap checks apply to `up k8s` too, including when switching from Docker mode. `up k8s` also refuses to start in another kubectl context while the project still has Deployments in the one it was last started in (see [Kubernetes mode](/guide/kubernetes#later-commands-use-the-context-up-k8s-deployed-to)). `up` does not implicitly restart existing processes. To bring a service back next to what is running, use [`portler restart <name>`](/reference/cli/restart), which the refusal suggests with this command's mode and options (`--file`, `--prod`, `--setup`/`--no-setup`, `--image`, `--volume-set`) and only the requested services that are not running; restart runs them in the background. The suggestion appears only when that restart would do what was asked: it is left out when what is running was started in another mode or with another `--prod` (restart refuses to mix them, or would replay the recorded launch), when the requested service has a leftover entry that restart would replay instead, and when restart would refuse the command, such as an `--image` pin for a service it leaves running. To start over (including when switching dev/prod), use `down` first.
- Assigns a free port to every service that declares one (see [Ports](/guide/ports)) and prints the `SERVICE / PORT / URL` table.
- Starts services in [dependency order](/guide/dependencies), waiting for each dependency's healthcheck.
- With service names, starts only those services **plus their dependencies**.
- In the foreground (default), `Ctrl+C` stops the stack. `Ctrl+C` or `SIGTERM` during startup (including setup and readiness checks, and for `up k8s` image builds, applies and rollout waits) rolls back only this invocation’s services and releases their ports, exiting with code 130 or 143 respectively. For `up k8s` that also stops the port-forwards it started and deletes the Deployments and Services it applied (never PersistentVolumeClaims). If another run depends on some of it (`portler restart api` from a second terminal keeps the db this run started), the foreground run stops the rest, names what it kept, and keeps showing that output until it stops; a `Ctrl+C` at that point stops it too. With `-d/--detach`, services keep running in the background — use [`portler ps`](/reference/cli/ps), [`portler logs`](/reference/cli/logs), and [`portler down`](/reference/cli/down).
- When a [`proxy:`](/guide/proxy) block exists, the proxy starts with the stack and the project URL is printed. `proxy.host` independently overrides its bind address (default: root `host`); backend assignments stay unchanged. `proxy.trusted_proxies` (default `[]`) allows exact edge IPs to supply validated original HTTP/HTTPS scheme, allowed hostname and client IP chain, equally for HTTP and WebSocket upgrades. No implicit loopback trust; an allowlisted edge must sanitize incoming client forwarding headers. See [TLS-edge deployment and the full trust boundary](/guide/proxy#behind-a-tls-edge).

## Run modes

| Invocation | Meaning |
| --- | --- |
| `portler up` | Local mode: `command` services run as local processes; services with Docker config (e.g. `image:`) run in Docker |
| `portler up docker` | [Docker mode](/guide/docker#docker-mode-portler-up-docker): every service with any Docker config runs in a container; per-service `docker:` overrides apply |
| `portler up k8s` | [Kubernetes mode](/guide/kubernetes): build, load, apply manifests to a local cluster, port-forward back to localhost |

## Options

| Flag | Description |
| --- | --- |
| `--prod` | Use production setup, command and env overrides (local/Docker only) |
| `--setup` | Run every plain setup step of the selection, dependencies and root included, ignoring receipts. `if_missing` steps still skip while their path exists |
| `--no-setup` | Run no setup command (receipts are still reconciled); cannot be combined with `--setup` |
| `-d, --detach` | Start in the background; local service output is captured to `.portler/logs/` |
| `--volume-set <name>` | Run against the `--<name>` variants of all managed `@` volumes ([volume sets](/guide/volumes#volume-sets)); env fallback `PORTLER_VOLUME_SET` |
| `--image <service>=<image>` | Run that Docker service from this image instead of building it; repeatable ([prebuilt images](/guide/docker#prebuilt-images)) |
| `-f, --file <path>` | Use a specific portler.yml |

## Examples

```bash
portler up                       # everything, foreground
portler up -d                    # everything, background
portler up backend               # backend + its dependencies
portler up docker -d             # full Docker mode, detached
portler up --volume-set my-branch   # forked data variants
portler up docker -d --image api=ghcr.io/org/api@sha256:3dc17e…   # CI-built image, nothing built
```

<!-- REVIEW: Surface the new transport restriction at the affected command, not only in the guides. -->
Kubernetes mode refuses a service with `transport: udp` (including dependencies): `kubectl port-forward` only carries TCP. A `tcp+udp` service gets a warning and only its TCP half is forwarded. To generate UDP manifests without port-forwarding, use [`portler k8s render`](/reference/cli/k8s-render).

Kubernetes mode ignores setup definitions and rejects `--prod`, `--setup` and `--no-setup`. Source files, lockfiles, ports and env values are not part of setup fingerprints unless a step lists the files in `watch:`: use `watch`, `if_missing` or `always` steps for commands that must follow them, or force setup after changing these inputs.
