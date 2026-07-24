# Virtual computer performance test suite

Four scripts, matching the things that make a VM session feel slow:

1. **`network-latency.mjs`** -- raw TCP connect time to the Guacamole gateway
   and (optionally) a VM's own remote-desktop port. No browser, no login,
   run this from wherever you want to measure "distance" from.
2. **`session-latency.mjs`** -- how long from clicking "Open virtual
   computer" until the remote desktop visibly renders (Tier 2), plus a
   right-click-to-context-menu response time repeated a few times for a
   median (Tier 3). Needs a real running VM and a logged-in session.
3. **`click_latency.mjs`** -- right-click-to-redraw latency measured over
   Guacamole's raw WebSocket tunnel protocol directly (bypassing the
   browser/Guacamole webapp entirely), used for provider/config comparisons
   (e.g. DigitalOcean nested-KVM vs. AWS EC2). More precise than
   `session-latency.mjs`'s screenshot-byte heuristic since it reads the
   actual `png`/`sync` instructions off the wire, at the cost of needing
   `ws` and mints its own session via `/api/virtual-computers/{id}/session`.
   Usage: `node scripts/perf/click_latency.mjs <vm-id> "<label>"`.
4. **`save-auth-state.mjs`** -- one-time setup for #2/#3: logs in for real in
   a headed browser once, saves the session so the other scripts don't need
   to log in every run.

Every run's JSON output is also saved under `scripts/perf/results/` so
numbers are comparable over time (before/after a change, near vs. far
region, etc.) -- these are checked into git deliberately, as a running
changelog of measured performance, unlike `auth-state.json` (gitignored --
it's real session cookies).

## One-time setup

```
node scripts/perf/save-auth-state.mjs --url=http://localhost:3000
```

A real browser window opens to `/login`. Log in normally, then press Enter
in the terminal once you're on the dashboard. Re-run this whenever the
saved session expires.

## Running

```
# Network latency to the gateway + reference cloud regions
node scripts/perf/network-latency.mjs --label="baseline" [--vm-ip=1.2.3.4] [--vm-port=3389]

# Session connect + click response time for a specific VM
node scripts/perf/session-latency.mjs --vm-id=<uuid> --label="baseline"
```

`--label` is just a free-text tag stored in the output JSON (e.g.
`"before-rdp-tuning"`, `"aws-us-east-1"`, `"aws-ap-southeast-2"`) so you can
group/filter results later -- it doesn't change what's measured.

## Interpreting results

- `sessionConnectMs` -- time from click to the remote desktop visibly
  rendering. Dominated by network latency (see `network-latency.mjs`'s
  numbers for the same VM) and the far-region cross-ocean guacd hop (see
  `lib/vmProviders/regions.ts`'s `latencyTier` comment).
- `clickResponseMsMedian` -- median right-click-to-context-menu time across
  a few trials. This is the number most representative of "does it feel
  laggy to use," separate from initial connect time.
- Both use a screenshot-byte-size heuristic to detect "did the screen
  change" (no image-decoding library is installed) -- approximate, not
  frame-perfect, but consistent enough to compare configurations against
  each other.

## Known limitations

- Requires a real running VM to test against (these scripts don't create
  one) -- point `--vm-id` at an existing VM in whatever region/config you
  want to measure.
- Click-response measurement assumes an empty patch of desktop is
  right-clickable at pixel (250, 250) inside the session viewport -- true
  for a fresh Windows/Linux desktop, but move the VM's open windows out of
  the way first if you've been using it.
