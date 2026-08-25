# autofract-post

A tiny content-approval queue for the Autofract studio account.

The assistant pushes ready-to-post **cards** into the queue via the ingest API. The
founder reviews them at **studio.autofract.com** (IP-gated), tweaks a line if needed,
and taps **Approve** — the card is scheduled to LinkedIn + Bluesky through the
**Postmypost** API. No auto-posting: nothing goes out without a human tap.

Zero npm dependencies (pure Node `http`), so the Coolify build never breaks on install.

## Env vars (set in Coolify)

| var | purpose |
|-----|---------|
| `POSTMYPOST_API_KEY` | Postmypost Bearer token |
| `PMP_PROJECT_ID` | Postmypost project id (default `357555` = autofract) |
| `PMP_LINKEDIN` | LinkedIn account id (default `2237330`) |
| `PMP_BLUESKY` | Bluesky account id (default `2237336`) |
| `ADMIN_TOKEN` | secret Bearer the assistant uses to push cards (`POST /api/cards`) |
| `ALLOWED_IPS` | comma-separated IPs allowed to open the dashboard (empty = allow all — set it) |
| `DATA_DIR` | persistent dir (default `/data`; mount a Coolify volume here) |

## Deploy (Coolify, autodeploy on git push)

1. New Resource → Application → this Git repo, build pack **Dockerfile**.
2. Domain: `studio.autofract.com`, port `3000`.
3. Persistent storage: volume → mount path `/data`.
4. Set the env vars above. Enable **Auto Deploy**.
5. Push to `main` → Coolify rebuilds and redeploys.

## How the assistant fills a card

```
POST /api/cards   Authorization: Bearer <ADMIN_TOKEN>
{
  "source": "relocating-data",
  "fact": "Qatar vs Turkey, $100k after tax",
  "linkedin": "…long post…",
  "bluesky": "…≤300 chars…",
  "image_base64": "<png base64, optional>",
  "image_ext": ".png",
  "post_at": "2026-08-26T10:00:00+00:00"   // optional; default = now + 5 min
}
```

Approve in the dashboard → `POST /api/cards/:id/approve` runs the Postmypost
upload → publications flow and marks the card `scheduled`.
