# Portler

Portler is a local development process runner with automatic port assignment and environment resolution. It reads `portler.yml`, finds free ports, resolves references such as `backend.url`, and starts services in dependency order.

[Documentation](https://yjjosh.github.io/Portler/) · [Getting started](https://yjjosh.github.io/Portler/guide/getting-started) · [CLI reference](https://yjjosh.github.io/Portler/reference/cli/) · [Configuration reference](https://yjjosh.github.io/Portler/reference/configuration)

## Install

Portler requires Node.js 22.6 or newer.

```sh
npm install -g portler
portler --help
```

Portler supports **Linux and macOS**. On Windows, use **WSL2**; native Windows is intentionally unsupported because safe process teardown relies on POSIX process groups. Docker and Kubernetes tooling are only required when using those modes.

## Quick start

Generate a starter configuration and adapt it to your project:

```sh
portler init
```

A minimal `portler.yml` looks like this:

```yaml
services:
  backend:
    command: npm run dev
    port: 4000
    port_env: PORT

  frontend:
    command: npm run dev
    cwd: frontend
    port: 3000
    port_env: PORT
    depends_on:
      - backend
    env:
      VITE_API_URL: backend.url
```

Start and manage the stack:

```sh
portler up
portler up -d                    # run in the background
portler ps                       # show running services
portler logs backend --follow
portler down
```

Portler assigns an available host port to each service. Local processes receive it through `port_env`, and generated URLs and service references always use the resolved host port.

## Highlights

- [Automatic ports](https://yjjosh.github.io/Portler/guide/ports) let multiple projects and checkouts run side by side.
- [Service references](https://yjjosh.github.io/Portler/guide/services) keep URLs and environment variables in sync.
- [Dependency and health checks](https://yjjosh.github.io/Portler/guide/dependencies) control startup order.
- [Docker](https://yjjosh.github.io/Portler/guide/docker) and [local Kubernetes](https://yjjosh.github.io/Portler/guide/kubernetes) modes use the same configuration.
- [Managed volumes](https://yjjosh.github.io/Portler/guide/volumes) make it easy to fork local data between checkouts.
- An optional [reverse proxy](https://yjjosh.github.io/Portler/guide/proxy) serves the stack through one local origin.

Portler is designed for local development and verifies resource ownership before stopping processes or removing managed resources.

## Development

```sh
npm install
npm run verify
npm run docs:dev
```

## License

[MIT](LICENSE)
