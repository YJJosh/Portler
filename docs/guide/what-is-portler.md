# What is Portler?

Portler is a process runner for multi-service projects — like a small `docker compose`, but with **automatic port assignment**. The same `portler.yml` runs your stack on a developer machine and in production.

It reads a `portler.yml` file, assigns free localhost ports to your services, resolves service references like `backend.url` in environment values, and starts each service with the right environment variables.

## The problem

Local multi-service development usually means hardcoded ports:

- Two projects both want port `3000`, so you can only run one at a time.
- A colleague's `.env` assumes port `5432` is free, but you already have a Postgres running.
- You open a second git worktree of the same repository and everything collides with the first one.
- Every service needs to know every other service's address, so URLs are copy-pasted across `.env` files and break the moment a port changes.

## The idea

Declare your services once, without committing to specific ports:

```yaml
services:
  backend:
    command: npm run dev
    port: 4000
    port_env: PORT

  frontend:
    command: npm run dev
    port: 3000
    port_env: PORT
    env:
      VITE_API_URL: backend.url
```

When you run `portler up`, Portler:

1. **Assigns a free port** to every service (from a configurable range, `51000`–`59999` by default). The declared `port` is treated as a preference, not a requirement.
2. **Resolves references** — `backend.url` becomes `http://localhost:51235`, `${postgres.port}` becomes the assigned Postgres port.
3. **Injects environment variables** — each service receives its own port via `port_env` (e.g. `PORT=51236`) plus generated `PORTLER_*` variables describing every service in the stack.
4. **Starts services in dependency order**, waiting for each dependency to become ready (TCP, HTTP, or command healthchecks) before starting its dependents.

Because nothing is hardcoded, any number of projects — or git worktrees of the same project — run side by side without stepping on each other.

## One config, three run modes

The same `portler.yml` can run your stack three ways:

| Mode | Command | What runs where |
| --- | --- | --- |
| Local | `portler up` | Services run as local processes; services with Docker config (e.g. `image:`) run in Docker |
| Docker | `portler up docker` | Everything with Docker config runs in containers on a shared project network |
| Kubernetes | `portler up k8s` | Everything runs in a local cluster (kind, minikube, Docker Desktop), port-forwarded back to localhost |

In every mode, the generated URLs and environment variables keep working the same way, so your app code never has to care.

## Development and production

The same file also describes production. `--prod` applies the `prod:` overrides (production commands, setup steps and env), and the deployment's own environment wins over the file:

- **On a platform** with a build command and a start command, run `portler setup --prod` as the build step and `portler start <service> --prod` as the start command. The platform's `PORT` and secrets apply.
- **On a server with Docker**, `portler up docker --prod -d` starts the stack, and `--image` with a digest reference (`api=ghcr.io/org/api@sha256:…`) runs the exact images CI built instead of building on the host. A tag is not enough: Docker reuses a cached copy of it without checking the registry.

See [Setup & production](/guide/setup-and-production) and [Docker](/guide/docker) for the details.

## What Portler is not

- **Not a cluster orchestrator.** Portler runs a project on one machine: a developer machine, a CI runner or a server. It does not spread services across hosts, and it has no rolling or zero-downtime deploys: `restart` stops a service and then starts its replacement. Kubernetes mode targets local clusters only (kind, minikube, Docker Desktop) and refuses remote ones.
- **Not a crash supervisor.** `up` does not restart a service that crashes, and nothing comes back by itself after a reboot. In production, leave that to the platform or an init system: `portler start` runs one service in the foreground so the platform can supervise and restart it.

## Requirements

- Node.js `>= 22.6`
- Docker — only if you use Docker services
- `kubectl` and a local cluster (kind, minikube, or Docker Desktop Kubernetes) — only if you use Kubernetes mode

The CLI is written in TypeScript and runs directly on modern Node.js type stripping.

## Next steps

- [Getting started](/guide/getting-started) — install Portler and run your first stack.
- [Services & environment](/guide/services) — how services, env values, and references work.
- [portler.yml reference](/reference/configuration) — every configuration option.
