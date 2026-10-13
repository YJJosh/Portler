/**
 * Canonical starter `portler.yml` that `portler init` writes.
 * docs/guide/getting-started.md shows it without the comment lines.
 */
export const SAMPLE_PORTLER_YML = `# Optional setup runs on up. A plain step runs once per checkout (again when it
# changes, or with up --setup); if_missing runs only while that path is absent;
# always runs every time.
# setup:
#   - {run: npm install, if_missing: node_modules}
# prod:
#   setup: [npm ci, {run: npm run build, always: true}]
#   env: {NODE_ENV: production}
use_env: .env

services:
  postgres:
    image: postgres:16-alpine
    port: 5432
    env:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    volumes:
      - '@postgres-data:/var/lib/postgresql/data'
    healthcheck:
      command: docker exec $PORTLER_POSTGRES_CONTAINER pg_isready -h 127.0.0.1 -U app -d app

  backend:
    command: npm run dev
    # setup: npm run generate
    # prod:
    #   command: npm start
    cwd: backend
    port: 4000
    port_env: PORT
    depends_on:
      - postgres
    env:
      DATABASE_URL: postgres://app:app@localhost:\${postgres.port}/app
      CORS_ALLOWED_ORIGIN: frontend.url

  frontend:
    command: npm run dev
    cwd: frontend
    port: 3000
    port_env: PORT
    depends_on:
      - backend
    env:
      VITE_API_URL: backend.url
`;
