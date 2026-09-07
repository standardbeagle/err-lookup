# Recording provider proxy — what the first live run found

**Date:** 2026-09-07
**Change:** `packages/pipeline/src/proxy`, `errlookup proxy`

## Why it exists

err-lookup never speaks HTTP to a model. Every call is a spawned CLI —
`opencode acp` — and the subprocess owns the connection. Response headers die
inside it. What reaches `provider/run.ts` is prose, matched by three regexes
(`RATE_LIMIT_RE`, `USAGE_LIMIT_RE`, `BILLING_CYCLE_RE`) and, for z.ai's unzoned
reset stamp, a guess about which timezone it meant.

The proxy sits on loopback between opencode and the real endpoint, forwards
byte for byte, and records what came back. Stage one is deliberately
read-only: it does not throttle, retry, or hold.

## Result of the first live run

One `errlookup ping` through the proxy to `https://api.z.ai/api/coding/paas/v4`:

```
requests: 4
statuses: { "200": 2, "429": 2 }
headerNamesSeen: [ "date" ]
```

Two findings, and the second matters more than the first.

**1. z.ai sends no rate-limit headers.** Not `x-ratelimit-*`, not the IETF
`ratelimit-*`, not even `retry-after` on a 429. The only recorded header
present was `date`. So the original plan — read the published limit, size the
gate from it — has no data source at this provider. That route is closed
unless z.ai starts sending them, which `headerNamesSeen` will notice on its
own.

**2. A single successful ping was rate-limited twice.** Four requests, two
429s, and the CLI still reported `ping flash: ok (31s)`. opencode's SDK
retried internally and never surfaced an error, so `provider/run.ts` saw a
clean success. Nothing in err-lookup's logs, counters, or quota regexes
records that half the requests bounced.

That is the real gap. The error-text path only sees a rate limit when the SDK
gives up completely — it is blind to the throttling that happens under a call
that eventually succeeds, which is most of it. The 429 *rate*, not a header,
is the signal `provider-max-concurrent 10` should have been tuned against, and
the proxy is the only place it is visible.

## What this changes

- Sizing the gate from published limits: **not possible here**. Drop it.
- Sizing the gate from the observed 429 rate: **possible, and new**. The
  snapshot's `statuses` map is the input.
- The quota regexes in `provider/run.ts` stay. They catch the cases the SDK
  gives up on, and nothing here replaces them.

## Next step, unchanged in shape

Run a full drain with the proxy routed and read `statuses` afterwards. A 429
share near zero says the gate is sized correctly; the 50% seen in one idle
ping says it is not, but one ping is not a measurement of a drain.

Do not wire anything to depend on these numbers until that run exists.

## How the measurement run is wired on beagle-ab

The production config keeps `proxy.enabled false`, so the deployed file never
routes anything. The measurement run is switched on with a systemd drop-in
instead:

```
/etc/systemd/system/errlookup-scan.service.d/proxy-measure.conf
  [Service]
  Environment=ERRLOOKUP_PROXY_ENABLED=1
```

The drain runs under its usual unit — same caps, same watchdog, same timer —
and stays supervised. **This file is temporary.** Remove it and restart
`errlookup-scan.service` to put the drain back on a direct connection.

Two things were tried first and rejected:

- *Waiting for the scan lock to free.* The queue does not empty on a horizon
  worth waiting for, and `errlookup-scan.service` restarts itself into the
  lock, so a manual routed drain loses the race and silently exits 0.
- *Masking the unit* to stop it restarting. That halts production drains for
  the length of the experiment, and leaves them halted if the session running
  it dies. The drop-in fails safe in the other direction: worst case the
  drain keeps running through a proxy that is up and has `Restart=always`.

`errlookup-proxy.service` must be enabled and active before the drop-in goes
in. A routed call to a dead proxy fails outright.
