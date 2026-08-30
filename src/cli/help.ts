import { PACKAGE_NAME, VERSION } from '../constants.ts';

export function printHelp(): void {
  process.stdout.write(`${PACKAGE_NAME} ${VERSION}

Usage:
  ${PACKAGE_NAME} up [service...] [--detach] [--volume-set <name>]
  ${PACKAGE_NAME} up docker [service...] [--detach] [--volume-set <name>]
  ${PACKAGE_NAME} up k8s [service...] [--detach]
  ${PACKAGE_NAME} down [docker|k8s] [service...] [--volumes] [--force]
  ${PACKAGE_NAME} k8s render [service...]
  ${PACKAGE_NAME} restart [docker] [service...]
  ${PACKAGE_NAME} ps [service...]
  ${PACKAGE_NAME} logs [service...] [-f|--follow]
  ${PACKAGE_NAME} ports
  ${PACKAGE_NAME} env [service]
  ${PACKAGE_NAME} clean [--ports] [--global] [--force]
  ${PACKAGE_NAME} volumes [list]
  ${PACKAGE_NAME} volumes fork <volume> <new-set>
  ${PACKAGE_NAME} volumes remove <volume> [--force]
  ${PACKAGE_NAME} init

Options:
  -f, --file <path>       Use a specific portler.yml file (for "logs", -f means
                          --follow; use --file there)
  -d, --detach            Start services in the background for "up"
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
  -h, --help              Show help

"down" only signals a process group whose leader's recorded start token still
matches, so a recycled pid is never killed. "--force" also signals groups whose
identity cannot be proven (legacy entries, unreadable tokens) — never one that
provably belongs to someone else. Inspect the pid first with
"ps -o pid,ppid,lstart,command -p <pid>".

Run "${PACKAGE_NAME} init" to write a starter portler.yml.

Documentation: https://yjjosh.github.io/Portler
`);
}
