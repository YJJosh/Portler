# portler down

Stop services started by Portler.

```bash
portler down [docker|k8s] [service...] [--volumes] [--force]
```

## Behavior

- Stops the selected services (all by default): local processes are signalled, Docker containers stopped and removed.
- Stops dependents before what they depend on: with `api` and `worker` depending on `redis`, both are stopped (and given their grace period to drain) before `redis` is. The order comes from the `depends_on` each service had when it started. The proxy and services nothing depends on go first. Ctrl+C on a foreground `up`, and `restart` when it stops several services, use the same order. If a service cannot be stopped, what it depends on is left running with it, and `down` names both and exits non-zero.
- With service names, stops only those. Services that depend on them are left running; `down` names the ones still running (`warning: still running and depending on what was stopped: api (on db)`) so you can stop them too or bring the dependency back. It goes by the dependencies each running service recorded when it started, so editing `portler.yml` does not change who is warned. The suggested command repeats how the stopped services were started (mode, `--prod`, `--no-setup`, `--image`, `--volume-set`, and your `--file`). It is `portler up`, or `portler restart` while something the stopped services depend on is still running (`up` would refuse to start that again; `restart` leaves it alone). When no single command can bring them back (they were started differently, an entry from an older Portler does not say which volume set it was on, a running prerequisite was started another way, a stopped service's entry had to be kept because it is not fully stopped yet, or they ran in Kubernetes, whose entries do not record an `--image` pin), the warning says so instead of guessing. A service whose running container `down` removed counts even when its entry has to be kept, and `down k8s` counts a service it deleted from the cluster even when it had no port-forward.
- Releases reservations only for services whose teardown completed. A service whose PID entry or Docker resource is kept after a failure keeps its reservation too, so another Portler run cannot claim its port while it may still bind or listen.
- `portler down k8s` additionally deletes the generated Kubernetes Deployments and Services (for the whole project, or just the selected services) and stops the port-forwards.
- With a [proxy](/guide/proxy) configured, `portler down` stops it too; `portler down proxy` stops **just** the proxy.
- Captured log files in `.portler/logs/` are kept after `down` for post-mortem inspection.
- Exits non-zero when it did **not** finish the job — a service it refused to signal is still running, or a Docker resource could not be removed. It never reports success for work it did not do.

## Options

| Flag | Description |
| ---- | ----------- |
| `--volumes` | **`down k8s` only.** Also delete the namespace and its PersistentVolumeClaims — this destroys stored data. |
| `--force` | **Dangerous last resort.** Signal the process group of a pid whose identity Portler cannot verify (see [PID safety](#pid-safety)). If the OS recycled that pid, this kills an unrelated process tree. Never signals a pid proven to belong to another process. |

## Safety

Portler only stops and deletes what it created.

### PID safety

A pid does not identify a process. Between `up` recording a pid and `down` signalling it, the process can exit and the OS can hand that number to something unrelated — and because Portler signals the whole **process group** (`kill(-pid)`, needed because a service leader is usually a shell wrapper whose grandchild is the real server), signalling the wrong pid takes out a stranger's entire process tree.

So Portler records a **start token** — the kernel's own start time for that pid — when it spawns a service, and re-reads it immediately before `SIGTERM` and again before `SIGKILL`. The rule is fail-closed:

| Situation | What `down` does |
| --------- | ---------------- |
| The token still matches | Signals the process group. |
| The token differs (the pid was recycled) | **Never** signals it, with or without `--force`. Warns and clears the stale entry. |
| No token recorded — a PID file written before Portler 0.2.0, or a token that could not be captured at spawn | **Not signalled.** Portler warns, keeps the entry so the service stays visible, and exits non-zero. Stop it yourself (see [Upgrading](#upgrading-from-portler-0-1-x)). |
| The pid is gone but its process group still has members | Signals the group — but only when Portler proved that pid was its own earlier in the same `down`. The kernel keeps a pgid reserved while the group has members, so that number cannot have been recycled underneath us. |

The identity check runs **twice**: immediately before `SIGTERM`, and again before `SIGKILL`. The pid can be released and recycled inside the grace window between them — precisely when Portler is about to signal it — so a service that matched at `SIGTERM` but is no longer provably ours at `SIGKILL` is left alone, is **not** reported as stopped, and keeps its PID entry.

### "Stopped" means gone

`down` reports a service as `stopped` only when its **process group is confirmed gone**. Sending a signal is not a teardown: the kill can be refused by the kernel (`EPERM`), the second identity check can refuse to send it, or the group can simply survive. Each of those keeps the service out of `stopped`, keeps its PID entry (so it stays visible to `portler ps`), prints what happened, and makes `down` exit non-zero.

### Zombies under a PID 1 that does not reap

A process that has exited but whose parent never collected it (a zombie) still answers `kill(pid, 0)`, and so does a process group that holds nothing else. That is what happens when Portler runs inside a container whose PID 1 does not reap orphans, such as `tail -f /dev/null` or a plain shell: every service `down` stops becomes a zombie and stays one.

On **Linux**, `down` therefore reads the group's members from `/proc` once the signal check says the group is there, and counts the group as gone only when two scans in a row find the same processes and threads, with nothing exiting while a scan reads them, and every one of them is a zombie, all its threads included (a process whose main thread has exited reads as a zombie while its other threads still run). If other processes on a busy host keep exiting while the scans read them, so that no two qualify, `down` waits out the grace period and sends SIGKILL as usual; after its own SIGKILL no member can start another process, so a single scan that finds only zombies is enough. Such a service is reported as stopped, and its PID entry and reservation are released. Anything unclear keeps the answer "still running": a member or thread that is not a zombie, one whose state cannot be read, or a `/proc` mounted with `hidepid`, which hides other users' processes. On macOS launchd always collects zombies, so this never comes up there.

The zombies themselves stay until PID 1 collects them. Run such containers with `docker run --init`, or with tini as PID 1, so it does.

### `--force` is a last resort

`--force` signals a pid Portler **cannot identify** — and it signals its whole process group. If the OS recycled that pid onto something else, `--force` kills a stranger's process tree. It is not a routine flag and it is not the way to migrate.

Prefer stopping the process yourself:

```bash
ps -o pid,ppid,lstart,command -p <pid>   # is this really your service?
kill -TERM -<pid>                        # signal its process group, once you are sure
```

Only reach for `portler down --force` when you have inspected the pid, are confident it is yours, and accept that Portler cannot verify it.

### Upgrading from Portler 0.1.x

PID entries written by Portler 0.1.x have no start token, so Portler 0.2.0 cannot prove they are still its processes and will **not** signal them.

**The clean path — do this before you upgrade:**

```bash
portler down     # with the 0.1.x Portler still installed
ps -eo pid,pgid,lstart,command | grep -i portler   # confirm nothing is left behind
```

Then upgrade. Every service started by 0.2.0 records a start token, so this never comes up again.

**If you have already upgraded** and `down` reports services it will not signal, stop them by hand:

1. Read `.portler/pids.json` — it lists each service's recorded `pid` and `command`.
2. Check each pid: `ps -o pid,ppid,lstart,command -p <pid>`. If it is not your service (the command is something else entirely), the pid was recycled — do **not** signal it.
3. Stop the ones that are yours: `kill -TERM -<pid>` (the leading `-` signals the process group, which is what Portler would have done).
4. Re-run `portler down` to clean up the ports and the remaining bookkeeping; `portler clean --force` clears a `.portler/` directory whose entries are all dealt with.

On **Linux** the token is the process start time in clock ticks from `/proc/<pid>/stat` — distinct for any process that started at a different tick. On **macOS** there is no `/proc`, so it comes from `ps -o lstart=,pgid=`: the start time only to the **second**, plus the process-group id. That is weaker: a process that took the recycled pid within the same second *and* leads its own process group would still pass. Pid reuse requires the pid counter to wrap first, so the residual risk is small — but it is not zero, and Portler does not claim otherwise.

### Docker and Kubernetes

- A Docker container or network is only removed when it carries this project's `portler.project` label — and it is then removed by its immutable **ID**, captured in the same inspect that read the label, never by the name (which can be re-pointed at a different container in between). One that merely holds a colliding name is left alone, with a warning.
- A container or network Portler could **not** remove (Docker unreachable, permission denied) leaves its PID entry in place rather than erasing the only record of what is left behind, and `down` exits non-zero. Re-run it once Docker is reachable.
- A Docker service whose `docker run` shell has exited while its container ran on (`portler ps` shows it as `running (container)`) is stopped by removing that container. The `docker run` client left in its process group exits once the container is gone; `down` waits up to the 2 s confirm window for that group to go and then reports the service as stopped. Nothing is signalled while it waits, and a group that is still there afterwards is handled as described in [PID safety](#pid-safety): left alone, with its PID entry kept.
- A Kubernetes namespace is only deleted when Portler created and labelled it. `down k8s` against a namespace Portler does not own fails instead, and so does a `down k8s` that cannot read the namespace's labels at all. See [Kubernetes mode](/guide/kubernetes#namespace-ownership).

::: warning `down k8s` keeps your data
By default `down k8s` leaves PersistentVolumeClaims (and the namespace) in place, so a database's data survives a down/up cycle. Deleting it must be explicit:

```bash
portler down k8s --volumes    # destroys stored data
```

With `--volumes`, Portler waits (up to 60s) for the namespace to finish terminating.
:::

## Examples

```bash
portler down                 # stop everything (including the proxy)
portler down backend         # stop one service
portler down proxy           # stop only the reverse proxy
portler down k8s             # remove workloads + port-forwards, keep volumes
portler down k8s --volumes   # also delete the namespace and its PVCs
```
