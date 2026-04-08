# Solo Leveling System Notifications on Cloudflare

This worker replaces the old Render backend with:

- Cloudflare Worker for the API
- D1 for durable device storage
- Cron Triggers for automatic scheduling

It keeps the same frontend contract your app already uses:

- `POST /api/notifications/subscribe`
- `POST /api/notifications/state`
- `POST /api/notifications/test`
- `POST /api/notifications/dispatch`
- `GET /health`

## Why this version is safer

Render free web services were losing the local `devices` store because the filesystem is ephemeral. D1 is durable storage, so subscriptions survive restarts and deploys.

## Project layout

- `src/index.js` - Worker routes and push logic
- `migrations/0001_initial.sql` - D1 schema
- `wrangler.jsonc` - Worker config, cron, vars, D1 binding

## Step-by-step setup

### 1. Create a new repo from this folder

Put the contents of this folder into a new GitHub repo, for example:

- `sl-system-cloudflare-notifications`

### 2. Install dependencies locally

```powershell
cd cloudflare-notification-backend
npm install
```

### 3. Log in to Cloudflare

```powershell
npx wrangler login
```

### 4. Create the D1 database

```powershell
npx wrangler d1 create sl-system-notifications
```

Cloudflare will print a `database_id`. Paste that into:

- `wrangler.jsonc`

Replace both:

- `database_id`
- `preview_database_id`

### 5. Apply the database schema

```powershell
npx wrangler d1 migrations apply sl-system-notifications --remote
```

### 6. Fill the public config in `wrangler.jsonc`

Edit:

- `ALLOWED_ORIGIN`
- `VAPID_PUBLIC_KEY`
- `VAPID_SUBJECT`

`ALLOWED_ORIGIN` should be only your GitHub Pages origin, for example:

```text
https://yourname.github.io
```

### 7. Add the private secrets

These go into Cloudflare as secrets:

```powershell
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put CRON_SECRET
```

Both commands prompt you to paste the value.

### 8. Deploy the Worker

```powershell
npx wrangler deploy
```

Wrangler will print your Worker URL, for example:

```text
https://sl-system-notifications.your-subdomain.workers.dev
```

### 9. Test health

Open:

```text
https://YOUR-WORKER-URL/health
```

You should see JSON with:

- `ok: true`
- `storage: "cloudflare-d1"`

### 10. Update the frontend PWA config

In your GitHub Pages frontend, update `push-config.js` to:

```js
window.SYSTEM_PUSH_CONFIG = {
  publicKey: 'YOUR_VAPID_PUBLIC_KEY',
  subscribeUrl: 'https://YOUR-WORKER-URL/api/notifications/subscribe',
  stateSyncUrl: 'https://YOUR-WORKER-URL/api/notifications/state',
  testUrl: 'https://YOUR-WORKER-URL/api/notifications/test'
};
```

Then push that frontend update to GitHub Pages.

### 11. Re-register the phone once

On Android:

1. Open the PWA
2. Go to Profile
3. Tap `ENABLE`
4. Tap `TEST PUSH`

Then check:

```text
https://YOUR-WORKER-URL/health
```

`devices` should stay at `1` even after time passes and after deploys.

## Automatic scheduling

This Worker includes a native Cloudflare Cron Trigger:

- `7,22,37,52 * * * *`

That means Cloudflare calls the Worker automatically four times an hour. No GitHub Actions or Render Cron is needed.

## Force-test a notification

Use your cron secret in the URL:

```text
https://YOUR-WORKER-URL/api/notifications/dispatch?secret=YOUR_CRON_SECRET&force=daily_briefing
```

Available `force` values:

- `daily_briefing`
- `reward_ready`
- `decay_warning`
- `boss_ready`
- `remaining_quests`

## Useful local test

Run local dev with scheduled testing:

```powershell
npm run dev
```

Then hit:

```text
http://localhost:8787/__scheduled?cron=7+*+*+*+*
```

Cloudflare documents the scheduled test route for `wrangler dev --test-scheduled`.
