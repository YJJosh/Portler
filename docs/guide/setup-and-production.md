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

Each `setup` entry is a shell command, or a step object with `run` plus one modifier. A plain command runs once per checkout and keeps a receipt; `if_missing: <path>` runs only while nothing exists at that path; `always: true` runs every time; `watch: [files]` makes a plain step run again when one of the listed files changes, a lockfile for an install. See [the configuration reference](/reference/configuration#setup-and-prod).

## Fresh checkouts and workspaces

```bash
git clone <repository>
cd <repository>
portler up
```

On a fresh checkout, `up` runs top-level setup before starting anything. Each service's setup runs just before that service starts, after its dependencies reach their configured readiness condition. Every plain step that succeeds is remembered per checkout and mode, so later down/up cycles skip it; changing a step's command or cwd runs that step again. `--setup` forces every plain step; `--no-setup` runs no setup command but still reconciles receipts, so a step removed during such a run does not keep a stale one. The first failure stops the run, and the steps before it keep their receipts, so fixing the cause and running `up` again continues from the failed step.

Only definitions are fingerprinted, **not** lockfiles, source files, environment values or ports, unless a step names files in `watch:`. A step that must follow those inputs is better expressed with a modifier: `watch: [pnpm-lock.yaml]` makes an install run again when the lockfile changes, `if_missing: node_modules` makes it run exactly when the folder is gone, and `always: true` makes a build or code generator run on every `up`. For the rest, run `portler setup` or `portler up --setup` after changing such inputs. Use idempotent setup commands.

Workler can create a workspace and hand off to `portler setup`. This performs setup only, in dependency order, without starting any service. A later `portler up` reuses the success receipts. A Workler workspace whose `link node_modules` rule found something to link to already has its dependencies: an install step guarded with `if_missing: node_modules` is skipped there and runs only in a workspace (or checkout) that has none. Setup requiring a live database must have an external database available, or be deferred to `up`'s dependency-aware startup.

`portler setup` skips a missing `use_env` file with a notice, in development too: on a fresh checkout the file is usually what setup, or the tool that ran it, creates. Its values are read before the steps run, so a file a step writes counts from the next command on. `up` in development still requires the file.

## Build and start on platforms

For Cloudler or a platform that supports a build command and a long-running start command (such as Azure Web Apps):

| Platform phase | Command |
| --- | --- |
| Build / workspace preparation | `portler setup --prod` |
| Start | `portler start api --prod` |

A platform that runs `portler setup --prod` as its build step gets every plain step every time, since explicit `setup` ignores receipts. A platform that runs `portler up --prod` instead (a host without Docker images that just needs a long-running process) only gets plain steps once per checkout: mark the install and build steps `always: true` there, or the second deploy onto the same checkout skips them. `up --prod` also allocates its own ports and ignores the platform's `PORT`, so on a host that routes traffic to the `PORT` it assigns, use `portler start`. `start` returns only when the whole process group has exited: after the shell it launched exits, it waits up to ten seconds (`--drain-ms`) for the rest, so a server that handles SIGTERM by draining connections is not cut off the moment the shell dies; what is still there at the deadline is killed.

Ensure Portler and your package manager are installed in both build and runtime environments. Bind the application to the platform's required interface (usually `0.0.0.0`), and use `port_env: PORT`. Platform `PORT` and secrets override the file during `start`. Set production database URLs and public build-time URLs through appropriate config/env settings; `setup` uses development-style assigned ports, whereas `start` resolves declared endpoints unless platform values replace them.

Vercel can use `portler setup --prod` as its **Build Command**. Vercel's usual framework/serverless deployments do not run an arbitrary persistent start command: use its framework adapter/output settings rather than `portler start`. Only map `portler start api --prod` on hosting products that actually support a long-running process.

Under `--prod` (and always in `portler start`) the deployment's own values win over `portler.yml`: the process environment first, then the `use_env` file, then root and service env from the config. A development value in config, such as a localhost URL, is only a fallback, and a blank entry in `prod.env` means the value must come from the deployment. A config value the deployment overrides is not resolved at all, so a reference that only works in development, such as `db.url` for a service with no assignment there, cannot block the deployment's value. The same holds for a root value that a service's own env replaces: it is not resolved for that service. Generated `PORTLER_*` values and `port_env` keys stay Portler's own everywhere; in `start` the platform's `PORT` selects the port and those values are derived from it. Deploys usually start from a fresh checkout without the gitignored env files, so `--prod` and `portler start` skip a missing `use_env` file (with a notice) and rely on the platform env; dev runs still fail on a missing file. Containers in `up docker --prod` receive only the variables `portler.yml` names for them: root `env`, the service's `env` and `prod.env`, `prod.require`, generated values and `port_env`. A value that is only in the `use_env` file or the shell is not forwarded, so one env file on the server can hold every secret of the deployment without each container seeing all of them; name the keys a service needs in its `prod.env` (a blank entry is enough) or in `prod.require`. The file holds production values: a development `.env` with localhost addresses would win over the Docker-mode addresses there.

## Required values and external services

```yaml
prod:
  require: [BETTER_AUTH_SECRET, BETTER_AUTH_URL, CORS_ORIGIN]
  services: [api, web]        # postgres is a managed database in production
services:
  api:
    prod:
      require: [DATABASE_URL]
```

`prod.require` names what the deployment has to supply. With `--prod`, `up`, `setup`, `start` and `restart` check those keys before running or stopping anything and fail naming the missing ones, so a forgotten platform variable fails the deploy instead of starting the app against a development default. A required key is the deployment's to supply: neither its config value nor a value Portler generates (`PORTLER_*`, a `port_env` name such as `PORT`) counts, and it is forwarded to containers whether or not an `env:` names it. Top-level `require` applies to every service and to top-level setup; a service's `require` to that service only.

`prod.services` names the services that run under `--prod`. The rest are external, a managed database or a hosted queue reached through values the deployment supplies: they are not started, dependencies on them are dropped, a route in `proxy` to one is an error, and naming one on the command line is an error. A reference to a left-out service, such as `${postgres.port}`, must then be replaced by a deployment value, which `require` makes explicit.

`portler env api --prod` prints what `up --prod` hands the service: the deployment's values with that precedence and only the keys the service receives, secret-looking values masked unless `--reveal` is given, and a note on stderr for missing required keys.

## Stable identity on a server

Docker objects are named after the project directory and a hash of its path, so two checkouts of one project never collide. On a server that works against you: a release that unpacks into a new folder gets a new hash, so `up --prod` creates a fresh network, fresh containers and, worse, fresh empty volumes while the previous release's data sits under the old names. Give the project a name:

```yaml
name: todo
```

Under `--prod` the containers are then `portler-todo--<service>`, the network `portler-todo`, and `@` volumes `portler-todo--<volume>`, whichever folder the release lives in; development runs are unchanged. The collision this creates is the point: if the previous release is still up when the new one starts, Docker refuses the container name, so stop the previous release first (`portler down` in its folder) or deploy into the same folder. `portler volumes --prod` lists, forks and removes the production volumes and leaves the development ones alone. Two stacks of one project on a host, say staging and production, need two names, so keep them in two config files (`--file portler.staging.yml`). An explicit `container_name:` or `docker_network:` is kept as written, and built images keep their hashed default name.

## Production overrides and run modes

`--prod` replaces setup/command definitions and merges env; missing overrides fall back to dev definitions. An empty setup list disables inherited setup. `prod` is an ordinary service name, not a positional mode token.

`prod.env` also applies to Docker containers. `prod.command` replaces `command`, so it only changes a container that runs `command` (a service with a top-level `image`/`build`); a `docker:` block keeps its own `docker.command` or the image's `CMD`, since the local `prod.command` usually assumes the host checkout and `cwd`. `portler setup docker --prod` runs host setup with Docker-mode env; it does not execute setup inside images. Kubernetes keeps its existing image-build/manifests flow, ignores setup definitions, and rejects `up k8s --prod`, `--setup` and `--no-setup` rather than silently applying partial overrides.

Like existing `up`, an invocation overlapping running services fails with an explicit `down` instruction. Stop services before switching dev/prod or forcing setup; Portler never silently keeps dev processes running under a production invocation. `restart` replays how a service was started unless given a flag: a plain `restart` of a service started with `--prod` keeps it in production, in the run mode, with the `--image` pin and the `--no-setup` it was started with (`pids.json` records all four). `--prod`, `docker`, `--image` and `--setup`/`--no-setup` override that for the services the restart starts again, and what the restart leaves running has to agree: a dependency left in the other mode or run mode is refused before anything is stopped, and so are recorded services that disagree on `--no-setup`, since setup is one choice for the whole restart. Switching a whole stack is `portler restart --prod` with no names, or `down` and then `up --prod`.
