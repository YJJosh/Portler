# portler start

Run one local service in the foreground for a deployment platform.

```bash
portler start [service] [--prod]
```

- Uses the service's `command` (or `prod.command` with `--prod`) in its `cwd`.
- Inherits stdin, stdout and stderr; forwards SIGINT/SIGTERM to the shell and its process group. Returns the child's exit code (or `128 + signal number` if the shell is terminated by a signal).
- The command must stay in the **foreground**. A command that backgrounds (`node server.js &`) or daemonizes exits immediately, so `start` returns success while the real process is no longer supervised, which looks like a crash loop on most platforms. Like `setup`, the command has no controlling terminal (`/dev/tty`).
- Writes **no state**, starts no dependencies or proxy, performs no setup, and uses no supervisor. Run `portler setup --prod` separately as the build step.
- If the service is omitted, selects the only local service with a command. Otherwise the error lists candidates. Docker services are rejected.

## Ports and environment

The service port is `PORT` from the environment, otherwise the declared `port`, otherwise a free ephemeral port. Invalid `PORT` values are errors. The chosen port is exposed through the service's `port_env` names; add `port_env: PORT` for apps that read it. Unlike `up`, there is no global registry and no preferred-port probing for declared/platform ports.

Existing process environment values win over `.env` and config values, including production overrides, generated values and `port_env` names. This lets platform secrets and settings override local development defaults. Remaining values layer `use_env` (a missing file is skipped, since deploys rarely ship it), root env, then service env; production env is merged at each respective level.

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
