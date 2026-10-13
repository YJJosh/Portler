# Agent skill

Coding agents can learn Portler from a skill: one `SKILL.md` file that tells the agent when to use Portler, which commands it needs, how to work in a checkout without disturbing other services, and where to read the documentation for the version that is installed.

## Install

Download <a href="/Portler/skills/portler/SKILL.md" download>SKILL.md</a> into a `portler` folder in your agent's skills directory. For Claude Code:

```bash
mkdir -p ~/.claude/skills/portler
curl -fsSL https://yjjosh.github.io/Portler/skills/portler/SKILL.md -o ~/.claude/skills/portler/SKILL.md
```

Put it in `.claude/skills/portler/` inside a repository instead to share it with everyone who works on that project. Other agents that support `SKILL.md` skills load it from their own skills directory; for an agent without skills, add the file's contents to its instructions.

The file on this site belongs to the latest release. Download it again after upgrading Portler.

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

<<< @/public/skills/portler/SKILL.md{md}

:::
