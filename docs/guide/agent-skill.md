# Agent skill

Coding agents can learn Portler from a skill: one `SKILL.md` file that tells the agent when to use Portler, which commands it needs, how to work in a checkout without disturbing other services, and where to read the documentation for the version that is installed.

## Install

The latest skill, from `main`:

```bash
npx skills add YJJosh/Portler
```

The skill for the Portler version you have installed:

```bash
npx skills add "https://github.com/YJJosh/Portler/tree/v$(portler --version)/skills/portler"
```

The [`skills`](https://github.com/vercel-labs/skills) installer works with Claude Code, Codex, Cursor, OpenCode and most other coding agents. It asks which of your agents should get the skill and whether to install it into the current project or for your user. `npx skills update` keeps the latest one current; run the second command again after upgrading Portler. Releases from before the skill was added don't include it.

To install it by hand, copy [`skills/portler/SKILL.md`](https://github.com/YJJosh/Portler/blob/main/skills/portler/SKILL.md) into a `portler` folder in your agent's skills directory. For an agent without skills, add the file's contents to its instructions.

## Docs that match the installed version

This site shows the latest release. The skill therefore has the agent run `portler --version` and read the Markdown source of these pages at that release's tag:

```text
https://raw.githubusercontent.com/YJJosh/Portler/v<version>/docs/<page>.md
```

The tag is the commit the release was built from, so an agent working with an older Portler does not follow instructions for features it does not have yet.

## What the skill contains

- the command overview and the `portler.yml` keys, including setup steps
- how to work in a checkout: start detached, read ports instead of hardcoding them, use `restart` for running services, find failures with `ps` and `logs`, and stop only what it started
- isolated database volume sets for each task, forked from a baseline
- where to find the docs for the installed version

::: details Show SKILL.md

<<< @/../skills/portler/SKILL.md{md}

:::
