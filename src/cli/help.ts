import { VERSION } from '../constants.ts';
import { SAMPLE_PORTLER_YML } from './sample.ts';

export function printHelp(): void {
  process.stdout.write(`portler ${VERSION}

Usage:
  portler up [service...] [--detach] [--volume-set <name>]
  portler up docker [service...] [--detach] [--volume-set <name>]
  portler up k8s [service...] [--detach]
  portler down [docker|k8s] [service...] [--volumes] [--force]
  portler k8s render [service...]
  portler restart [docker] [service...]
  portler ps [service...]
  portler logs [service...] [-f|--follow]
  portler ports
  portler env [service]
  portler clean [--ports] [--global] [--force]
  portler volumes [list]
  portler volumes fork <volume> <new-set>
  portler volumes remove <volume> [--force]
  portler init

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
                          for "down": DANGEROUS
                          last resort — signal pids whose identity cannot be
                          verified (see below)
  -f, --follow            Keep streaming new output for "logs"
      --volumes           For "down k8s": ALSO delete PersistentVolumeClaims.
                          Without it, stored data survives a down/up cycle.
      --volume-set <name> Use the <volume>--<name> variant of managed "@" volumes
                          (env fallback: PORTLER_VOLUME_SET)
  -h, --help              Show help

"restart" stops the named services (all by default) and starts them again in
the background, keeping their assigned ports whenever they are still free.
It supports local and docker mode; for Kubernetes run "down k8s" then "up k8s".

Note: "docker" and "k8s" are reserved words selecting the Docker and
Kubernetes run modes and cannot be used as service names.

Stopping is fail-closed: "down" signals a recorded pid only when the OS start
time captured at spawn still matches, so a pid the OS recycled onto an unrelated
process is never killed (nor is its process group). A PID entry written before
start tokens existed, or one whose token could not be captured, is therefore NOT
signalled: it is reported, kept, and left for you. A service counts as stopped
only once its process group is confirmed gone; anything else makes "down" exit
non-zero. A pid PROVEN to belong to another process is never signalled, with or
without --force.

"down --force" is a dangerous last resort, not a routine flag: it signals the
process GROUP of a pid Portler cannot identify, so if the OS recycled that pid,
it kills an unrelated process tree. Inspect the pid first
("ps -o pid,ppid,lstart,command -p <pid>") and prefer stopping the process
yourself.

Kubernetes: Portler only acts on a local cluster (kind, k3d, minikube, Docker
Desktop, Rancher Desktop, OrbStack, colima); it refuses an unrecognized kubectl
context, and it refuses an API server endpoint that is not plainly on this
machine. Only loopback endpoints are accepted outright; a private/LAN address
(minikube's VM lives there — but so does the cluster down the hall) needs
PORTLER_ALLOW_K8S_ENDPOINT="<exact url>", and an endpoint that cannot be read at
all is refused with no override. It only ever creates/deletes namespaces it
labelled itself, and never deletes PersistentVolumeClaims unless
"down k8s --volumes" says so.

Proxy: a top-level proxy block serves the whole project behind one URL.
Routes use longest-prefix matching and prefixes are not stripped before
forwarding. "proxy" is then reserved as a service name. The proxy only answers
for localhost/loopback Host headers (DNS-rebinding protection); add others with
allowed_hosts.

  proxy:
    port: auto
    allowed_hosts: [myapp.test]
    routes:
      /api: backend
      /: frontend

Portler supports Linux and macOS (on Windows, use WSL2).

Example portler.yml:

${SAMPLE_PORTLER_YML}`);
}
