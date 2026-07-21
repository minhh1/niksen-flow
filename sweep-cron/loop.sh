#!/bin/bash
# Reliable replacement for GitHub Actions' */5 cron, which was confirmed
# to only fire a small fraction of its scheduled ticks on this repo (1 run
# in 50 minutes, then 1 more in the next 30 -- GitHub's own scheduler is
# documented as best-effort and this repo hits that worst case in practice).
# This is just an always-on loop hitting the same sweep endpoint every 5
# minutes from a machine we fully control the cadence of.
while true; do
  curl -sf -X GET "https://diract.io/api/virtual-computers/sweep" \
    -H "Authorization: Bearer ${CRON_SECRET}" \
    && echo "$(date -Iseconds) sweep ok" \
    || echo "$(date -Iseconds) sweep FAILED"
  sleep 300
done
