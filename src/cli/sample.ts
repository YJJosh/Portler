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
    # Built-in preset: image, port 5432, the @postgres-data volume, a healthcheck
    # and exports.database_url. Keys you add here override it.
    use: postgres

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
      DATABASE_URL: \${postgres.database_url}
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
