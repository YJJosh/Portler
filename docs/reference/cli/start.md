# portler start

Run one local service in the foreground for a deployment platform.

```bash
portler start [service] [--prod] [--drain-ms <ms>]
```

- Uses the service's `command` (or `prod.command` with `--prod`) in its `cwd`.
- Inherits stdin, stdout and stderr; forwards SIGINT/SIGTERM to the shell and its process group. Returns the child's exit code (or `128 + signal number` if the shell is terminated by a signal).
- Returns only when the whole process group has exited. After the shell exits, `start` waits up to `--drain-ms` milliseconds (default 10000) for whatever the shell left running (a server it `exec`'d that is draining on SIGTERM, a process it backgrounded), then kills what is still there and returns the shell's exit code. `--drain-ms` takes whole milliseconds up to 2147483647 (about 24.8 days); a larger value is refused. A platform that watches Portler's pid therefore sees the app finish, not the shell. If something is still there after that (a member that survived SIGKILL, or a zombie under a PID 1 that does not reap), `start` says so on stderr and returns anyway.
- Keep the server in the **foreground** (`exec node server.js`). A command that backgrounds or daemonizes is not supervised: `start` only waits for the group to empty, then returns. Like `setup`, the command has no controlling terminal (`/dev/tty`).
- With `--prod`, `prod.require` keys must be present and non-empty in what the deployment supplies, the platform environment or the `use_env` file; `start` fails before running the command otherwise. Values `start` sets itself do not count: with `require: [PORT]` and `port_env: PORT`, a platform that sets no `PORT` fails instead of getting the declared or a free port. A `PORT` in the `use_env` file does not count either: `start` fills its `port_env` names with the port it listens on, and only the platform's `PORT` chooses that port. A service left out by `prod.services` cannot be started.
- Writes **no state**, starts no dependencies or proxy, performs no setup, and uses no supervisor. Run `portler setup --prod` separately as the build step.
- If the service is omitted, selects the only local service with a command. Otherwise the error lists candidates. Docker services are rejected.

## Ports and environment

The service port is `PORT` from the environment, otherwise the declared `port`, otherwise a free ephemeral port. Invalid `PORT` values are errors. The chosen port is exposed through the service's `port_env` names; add `port_env: PORT` for apps that read it. Unlike `up`, there is no global registry and no preferred-port probing for declared/platform ports.

Existing process environment values win over `.env` and config values, including production overrides. This lets platform secrets and settings override local development defaults. Generated `PORTLER_*` values, `PORTLER_SERVICE_NAME` and the `port_env` names stay Portler's own: the platform's `PORT` selects the port, and those values are derived from that choice, so a stale `PORTLER_*` value in the shell cannot reach the service. Below that, a `use_env` file (a missing file is skipped, since deploys rarely ship it) wins over root env and service env, so a file placed on the server also beats the config's development defaults; production env is merged at each respective level. File and platform values are used as written; only config values are Portler expressions, and a config key the file or the platform supplies is not resolved at all.

Service references resolve against **declared** ports/hosts, not saved development assignments. The selected service uses its chosen port. An unresolved reference fails with the variable's name, unless that variable is already provided by the platform. Services without declared ports cannot be reference targets (except the selected service); a proxy reference must be replaced by a platform env value because `start` runs no proxy.

```yaml
services:
  api:
    cwd: apps/api
    command: npm run dev
    port: 4000
    port_env: PORT
    prod:
      command: node dist/server.js
```

```bash
PORT=8080 portler start api --prod
```

`--file <path>` selects another config. See [Setup & production](/guide/setup-and-production) for platform mapping.
