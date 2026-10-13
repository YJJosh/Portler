---
name: portler
description: Run a project's services on conflict-free ports with the portler CLI and portler.yml. Use in any checkout that has a portler.yml, to start or stop dev servers and Docker services, find their ports, URLs, env and logs, or edit portler.yml.
---

# Portler

Portler allocates non-conflicting ports per checkout (default range 51000–59999) and runs the services defined in `portler.yml` as local commands, Docker containers, or on a local Kubernetes cluster. Assigned ports are injected as env vars (`$PORTLER_<SERVICE>_PORT`, plus whatever `port_env` names, e.g. `PORT`). Env values can reference other services: `${postgres.port}`, `backend.url` (also `host`, `protocol`, `container`, `image`).

Only use Portler if the checkout has a `portler.yml`; otherwise use the project's default ports.

```
portler init                              # write a starter portler.yml
portler up [service...] -d                # run setup, allocate ports, start service(s) + deps in the background
portler up docker|k8s [service...] -d     # Docker / Kubernetes run mode
portler ps [service...]                   # status, pid, port, URL, container
portler logs [service...] [--follow]      # output of detached services
portler env [service]                     # resolved env for a service
portler ports                             # current allocations
portler restart [service...]              # restart in the background with the same ports and launch flags
portler down [docker|k8s] [service...]    # stop services and release ports
portler setup [service...]                # run setup steps without starting anything
portler clean [--ports|--global]          # remove .portler/ state and release ports
portler volumes list|fork|remove          # manage Portler-managed "@name" Docker volumes
```

## Working in a checkout

- Start services with `portler up -d`. A foreground `up` blocks your shell and stops the stack when it exits.
- Never hardcode ports: they differ between checkouts and runs. Read them from `portler ps` or `portler env <service>`, or use the `PORTLER_*` variables.
- `up` refuses services that are already running. To pick up a change in a running service, use `portler restart <service>`.
- When something fails, check `portler ps` (`dead (stale)` means the process exited), then `portler logs <service>`. Fix the cause and `restart`.
- Stop what you started with `portler down` when you are finished, and leave services the user started alone. `portler down <service>` warns when running services depend on it.
- Do not pass `--force` to `down` or `clean` unless the user asks: `down --force` can signal processes whose identity Portler cannot verify, and `clean --force` stops running services first.
- `.portler/` holds runtime state and belongs in `.gitignore`.

## portler.yml essentials

Per service: `command` + `cwd` (local) or `image`/`build` (Docker), `port`, `port_env`, `env`, `depends_on` (start order), `healthcheck` (`tcp`/`http`/`command`), `volumes` (`@name:` prefix = Portler-managed, project-scoped), `setup`. Top level: `use_env: .env` (listed files must exist or `up` fails), `setup`, an optional `proxy:` block (`port: auto`, `routes: {/api: backend, /: frontend}`, longest prefix wins) serving the whole stack behind one URL, and `prod` overrides used with `--prod`. `docker`, `k8s`, and `proxy` are reserved service names.

`setup` steps run on `up` before their service starts. A plain command runs once per checkout (again when the command changes), `{run: npm install, if_missing: node_modules}` only while that path is missing, `{run: ..., watch: [prisma/schema.prisma]}` again when a listed file changes, and `{run: ..., always: true}` on every `up`. `up --no-setup` skips them.

## Database volumes: prefer isolated forks

When an app uses a database, **prefer a separate volume set per checkout/task or test run**, rather than pointing everything at the same writable volume. Port isolation is not data isolation: linked Git worktrees share Portler's project-scoped volumes unless you select different sets. A separate clone (a Workler workspace, say) is its own project, so its volumes start empty.

- Keep a known-good, seeded **baseline** (the default volume or a named `baseline` set) as the source for forks. Treat it as a reusable template, not an everyday working database; do not run experimental migrations or destructive tests against it. Only refresh it intentionally.
- Fork that baseline for normal development, using a descriptive, unique set name such as `work-issue-123`. Concurrent checkouts/agents must not reuse the same writable set.
- Keep separate, reproducible **scenario templates** for difficult app behavior: legacy schemas, partial migrations, unusual/invalid records, large datasets, or permission edge cases. Prepare these on forks, record the seed/setup steps and compatible app/schema version, then fork the scenario again for each test so the original reproduction stays intact. Use synthetic or approved sanitized data.
- Before forking, cleanly stop the database and all writers using the source, including those in other checkouts; coordinate before interrupting someone else's services. `volumes fork` copies files, not a database-aware snapshot, so a live copy can be inconsistent. If stopping is not possible, use the database's supported backup/restore mechanism instead.

Example for a managed volume declared as `@postgres-data:...` (replace names and use the project's usual local/Docker run mode):

```bash
portler volumes list
# Once a clean, seeded default database exists and its writers are stopped:
# Ensure PORTLER_VOLUME_SET is unset here; bare source names follow the active set.
portler volumes fork postgres-data baseline

# Everyday work: copy the baseline, then explicitly select the fork.
portler volumes fork postgres-data--baseline work-issue-123
portler up -d --volume-set work-issue-123
portler down

# Prepare a difficult-case template separately from the baseline.
portler volumes fork postgres-data--baseline legacy-schema
# Populate/reproduce the scenario using --volume-set legacy-schema, then stop it.
# Each experiment gets its own copy of that prepared scenario:
portler volumes fork postgres-data--legacy-schema repro-issue-123
portler up -d --volume-set repro-issue-123
portler down
```

`--volume-set` (or `PORTLER_VOLUME_SET`) selects variants of **all managed `@name` Docker volumes**; it does not clone them automatically. Fork each required data volume into the same set before starting the stack, otherwise missing variants start empty. Stop the current stack before switching sets, and verify the selected set with `portler volumes list`. A fork target must be new; use a fresh name rather than deleting an existing dataset blindly.

This does not isolate bind mounts, unmanaged Docker volumes, Kubernetes PVCs, or external databases. Use equivalent per-task copies/databases for those, and verify the app's connection settings actually target the isolated database. When finished, stop services with `portler down`; remove only disposable forks you created and no longer need (e.g. `portler volumes remove postgres-data--repro-issue-123`). Preserve the baseline, reusable scenarios, and user-owned data; do not use force or broad volume pruning as routine cleanup.

## Documentation

Read the docs for the version that is installed; Portler changes between releases. `portler --version` prints it (e.g. `0.2.1`).

- **Markdown, pinned to that release:** `https://raw.githubusercontent.com/YJJosh/Portler/v<version>/docs/<page>.md`, e.g. `.../v0.2.1/docs/reference/configuration.md`. The `v<version>` tag is the commit the release was built from, so these pages describe exactly the CLI you have. To read many pages, `git clone --depth 1 --branch v<version> https://github.com/YJJosh/Portler` and open `docs/`.
- **Website, latest release only:** https://yjjosh.github.io/Portler/. A page such as `guide/proxy` is `docs/guide/proxy.md`; `reference/cli/` is `docs/reference/cli/index.md`.

Pages: `guide/` getting-started, services, ports, dependencies, setup-and-production, docker, volumes, proxy, kubernetes; `reference/` configuration (every `portler.yml` key), environment, generated-files, and `cli/<command>` for each command.

A page that returns 404 at your tag, or a command or flag the CLI rejects, does not exist in your version. Follow the docs at your tag over this file, and ask the user before upgrading Portler.
