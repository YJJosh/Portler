---
layout: home

hero:
  name: Portler
  text: Ports that sort themselves out.
  tagline: A local development process runner like a small docker compose, but with automatic port assignment and environment resolution.
  image:
    src: /logo.svg
    alt: Portler
  actions:
    - theme: brand
      text: Getting started
      link: /guide/getting-started
    - theme: alt
      text: What is Portler?
      link: /guide/what-is-portler
    - theme: alt
      text: GitHub
      link: https://github.com/YJJosh/Portler

features:
  - icon: 🔌
    title: Automatic port assignment
    details: Portler finds free localhost ports for every service, so two projects (or two worktrees) never fight over port 3000 again.
  - icon: 🔗
    title: Service references
    details: Write backend.url or ${postgres.port} in your env values and Portler resolves them to the assigned addresses at startup.
  - icon: 🐳
    title: Local, Docker, or Kubernetes
    details: The same portler.yml runs services as local processes, in Docker containers, or in a local Kubernetes cluster.
  - icon: 🌐
    title: One project URL
    details: An optional built-in reverse proxy serves your whole stack behind a single origin — no CORS pain, HMR included.
  - icon: 💾
    title: Managed volumes
    details: Project-scoped Docker volumes with one-command forks, made for testing migrations in git worktrees without touching real data.
  - icon: 🚦
    title: Dependency-ordered startup
    details: depends_on plus tcp/http/command healthchecks start services in order and wait until they are actually ready.
---

## Quick taste

::: code-group

```yaml [portler.yml]
services:
  postgres:
    image: postgres:16-alpine
    port: 5432
    env:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app

  backend:
    command: npm run dev
    cwd: backend
    port: 4000
    port_env: PORT
    depends_on:
      - postgres
    env:
      DATABASE_URL: postgres://app:app@localhost:${postgres.port}/app

  frontend:
    command: npm run dev
    cwd: frontend
    port: 3000
    port_env: PORT
    env:
      VITE_API_URL: backend.url
```

```bash [terminal]
$ npm install -g portler
$ portler up

SERVICE    PORT    URL
postgres   51234   http://localhost:51234
backend    51235   http://localhost:51235
frontend   51236   http://localhost:51236
```

:::

Every service gets a free port, `backend.url` resolves to the backend's real address, and dependents wait for their dependencies to be ready.
