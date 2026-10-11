# Setup & production

Keep installation, generation, development and production commands together:

```yaml
setup:
  - run: pnpm install
    if_missing: node_modules    # only while nothing is there yet
prod:
  setup:
    - pnpm install --frozen-lockfile
    - run: pnpm build
      always: true              # every deploy, not once per checkout
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

Each `setup` entry is a shell command, or a step object with `run` plus one modifier. A plain command runs once per checkout and keeps a receipt; `if_missing: <path>` runs only while nothing exists at that path; `always: true` runs every time. See [the configuration reference](/reference/configuration#setup-and-prod).

## Fresh checkouts and workspaces

```bash
git clone <repository>
cd <repository>
portler up
```

On a fresh checkout, `up` runs top-level setup before starting anything. Each service's setup runs just before that service starts, after its dependencies reach their configured readiness condition. Every plain step that succeeds is remembered per checkout and mode, so later down/up cycles skip it; changing a step's command or cwd runs that step again. `--setup` forces every plain step; `--no-setup` runs no setup command but still reconciles receipts, so a step removed during such a run does not keep a stale one. The first failure stops the run, and the steps before it keep their receipts, so fixing the cause and running `up` again continues from the failed step.

Only definitions are fingerprinted, **not** lockfiles, source files, environment values or ports. A step that must follow those inputs is better expressed with a modifier: `if_missing: node_modules` makes an install run exactly when the folder is gone, and `always: true` makes a build or code generator run on every `up`. For the rest, run `portler setup` or `portler up --setup` after changing such inputs. Use idempotent setup commands.

Workler can create a workspace and hand off to `portler setup`. This performs setup only, in dependency order, without starting any service. A later `portler up` reuses the success receipts. A Workler workspace whose `link node_modules` rule found something to link to already has its dependencies: an install step guarded with `if_missing: node_modules` is skipped there and runs only in a workspace (or checkout) that has none. Setup requiring a live database must have an external database available, or be deferred to `up`'s dependency-aware startup.

## Build and start on platforms

For Cloudler or a platform that supports a build command and a long-running start command (such as Azure Web Apps):

| Platform phase | Command |
| --- | --- |
| Build / workspace preparation | `portler setup --prod` |
| Start | `portler start api --prod` |

A platform that runs `portler setup --prod` as its build step gets every plain step every time, since explicit `setup` ignores receipts. A platform that runs `portler up --prod` instead (a host without Docker images that just needs a long-running process) only gets plain steps once per checkout: mark the install and build steps `always: true` there, or the second deploy onto the same checkout skips them.

Ensure Portler and your package manager are installed in both build and runtime environments. Bind the application to the platform's required interface (usually `0.0.0.0`), and use `port_env: PORT`. Platform `PORT` and secrets override the file during `start`. Set production database URLs and public build-time URLs through appropriate config/env settings; `setup` uses development-style assigned ports, whereas `start` resolves declared endpoints unless platform values replace them.

Vercel can use `portler setup --prod` as its **Build Command**. Vercel's usual framework/serverless deployments do not run an arbitrary persistent start command: use its framework adapter/output settings rather than `portler start`. Only map `portler start api --prod` on hosting products that actually support a long-running process.

Under `--prod` (and always in `portler start`) the deployment's own values win over `portler.yml`: the process environment first, then the `use_env` file, then root and service env from the config. A development value in config, such as a localhost URL, is only a fallback, and a blank entry in `prod.env` means the value must come from the deployment. A config value the deployment overrides is not resolved at all, so a reference that only works in development, such as `db.url` for a service with no assignment there, cannot block the deployment's value. Generated `PORTLER_*` values and `port_env` keys stay Portler's own everywhere; in `start` the platform's `PORT` selects the port and those values are derived from it. Deploys usually start from a fresh checkout without the gitignored env files, so `--prod` and `portler start` skip a missing `use_env` file (with a notice) and rely on the platform env; dev runs still fail on a missing file. Containers in `up docker --prod` only receive variables named in `portler.yml` or its env files, not the whole shell environment, so put their secrets in an env file on the server. That file holds production values: a development `.env` with localhost addresses would win over the Docker-mode addresses there.

## Production overrides and run modes

`--prod` replaces setup/command definitions and merges env; missing overrides fall back to dev definitions. An empty setup list disables inherited setup. `prod` is an ordinary service name, not a positional mode token.

`prod.env` also applies to Docker containers. `prod.command` replaces `command`, so it only changes a container that runs `command` (a service with a top-level `image`/`build`); a `docker:` block keeps its own `docker.command` or the image's `CMD`, since the local `prod.command` usually assumes the host checkout and `cwd`. `portler setup docker --prod` runs host setup with Docker-mode env; it does not execute setup inside images. Kubernetes keeps its existing image-build/manifests flow, ignores setup definitions, and rejects `up k8s --prod`, `--setup` and `--no-setup` rather than silently applying partial overrides.

Like existing `up`, an invocation overlapping running services fails with an explicit `down` instruction. Stop services before switching dev/prod or forcing setup; Portler never silently keeps dev processes running under a production invocation. `restart --prod` restarts with the production overrides, and a plain `restart` of a service that was started with `--prod` is refused rather than relaunched in development mode.
