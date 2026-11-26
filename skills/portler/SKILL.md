---
name: portler
description: Run a project's services on conflict-free ports with the portler CLI and portler.yml. Use in any checkout that has a portler.yml or portler.yaml, to start or stop dev servers and Docker services, find their ports, URLs, env and logs, or edit that file.
---

# Portler

Only use Portler if the checkout has `portler.yml` (or `portler.yaml`); otherwise use the project's default ports. All `Portler docs:` paths below refer to Portler's own version-pinned docs (see *Documentation*).

Portler allocates conflict-free ports per checkout (`51000–59999`) for local processes, Docker, and local Kubernetes:

- **Env injection:** `$PORTLER_<SERVICE>_PORT` is the assigned host port; `port_env` (e.g. `PORT`) is the listen port (assigned port locally; declared `port:` in Docker/k8s).
- **References & exports:** `${svc.port}`, `svc.url` (also `host`, `protocol`, `container`, `image`), exports like `${db.database_url}`, and reader-aware `${svc.address}` (`localhost:<assigned>` on host, `svc:<declared>` in containers/pods, `host.docker.internal:<assigned>` container→host; on Linux, a host process reached from a container must bind a bridge-reachable interface, e.g. `0.0.0.0`). Portler docs: `guide/services`.

```
portler init                              # write a starter portler.yml
portler up [docker|k8s] [service...] -d   # allocate ports, run setup (local/Docker), start detached
portler ps [service...]                   # status, pid, port, URL, container
portler logs [service...] [--follow]      # detached logs (--follow follows local logs across restarts)
portler env [service]                     # resolved env as started (mode, --prod)
portler run [task]                        # list/run a "tasks:" entry with its service's env
portler run <service> -- <command>        # run any command on host with that service's env
portler ports                             # current port allocations
portler restart [docker] [service...]     # restart local/Docker detached, keeping ports and launch flags
portler down [docker|k8s] [service...]    # stop services and release ports
portler setup [docker] [service...]       # run setup steps without starting services
portler clean [--ports|--global]          # remove .portler/ state and release ports
portler volumes list|fork|remove          # manage "@name" Docker volumes
```

## Working in a checkout

- **Start detached:** use `portler up -d` (foreground blocks and stops the stack on exit). Ctrl-C/SIGTERM during startup rolls back only what that invocation started.
- **Never hardcode ports:** read them from `portler ps`, `portler env <service>`, or `PORTLER_*`.
- **Don't start over running services:** `up` (including `up k8s`) refuses running services, surviving process groups (`running (group)`), and dead-supervisor/unverifiable containers (`env` preserves their port assignments). Never delete PID entries or start a duplicate; use `portler restart <service>` to apply changes (for k8s, `down k8s` then `up k8s -d`).
- **Debug failures:** check `portler ps` (`dead (stale)` = exited), inspect `portler logs <service>`, fix, and restart (`portler restart` for local/Docker; `down k8s` + `up k8s -d` for k8s).
- **Stop only what you started:** check `portler ps` first; stop only yours with `portler down [k8s] <service...>`. Use bare `portler down` only when nothing was running before you (`down <service>` warns on running dependents).
- **No `--force` without asking:** never pass `--force` to `down`, `clean`, or `volumes fork`/`remove` unless the user asks (`down --force` can signal unverifiable processes; `clean --force` stops running services; `volumes fork --force` risks corrupt DB copies). Plain `clean` refuses running or unverifiable services.
- **Kubernetes context:** `env` and `down k8s` target the context `up k8s` deployed to — use the same `KUBECONFIG`. `up k8s` refuses another context while Deployments remain (`down k8s` first). Portler docs: `guide/kubernetes`.
- **State:** `.portler/` holds runtime state and belongs in `.gitignore`.

## portler.yml essentials

- **Per-service keys:** `command`+`cwd` or `image`/`build`, `port`, `transport` (`tcp` default, `udp`, `tcp+udp`), `port_env`, `env`, `depends_on`, `healthcheck` (`tcp`/`http`/`command`), `volumes` (`@name:` = managed), `setup`.
- **Top-level keys:** `use_env: .env` (missing fails dev `up`, allowed with `--prod`), `setup`, `proxy:` (`port: auto`, `routes: {/api: backend, /: frontend}`, longest prefix), `prod` overrides, `tasks:` (`{name: cmd}` or `{run, service, description}`, refs resolve). Reserved service names: `docker`, `k8s`, `self`, `env` (and `proxy` when `proxy:` exists).
- **Presets (`use:`):** `postgres@18`, `mysql@8.4`, `redis@8` (built-ins and local presets with `versions:` require a version matching existing volume data), or an unversioned local preset file; service keys win, `env`/`exports` merge. Read `${db.database_url}` / `${cache.redis_url}` instead of copying URLs into `docker.env`/`k8s.env`. Portler docs: `guide/databases`.
- **Env mappings:** `{ default: x }` (shell/`.env` wins), `required: true|prod`, `secret: true` (hidden by `portler env`), `description`. On missing required keys, ask the user or set them in `use_env` — never invent values. Portler docs: `reference/configuration`.
- **Setup steps (local/Docker only; `up k8s` ignores setup):** run before start; plain steps run once per checkout/mode/volume-set (and rerun on command change or recreated volume). Modifiers: `if_missing`, `watch`, `always: true`. `portler setup` / `up --setup` rerun plain steps; `up --no-setup` skips all setup. Keep steps idempotent. Portler docs: `guide/setup-and-production`.
- **Proxy behind a TLS edge:** keep root `host: 127.0.0.1`; set `proxy.host: 0.0.0.0` only for a remote edge (bind only, not advertised URLs). Set `proxy.allowed_hosts` and exact-IP `proxy.trusted_proxies` (no CIDRs/wildcards/hostnames, default `[]`, no implicit loopback trust); the edge must strip/overwrite caller forwarding headers.
- **Proxy security:** Portler does no TLS or auth — restrict proxy access, let backends trust forwarding metadata only from Portler, and check `portler ports` for the assigned port. Full header/trust policy: Portler docs `guide/proxy`.

## Database volumes: prefer isolated forks

Port isolation is not data isolation: linked Git worktrees share project-scoped `@` volumes in dev (separate clones do not), and under `--prod` with top-level `name:` **all** checkouts and clones share production volumes.

- **Baseline & task forks:** keep a clean seeded **baseline** untouched (refresh only intentionally; no experimental migrations or destructive tests on it) and fork a unique set per task/test (e.g. `work-issue-123`). Never share a writable set across concurrent agents.
- **Scenario templates:** prepare difficult cases (legacy schemas, odd records, large data) on separate forks, record seed steps and compatible schema version, and re-fork the scenario per experiment (`postgres-data--legacy-schema` → `repro-issue-123`). Use only synthetic or approved sanitized data.
- **Stop writers before forking:** stop the DB and all writers (including other checkouts; coordinate first). `volumes fork` copies raw files and refuses mounted volumes — never pass `--force`; use native DB backup/restore if stopping is not possible.
- **Volume-set rules:** `--volume-set` (or `PORTLER_VOLUME_SET`) selects all `@` volumes without auto-cloning (fork each needed volume or missing ones start empty; fork targets must be new; stop the stack before switching; verify with `portler volumes list`). For `--prod`, pass `--prod` to every `volumes` and `up` call (`down` takes no `--prod`).
- **Tools that create volumes:** read `portler volumes list --json` (`prefix`, `owner` = the `portler.project` label value, `volumeSet`, each volume's `name`/`fullName`/`exists`/`usedBy`). Create new volumes in a new set with labels `portler.project=<owner>`, `portler.volume=<name>` and `portler.volume-set=<set>`, or Portler refuses to mount them.
- **Scope & cleanup:** does not isolate bind mounts, unmanaged volumes, k8s PVCs, or external DBs — create per-task copies/databases for those and verify the app targets the isolated database. When done, stop what you started and remove only disposable forks you created (`portler volumes remove <vol>--<set>`); preserve baselines, scenario templates, and user data, with no broad pruning.

```bash
# Unset PORTLER_VOLUME_SET here; bare source names follow the active set
portler volumes list
portler volumes fork postgres-data baseline                  # once, with writers stopped
portler volumes fork postgres-data--baseline work-issue-123  # per task (or fork a scenario template)
portler up -d --volume-set work-issue-123
portler down                                                 # only if bare up above succeeded; else down <service...>
```

Portler docs: `guide/volumes`, `guide/databases`, `guide/setup-and-production`.

## Documentation

Read docs for the **installed** version (`portler --version`), not memory — `portler.yml` can still change before 1.0.

- **Version-pinned Markdown:** `https://raw.githubusercontent.com/YJJosh/Portler/v<version>/docs/<page>.md` (or `git clone --depth 1 --branch v<version> https://github.com/YJJosh/Portler`).
- **Latest site:** https://yjjosh.github.io/Portler/ (`guide/proxy` → `docs/guide/proxy.md`, `reference/cli/` → `docs/reference/cli/index.md`).
- **Pages:** `guide/` (`getting-started`, `services`, `ports`, `dependencies`, `setup-and-production`, `docker`, `volumes`, `databases`, `proxy`, `kubernetes`); `reference/` (`configuration`, `environment`, `generated-files`, `cli/<command>`).
- A 404 at your tag or a rejected flag means it is not in your version. Follow your tag's docs over this file, and ask the user before upgrading Portler.
