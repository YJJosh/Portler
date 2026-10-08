# Setup & production

Keep installation, generation, development and production commands together:

```yaml
setup: pnpm install
prod:
  setup:
    - pnpm install --frozen-lockfile
    - pnpm build
  env:
    NODE_ENV: production

services:
  api:
    cwd: apps/api
    port: 4000
    port_env: PORT
    command: pnpm dev
    setup: pnpm generate
    prod:
      command: pnpm start
      setup: []                 # root production build already handles this
      env:
        LOG_LEVEL: info
```

## Fresh checkouts and workspaces

```bash
git clone <repository>
cd <repository>
portler up
```

On a fresh checkout, `up` runs top-level setup before starting anything. Each service's setup runs just before that service starts, after its dependencies reach their configured readiness condition. A successful setup is remembered per checkout, step and mode. Later down/up cycles skip unchanged commands; changing commands or cwd invalidates the receipt. `--setup` forces a rerun; `--no-setup` skips it.

Only definitions are fingerprinted, **not** lockfiles, source files, environment values or ports. After changing those inputs, run `portler setup` or `portler up --setup`. Use idempotent setup commands; an interrupted or failed step is retried in full.

Workler can create a workspace and hand off to `portler setup`. This performs setup only, in dependency order, without starting any service. A later `portler up` reuses the success receipts. Setup requiring a live database must have an external database available, or be deferred to `up`'s dependency-aware startup.

## Build and start on platforms

For Cloudler or a platform that supports a build command and a long-running start command (such as Azure Web Apps):

| Platform phase | Command |
| --- | --- |
| Build / workspace preparation | `portler setup --prod` |
| Start | `portler start api --prod` |

Ensure Portler and your package manager are installed in both build and runtime environments. Bind the application to the platform's required interface (usually `0.0.0.0`), and use `port_env: PORT`. Platform `PORT` and secrets override the file during `start`. Set production database URLs and public build-time URLs through appropriate config/env settings; `setup` uses development-style assigned ports, whereas `start` resolves declared endpoints unless platform values replace them.

Vercel can use `portler setup --prod` as its **Build Command**. Vercel's usual framework/serverless deployments do not run an arbitrary persistent start command: use its framework adapter/output settings rather than `portler start`. Only map `portler start api --prod` on hosting products that actually support a long-running process.

Build-time env follows ordinary Portler precedence (config overrides process env). Avoid putting production secrets/public URL defaults in config that should come from the build platform; `use_env` files must exist if listed.

## Production overrides and run modes

`--prod` replaces setup/command definitions and merges env; missing overrides fall back to dev definitions. An empty setup list disables inherited setup. `prod` is an ordinary service name, not a positional mode token.

For Docker services, `prod.command` replaces the container's shell command and `prod.env` applies to its env. `portler setup docker --prod` runs host setup with Docker-mode env; it does not execute setup inside images. Kubernetes keeps its existing image-build/manifests flow, ignores setup definitions, and rejects `up k8s --prod`, `--setup` and `--no-setup` rather than silently applying partial overrides.

Like existing `up`, an invocation overlapping running services fails with an explicit `down` instruction. Stop services before switching dev/prod or forcing setup; Portler never silently keeps dev processes running under a production invocation. `restart` retains dev-mode behavior; use `down` then `up --prod` for production.
