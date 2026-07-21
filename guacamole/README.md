# Guacamole gateway (virtual computers feature)

Streams VNC/RDP sessions for the "virtual computers" feature into the app's
browser UI. `guacd` (the actual protocol proxy) + `guacamole` (the HTML5 web
client) run as the official images, unmodified -- both are configured
entirely via env vars. `guacamole` already bundles the JSON auth extension,
which is what lets the Next.js server mint signed, short-lived connection
tokens without a separate Guacamole user database -- see `../lib/guacamole.ts`.

Deployed to Fly.io as one `guacd`+`guacamole` app **pair per region**
(`syd`, `iad`, `fra`, `sin`), not one multi-region app -- the official
`guacamole` image only supports a single, fixed `GUACD_HOSTNAME` per
deployment, so there's no way for one running instance to pick a different
`guacd` at request time. Each pair is otherwise identical, reachable from
each other over Fly's private 6PN network -- see `fly.guacd.<region>.toml` /
`fly.guacamole.<region>.toml`.

`lib/vmProviders/regions.ts` maps every VM region to whichever pair is
geographically closest (`resolveFlyRegion`), and
`app/api/virtual-computers/[id]/session/route.ts` mints each session's token
against that pair and hands its URL back to the browser -- see
`resolveGuacamoleUrl` in `../lib/guacamole.ts`. That's what makes "closest
gateway to the VM" real instead of everything routing through Sydney.

## Local dev

```bash
cp guacamole/.env.example guacamole/.env
# edit guacamole/.env: GUACAMOLE_JSON_SECRET_KEY=$(openssl rand -hex 16)
docker compose -f guacamole/docker-compose.yml --env-file guacamole/.env up -d
```

Web client at `http://localhost:8080/guacamole`. Set on the Next.js app's
`.env.local`:

```
GUACAMOLE_URL=http://localhost:8080/guacamole
NEXT_PUBLIC_GUACAMOLE_URL=http://localhost:8080/guacamole
GUACAMOLE_JSON_SECRET_KEY=<same value as guacamole/.env>
```

## Production (Fly.io)

Vercel can't run this (needs a persistent `guacd` process, not a serverless
function). Repeat per region (`syd`, `iad`, `fra`, `sin`) -- shown here for
one new region, `<region>`:

```bash
fly apps create diract-guacd-<region>
fly deploy -c guacamole/fly.guacd.<region>.toml -a diract-guacd-<region>

fly apps create diract-guacamole-<region>
# Same JSON_SECRET_KEY value across every region -- it's just the HMAC/AES
# key lib/guacamole.ts signs tokens with, not a per-instance credential.
fly secrets set -a diract-guacamole-<region> JSON_SECRET_KEY=<same value everywhere>
fly deploy -c guacamole/fly.guacamole.<region>.toml -a diract-guacamole-<region>
```

Then on the Next.js app (Vercel), set one URL var per region plus the shared
secret (see `lib/guacamole.ts`'s `REGION_URL_ENV` for the exact var names):

```
GUACAMOLE_URL_SYD=https://diract-guacamole-syd.fly.dev/guacamole
GUACAMOLE_URL_IAD=https://diract-guacamole-iad.fly.dev/guacamole
GUACAMOLE_URL_FRA=https://diract-guacamole-fra.fly.dev/guacamole
GUACAMOLE_URL_SIN=https://diract-guacamole-sin.fly.dev/guacamole
GUACAMOLE_JSON_SECRET_KEY=<same value passed to JSON_SECRET_KEY above>
```

`GUACAMOLE_URL` (no region suffix) still works as the local-dev /
single-region fallback for any region without its own var set.

Deploying to a different host (Railway, a VPS)? Same two containers,
`guacamole/docker-compose.yml` is the reference -- just make sure `guacd` is
reachable from the `guacamole` container on port 4822 and put TLS in front
of Guacamole's port 8080; the web client and the tokens minted by
`lib/guacamole.ts` should never be served over plain HTTP outside local dev.

## How the JSON auth extension works

No Postgres/MySQL and no Guacamole user accounts are needed. Instead:
`lib/guacamole.ts` builds a payload naming the target VM's protocol
(vnc/rdp), hostname, and credentials, signs + encrypts it with
`GUACAMOLE_JSON_SECRET_KEY` per Guacamole's documented algorithm
(https://guacamole.apache.org/doc/gug/json-auth.html -- HMAC-SHA256 sign,
prepend signature, AES-128-CBC encrypt with an all-zero IV, base64 encode),
and POSTs it to `${GUACAMOLE_URL}/api/tokens`. Guacamole verifies the
signature (via `JSON_SECRET_KEY`, which must be set to the same value) and
issues a normal auth token scoped to just that one connection, which the
browser then uses to open the session.
