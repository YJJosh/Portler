# Ports

Automatic port assignment is Portler's core feature. This page explains how a service gets its port and how to steer the process when you need to.

## How assignment works

Every service that declares a `port:` gets a port assigned when the stack starts. For each service, Portler picks the first free candidate in this order:

1. **The service's registry reservation** — the port it held the last time it ran, recorded in the global registry (`~/.portler/ports.json`).
2. **Its declared `port:`** — but only when `prefer_declared_port: true` is set (see below).
3. **Its previous assignment** from the project's `.portler/state.json`.
4. **A scan of the port range** (`51000`–`59999` by default). The scan starts at an offset derived from a hash of the project directory and service name, so each service has a stable "home" in the range and different projects spread out instead of contending for the same low ports.

Freeness is verified with a real TCP probe, and services that are **currently running** keep their port verbatim — their port is busy precisely because they're listening on it.

The result: ports are **sticky**. Restarting a stack normally reproduces the same ports, and a stack that's already running is never disturbed.

## The declared port is a preference

```yaml
services:
  backend:
    command: npm run dev
    port: 4000
    port_env: PORT
```

`port: 4000` documents the service's conventional port, but Portler does not insist on it — if 4000 is busy (another project, another worktree), the backend simply gets a different free port. Your app must therefore read its port from the environment, which is what `port_env` is for: Portler sets `PORT` to the assigned port before starting the command.

`port_env` accepts one name or a list:

```yaml
port_env: [PORT, HTTP_PORT]
```

::: info Docker services
For Docker services, `port:` is the **internal container port** and `port_env` receives that internal port — Docker's `-p` mapping translates the assigned host port to it. From the host's perspective (URLs, references, `PORTLER_*_PORT`), the assigned host port is what counts.
:::

## Preferring the declared port

If you want a service to actually claim its declared port whenever it's free:

```yaml
prefer_declared_port: true    # top level: default for all services

services:
  backend:
    port: 4000
    prefer_declared_port: true   # or per service
```

With this set, the declared port is tried **before** the previous assignment, so the service returns to its declared home once that port frees up instead of sticking to a drifted port forever.

## The port range

```yaml
port_range:
  start: 51000
  end: 59999
```

`port_start` / `port_end` at the top level are accepted as a flat alternative. The default range is `51000`–`59999`.

## The global registry

Assignments are recorded in `~/.portler/ports.json`, shared by all projects on the machine, so two Portler projects never hand out the same port even when started concurrently (a lock file serializes allocation). Entries are pruned automatically when their port is free again and the reservation is old enough.

Related commands:

```bash
portler ports           # show this project's assigned ports
portler clean --ports   # release this project's reservations
portler clean --global  # prune stale entries left by crashed/deleted projects
```

## Hosts, URLs, and protocol

Three settings control how addresses are built, at the top level or per service:

```yaml
host: 127.0.0.1      # where services bind / where Portler probes
url_host: localhost  # what generated URLs use
protocol: http       # URL scheme
```

A generated URL is `<protocol>://<url_host>:<assigned port>`. The defaults suit almost everyone; change them for things like binding on all interfaces (`host: 0.0.0.0`) while keeping `localhost` URLs.
