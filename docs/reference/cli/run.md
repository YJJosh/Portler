# portler run

Run a task, or any command, on this machine with a service's environment.

```bash
portler run                                  # list the tasks
portler run [docker|k8s] <task> [-- <args>...] [--prod] [--volume-set <name>]
portler run [docker|k8s] <service> -- <command>... [--prod] [--volume-set <name>]
```

```yaml
tasks:
  psql: docker exec -it ${db.container} psql -U postgres app
  migrate:
    run: pnpm db:migrate
    service: api
    description: Apply database migrations
```

```bash
portler run migrate
portler run migrate -- --dry-run             # "pnpm db:migrate --dry-run"
portler run api -- pnpm prisma studio
portler run api -- sh -c 'echo $DATABASE_URL'
```

## Behavior

- **A task** runs its `run` command through the shell. [References](/guide/services#service-references) in it resolve first, as in a healthcheck command (`${db.container}`, `${db.address}`), and the words after `--` are appended, each quoted. With `service:` the command gets that service's env and runs in its `cwd`; without it, the project's env and the generated [`PORTLER_*` variables](/reference/environment), in the project root.
- **A service** runs the words after `--` with that service's env, in its `cwd`. The command is required.
- **Seen from this machine.** The command runs here, not in the service's container, so `${db.address}` is `localhost:<port>` even for a service that runs in a container. The rest of the env is what the service gets: its `env:`, `docker.env` in Docker mode, `default:` entries, your shell and the `use_env` files.
- **The run mode** is the one the service was last started in, as for [`portler env`](/reference/cli/env): after `portler up docker` its `docker.env` applies. A typed `docker` or `k8s`, or `--prod`, wins over the record. Under `k8s` the addresses go through the port-forwards that `up k8s` keeps open.
- **Ports.** A service that is not running gets its port assignment like `portler env`; nothing is started. Start the database first if the command needs it.
- **Missing values** marked `required: true` (or required under `--prod`) are printed as a warning, not an error: the command may not need them.
- **Exit code** is the command's. The command runs in the foreground with this terminal, so interactive programs such as `psql` work; Ctrl-C goes to the command, and Portler waits for it to exit.
- `portler run` does not hold the project lock while the command runs, so a long session does not block `up` or `down`.

Task names cannot be a service name, `docker` or `k8s`. See [tasks](/reference/configuration#tasks).
