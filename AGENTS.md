# AGENTS.md

Notes for coding agents working on the Portler source. For how to *use*
Portler in another project, see [`skills/portler/SKILL.md`](skills/portler/SKILL.md);
user documentation lives in [`docs/`](docs/).

## Setup and checks

- Node 22.6 or newer and npm (`package-lock.json` is committed). There are no
  runtime dependencies; YAML and `.env` parsing live in `src/parse/`.
- The source is TypeScript that Node runs directly with type stripping.
  Imports use `.ts` extensions, which `tsc` rewrites on build. Only erasable
  syntax works: no `enum`, `namespace` or constructor parameter properties.
- Before opening a PR, run what CI runs:

  ```sh
  npm run verify       # typecheck (including tests), tests, build, smoke
  npm pack --dry-run   # the files the npm package would contain
  npm run docs:build   # the docs site; dead links fail the build
  ```

- One test file: `node --experimental-strip-types --test test/stop.test.ts`.
- `npm run dev -- <args>` runs the CLI from source (Node 23.6+; on Node 22 use
  `node --experimental-strip-types bin/portler.ts`). `npm run dev:link`
  installs the build as `devportler`, leaving an installed `portler` alone.

## Tests

- CI runs on Ubuntu and macOS with Node 22 and 24. Windows is not supported.
- No test needs real Docker or Kubernetes; they use fake `docker` and
  `kubectl` shell scripts.
- Tests that touch the port registry set `PORTLER_GLOBAL_DIR` to a temp
  directory. New tests must do the same, so they never touch `~/.portler`.
- Three zombie-process tests in `pids.test.ts` and `stop.test.ts` only run on
  Linux. On macOS, run them in a container (`--init` reaps orphans, which a
  plain PID 1 does not):

  ```sh
  docker run --rm --init -v "$PWD":/work:ro -w /work node:22 \
    node --experimental-strip-types --test test/pids.test.ts test/stop.test.ts
  ```

- Test files run in parallel and some bind real ports. A rare `EADDRINUSE` or
  readiness timeout is usually two files colliding on a port: rerun that file
  on its own before debugging.

## Layout

- `bin/portler.ts`: entry point. `src/index.ts`: the public library API.
- `src/cli/`: argument parsing (`args.ts`), help text (`help.ts`), the
  `portler init` sample (`sample.ts`) and one file per command in `commands/`.
- `src/config/`: loading and validating `portler.yml`.
- `src/process/`: spawning, liveness, stopping, Docker ownership.
- `src/ports/`: allocation and the global registry. `src/state/`: `.portler/`
  files and locks.
- `src/env/`, `src/setup/`, `src/readiness/`, `src/proxy/`, `src/k8s/`,
  `src/volumes/`: the features their names say.

## Rules that must hold

These describe how the code protects users' processes and data today. The
paths named below are deliberate, but the list is not complete: if you find a
signal or removal it does not cover, assume it is deliberate, read its tests
and history, and raise it in the PR instead of removing it. Call out any new
path in the PR description.

- Signal a process group only with proof that it is ours. Proof is one of:
  - Portler spawned it in this same process and still holds the child:
    signal forwarding and the drain deadline in `runShell`
    (`src/process/shell.ts`), readiness-command timeouts
    (`src/readiness/index.ts`), the port-forward child in
    `src/k8s/forward-supervisor.ts`.
  - For a recorded service, the leader's start token matches now (`maySignal`
    in `src/process/identity.ts`), or matched earlier in the same stop while
    the group stayed alive, so `down` can still stop children after the leader
    exits (`provenOurs` in `signalDecision`, `src/process/stop.ts`).

  When in doubt, treat it as not ours and still running. Only `down --force`
  and `clean --force` (both through the `force` option of `stopServices`)
  signal an unverifiable process, and never one whose pid was provably reused.
- Docker: only touch existing containers, networks and volumes labelled as
  this project's (`src/process/ownership.ts`), and re-check ownership right
  before a destructive call. Removing something owned can remove unlabelled
  things with it, on purpose: a container's own anonymous volumes
  (`docker rm -f -v`, so an image `VOLUME` does not leak;
  `test/ownership.test.ts`) and the short-lived `--rm` copy container that
  `volumes fork` starts (`forkVolume` in `src/volumes/manager.ts`).
- Kubernetes: ownership is decided per namespace (`namespaceOwnership` in
  `src/k8s/kubectl.ts`). `ensureNamespace` creates it with `kubectl create`,
  never `apply`, and refuses a namespace that is not this project's. Inside an
  owned namespace, `up k8s` applies its manifests and takes over same-named
  objects. Deletes select by the project's labels (`deleteSelector`), except a
  full `down k8s --volumes`, which deletes the whole namespace and everything
  in it (`deleteK8sResources`).
- `down` never deletes named volumes. Only `portler volumes remove` deletes
  existing ones, and only those this project owns. The one other deletion is
  `volumes fork` rolling back the target it just created when the copy fails,
  again only while it is still ours.
- Change `.portler/` state and the registry only under the existing locks
  (`src/state/lock.ts`, `src/ports/lock.ts`).

## Keep docs in sync

A change to a command, flag or config key also updates:

- `src/cli/help.ts` and `docs/reference/cli/<command>.md`;
- for a new or renamed command, also the table in `docs/reference/cli/index.md`
  and the sidebar list in `docs/.vitepress/config.mts` (the docs build does not
  catch these);
- `docs/reference/configuration.md` for config keys;
- `skills/portler/SKILL.md` if it changes how an agent should use Portler.

The `portler.yml` format may still change in breaking ways before 1.0. Call
out any breaking change in the PR description so it reaches the release notes.

## Releases

- The docs site deploys automatically when a release is published, and a
  maintainer can also run **deploy docs** by hand. The skill installs from
  `main`.
- A maintainer runs the GitHub Actions in order: **1. Prepare version PR**
  opens the version bump, then after it is merged **prepare release** tags
  `main` and drafts the notes, and publishing that draft runs **npm publish**
  and **deploy docs**. Feature PRs don't change the version in `package.json`.
