# Manna (d2rm-dashboard-saas) — staging/production image.
# Node 22 is REQUIRED: the app uses node:sqlite (built into Node 22+, zero native deps).
FROM node:22-slim

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# Staging defaults: boots WITHOUT real SES (stub mailer) and without
# APP_BASE_URL. Set NODE_ENV=production + APP_BASE_URL + SES vars for real sends.
ENV NODE_ENV=staging \
    PORT=3000 \
    DATABASE_PATH=/app/data/d2rm-dashboard.db

# Idempotent migrations, then the server. Seed runs separately (see README note
# below) so restarts never wipe/re-seed demo data unexpectedly.
CMD ["sh", "-c", "node scripts/migrate.js && node src/server.js"]

EXPOSE 3000

# Seed once after first deploy (creates demo tenant "Acme Ministries"):
#   docker exec ... sh -c "SEED_OWNER_EMAIL=you@example.com SEED_OWNER_PASSWORD='<12+ chars>' node scripts/seed.js"
# Or set SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD env vars on the host and run the
# seed command as a one-off task. The script skips tenants that already exist.
