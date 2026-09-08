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

## Result of the first routed drain (2026-09-07, ~50 minutes)

The production drain on beagle-ab, routed through the proxy by the drop-in
below, at the deployed `provider-max-concurrent 10`:

```
requests: 1745
statuses: { "200": 713, "429": 1032 }   ->  59.1% of all requests were 429
headerNamesSeen: [ "date", "x-request-id" ]
```

**The drain logged none of it.** Grepping that run's scan log for
`rate.?limit|429|breaker|FAILED` returns zero. Over a thousand throttled
requests, and the pipeline's own record of the run is silent. That is the
ping's finding at scale: opencode's SDK absorbs the 429 and retries, so
`provider/run.ts` never sees one until the SDK gives up entirely.

Still no rate-limit headers — only `date` and `x-request-id`, over 1,745
responses. The header route is closed, confirmed on a real sample rather than
a single ping.

### What the ratio implies

Successful requests landed at roughly 14/minute while the drain issued about
35/minute. If the account's ceiling is what actually gets through, the gate is
driving something like **2.4x the rate the account will serve**, and ~59% of
issued requests are pure waste — latency spent, no work done.

That is an inference from one window, not a measured ceiling. Establishing
the ceiling needs a second run at a lower `provider-max-concurrent` with the
same measurement: if successful requests per minute hold steady while the 429
share collapses, the gate is provably too high and the excess was never
buying throughput. That run has not been done.

It does supply a mechanism for a symptom already in the notes — the failure
breaker tripping every ~10-25 repos on "rate-limit storms". A storm is not an
anomaly arriving from outside; it is the tail of a distribution the drain sits
in permanently and cannot see.

## Second arm: the same window at `provider-max-concurrent 4`

Same drain, same corpus, same proxy, counters reset, window timed from first
traffic exactly as the first arm was.

| | gate 10 | gate 4 |
|---|---|---|
| requests | 1745 | 445 |
| 200 | 713 | 443 |
| 429 | 1032 | **2** |
| 429 share | 59.1% | **0.4%** |
| successes/min | ~14.3 | ~8.9 |

The gate really was 4: while the run was live, gate slots 0-3 were held by the
drain's pid and slots 4-9 were stale directories left by the previous arm's
killed process. (`MachineGate` reclaims a dead holder's slot lazily, on the
next acquire that needs it — the stale dirs are not a leak, but a slot-dir
count is not a reading of the live gate.)

### What this settles, and what it does not

**Settled: the throttling is self-inflicted and avoidable.** Dropping the gate
from 10 to 4 took the 429 share from 59.1% to 0.4%. Three quarters of the
request volume at gate 10 — 1,300 of 1,745 — bought nothing but latency.

**Not settled: whether gate 10 delivers more work.** Successful requests per
minute fell from ~14.3 to ~8.9, a 38% drop. If a successful request is
proportional to work done, gate 10 is genuinely extracting more despite the
waste, and the 429s are its price.

Repo completions point the other way — analyzed went 1628 → 1634 (+6) across
the first window and 1634 → 1642 (+8) across the second — but those counts
are noisy: different repos, different sizes, seeding moving `pending`
underneath, and a rescan counting the same as an import. They are indicative,
not a measurement.

There is a mechanism that would reconcile the two: at gate 10 the queue is
deeper, per-call latency is higher, and calls time out and get split
(`enrichment batch ... timed out — retrying as halves` appears in these logs).
A split batch spends more successful requests to produce the same records. If
that is what is happening, successful-requests/min overstates gate 10's output
and repo completions are the truer signal.

**To settle it, count records, not requests.** Records produced per window is
the deliverable; requests are the cost. Two longer windows measured on records
would decide it, and nothing here should be treated as deciding it early.

## Next step, unchanged in shape

Run a full drain with the proxy routed and read `statuses` afterwards. A 429
share near zero says the gate is sized correctly; the 50% seen in one idle
ping says it is not, but one ping is not a measurement of a drain.

Do not wire anything to depend on these numbers until that run exists.
(Done — see the second arm above. The gate question it raised is still open.)

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
`errlookup-scan.service` to put the drain back on a direct connection. It was
removed after the measurement above; production runs direct again, and
`errlookup-proxy.service` stays up carrying no traffic.

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
