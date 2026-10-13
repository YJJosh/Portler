import { PACKAGE_NAME, VERSION } from '../constants.ts';

export function printHelp(): void {
  process.stdout.write(`${PACKAGE_NAME} ${VERSION}

Usage:
  ${PACKAGE_NAME} setup [docker] [service...] [--prod]
  ${PACKAGE_NAME} start [service] [--prod] [--drain-ms <ms>]
  ${PACKAGE_NAME} up [service...] [--detach] [--volume-set <name>] [--prod] [--setup|--no-setup] [--image <service>=<image>]
  ${PACKAGE_NAME} up docker [service...] [--detach] [--volume-set <name>] [--prod] [--setup|--no-setup] [--image <service>=<image>]
  ${PACKAGE_NAME} up k8s [service...] [--detach] [--image <service>=<image>]
  ${PACKAGE_NAME} down [docker|k8s] [service...] [--volumes] [--force]
  ${PACKAGE_NAME} k8s render [service...]
  ${PACKAGE_NAME} restart [docker] [service...] [--prod] [--setup|--no-setup] [--image <service>=<image>] [--volume-set <name>]
  ${PACKAGE_NAME} ps [service...]
  ${PACKAGE_NAME} logs [service...] [-f|--follow]
  ${PACKAGE_NAME} ports
  ${PACKAGE_NAME} env [service] [--prod] [--reveal]
  ${PACKAGE_NAME} clean [--ports] [--global] [--force]
  ${PACKAGE_NAME} volumes [list] [--prod]
  ${PACKAGE_NAME} volumes fork <volume> <new-set> [--prod]
  ${PACKAGE_NAME} volumes remove <volume> [--force] [--prod]
  ${PACKAGE_NAME} init

Options:
  -f, --file <path>       Use a specific portler.yml file (for "logs", -f means
                          --follow; use --file there)
  -d, --detach            Start services in the background for "up"
      --prod              Use production overrides for setup, start, up, restart, env and volumes
      --reveal            For "env --prod": print secret-looking values instead of ***
      --drain-ms <ms>     For "start": after the shell exits, wait up to <ms> for the rest
                          of its process group before returning (default 10000)
      --setup             For "up" and "restart": run setup steps again, ignoring their receipts
                          (local/Docker; an if_missing step still skips while its
                          path exists)
      --no-setup          For "up" and "restart": skip setup entirely (local/Docker)
      --ports             For "clean": only release this project's ports
      --global            For "clean": prune stale entries from the global registry
                          (with --force, reset it if it is corrupt/unreadable)
      --force             For "clean": stop running services first (also recovers
                          from a corrupt .portler/); for "volumes remove": bypass
                          only the in-use check (ownership is always required);
                          for "down": DANGEROUS last resort — signal pids
                          whose identity cannot be verified
  -f, --follow            Keep streaming new output for "logs"
      --volumes           For "down k8s": ALSO delete PersistentVolumeClaims.
                          Without it, stored data survives a down/up cycle.
      --volume-set <name> Use the <volume>--<name> variant of managed "@" volumes
                          (env fallback: PORTLER_VOLUME_SET)
      --image <service>=<image>
                          For "up"/"restart": run that Docker service from this
                          image instead of building it (repeatable; e.g. the
                          digest reference CI pushed)
  -h, --help              Show help

Foreground "up" (local/Docker): Ctrl-C or SIGTERM during startup cancels setup
and readiness, stops only this run's services and releases their ports (exit 130/143).

"down" only signals a process group whose leader's recorded start token still
matches, so a recycled pid is never killed. "--force" also signals groups whose
identity cannot be proven (legacy entries, unreadable tokens) — never one that
provably belongs to someone else. Inspect the pid first with
"ps -o pid,ppid,lstart,command -p <pid>".

With a "proxy:" block in portler.yml, "ps proxy" and "down proxy" select just
the reverse proxy.

Run "${PACKAGE_NAME} init" to write a starter portler.yml.

Documentation: https://yjjosh.github.io/Portler
`);
}
