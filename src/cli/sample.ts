/**
 * Canonical starter `portler.yml`, shared by `portler init` and the help text
 * so they never drift apart.
 */
export const SAMPLE_PORTLER_YML = `use_env: .env

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
      command: docker exec $PORTLER_POSTGRES_CONTAINER pg_isready -U app -d app

  backend:
    command: npm run dev
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
