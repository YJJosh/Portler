# Databases & presets

Portler has no code for any particular database. A database is a Docker service like any other, and four generic features take the repetition out of it:

- **Presets** (`use: postgres`) hold the image, port, volume, readiness check and env.
- **Exports** (`${db.database_url}`) let the database publish its connection URL once.
- **`address`** resolves to the right host and port in local, Docker and Kubernetes mode.
- **Tasks** (`portler run psql`) run one-off commands with the right env.

```yaml
services:
  db:
    use: postgres
  cache:
    use: redis
  api:
    command: pnpm dev
    port: 4000
    port_env: PORT
    depends_on: [db, cache]
    setup:
      - run: pnpm db:migrate
        watch: [migrations]
    env:
      DATABASE_URL: ${db.database_url}
      REDIS_URL: ${cache.redis_url}

tasks:
  psql: docker exec -it ${db.container} psql -U postgres app
```

## Presets

`use: <name>` starts a service from a built-in preset; `use: ./path.yml` from a file of your own.

| Built-in | Image | Port | Exports | Env defaults |
| --- | --- | --- | --- | --- |
| `postgres` | `postgres:18-alpine` | 5432 | `database_url` | `POSTGRES_USER=postgres`, `POSTGRES_PASSWORD=postgres`, `POSTGRES_DB=app` |
| `mysql` | `mysql:8.4` | 3306 | `database_url` | `MYSQL_USER=app`, `MYSQL_PASSWORD=app`, `MYSQL_DATABASE=app`, `MYSQL_ROOT_PASSWORD=mysql` |
| `redis` | `redis:7-alpine` | 6379 | `redis_url` | — |

Each one keeps its data in a [managed volume](/guide/volumes) named `@<service>-data` and waits for the server to accept connections before dependents start.

Anything the service sets itself wins. `env` and `exports` merge key by key, so you only write what differs:

```yaml
db:
  use: postgres
  env:
    POSTGRES_DB: shop                # the other POSTGRES_* defaults stay
    POSTGRES_PASSWORD: { default: dev, secret: true }
  k8s:
    volume: 1Gi
```

The env defaults are `default:` entries, so a `POSTGRES_PASSWORD` in your shell or `.env` replaces them without touching `portler.yml`. The export puts the user and password into the URL as they are, so a password with `@`, `/`, `:` or `#` breaks `database_url`: pick one without them, or override the export.

::: warning Versions
A preset pins a major version, because a data volume only opens with the major that wrote it. To stay on Postgres 16, set the image and the older data path together:

```yaml
db:
  use: postgres
  image: postgres:16-alpine
  volumes: ['@db-data:/var/lib/postgresql/data']
```
:::

### A database Portler doesn't ship

A preset file is a service definition with placeholders. This one adds ClickHouse without any change to Portler:

```yaml
# portler/presets/clickhouse.yml
image: clickhouse/clickhouse-server:25.3
port: 8123
volumes:
  - '@${self.name}-data:/var/lib/clickhouse'
env:
  CLICKHOUSE_USER: { default: app }
  CLICKHOUSE_PASSWORD: { default: app, secret: true }
healthcheck:
  url: http://localhost:${self.port}/ping
exports:
  http_url: http://${env.CLICKHOUSE_USER}:${env.CLICKHOUSE_PASSWORD}@${self.address}
```

```yaml
services:
  analytics:
    use: ./portler/presets/clickhouse.yml
```

`${self.name}` becomes the service's name when the file loads, so two services using one preset get separate volumes. Paths are relative to the project root. See [use](/reference/configuration#use-presets) for the exact rules.

## One URL for every mode

A service on your machine reaches Postgres at `localhost:51234`, a container at `db:5432`. Before `address`, that meant one `DATABASE_URL` in `env:` and copies in `docker.env` and `k8s.env`. The preset's export is built from `${self.address}`, so `${db.database_url}` is right for whoever reads it:

| Reader | `${db.database_url}` |
| --- | --- |
| `api` as a local process | `postgres://postgres:postgres@localhost:51234/app` |
| `api` in a container (`up docker`) | `postgres://postgres:postgres@db:5432/app` |
| `api` in Kubernetes (`up k8s`) | `postgres://postgres:postgres@db:5432/app` |
| A setup step, healthcheck command or `portler run` | `postgres://postgres:postgres@localhost:51234/app` |

The password comes from the database's own env, so it is written once. `portler env api` hides the whole URL because it contains a `secret: true` value; `--reveal` shows it.

A password with `@`, `:` or `/` in it would need URL encoding, which exports don't do. Use a plain password for development.

## Migrations

The database's migration table is what knows which migrations ran. Portler only has to run your migrate command at the right moment, and the command must be safe to run again. Two good places:

**In the start command.** Simple, and runs on every start:

```yaml
api:
  command: pnpm db:migrate && pnpm dev
```

**As a setup step that watches the folder.** It runs after `db` is ready, before `api` starts, and only again when a migration file is added, changed or removed:

```yaml
api:
  depends_on: [db]
  setup:
    - run: pnpm db:migrate
      watch: [migrations]
```

Setup steps run on your machine even when `api` runs in a container, and they see `${db.address}` as `localhost:<port>`. A step's receipt belongs to the [volume set](/guide/volumes#volume-sets), so `portler up --volume-set fresh` against an empty database runs the migrations there too, and so does the next `up` after `portler volumes remove db-data`.

A seed step can use `if_missing:` with a marker file, or live in a task you run by hand.

## Tasks

`tasks:` names commands that `portler run` starts on your machine with the right env:

```yaml
tasks:
  psql: docker exec -it ${db.container} psql -U postgres app
  seed:
    run: pnpm db:seed
    service: api                    # api's env and cwd
    description: Fill the database with sample data
```

```bash
portler run                         # list the tasks
portler run seed
portler run seed -- --reset         # extra words are appended
portler run api -- pnpm prisma studio   # any command with api's env
```

`portler run` uses the run mode the service was last started in, so after `portler up docker` a task still sees `localhost:<port>`, the address from your machine. See [`portler run`](/reference/cli/run).

## Copying a database

`portler volumes fork db-data experiment` copies the database's volume so a branch can try a destructive migration. Copying files under a running database can give a broken copy, so the fork refuses while a running container uses the volume: stop the database first (`portler down db`), or pass `--force` if you accept the risk. See [Volumes](/guide/volumes#forking-a-volume).
