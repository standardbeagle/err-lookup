import { mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sleep } from "./watchdog.js";

/**
 * Machine-wide counting semaphore: numbered slot directories under one gate
 * dir, taken with mkdir (atomic on POSIX) and released with rmdir.
 *
 * The in-process Semaphore caps calls per PROCESS, but z.ai throttles the
 * ACCOUNT: a drain and a reverify sweep each honouring provider-max-concurrent
 * 10 put up to 20 calls in flight together, and the resulting rate-limit
 * storms abandoned 68 sweep batches and failed 5 scan repos on 2026-09-01/02.
 * Slots here are shared by every errlookup process on the host, so the
 * configured ceiling is the real ceiling.
 *
 * Same mkdir-mutex family as errlookup-large-repo.lock, and like it the gate
 * dir is on the scan sweep's never-touch list — deleting a held slot would
 * admit a phantom call past the account limit.
 *
 * Liveness: each slot holds a `pid` file. A slot whose pid is dead is
 * reclaimed (SIGKILLed drains must not leak capacity); a slot with no pid
 * file yet is only reclaimed after a grace period, because its holder may be
 * between mkdir and the pid write.
 */

/** A slot missing its pid file older than this is a crashed acquire. */
const PIDLESS_GRACE_MS = 15_000;
const POLL_MS = 200;

/**
 * ERRLOOKUP_PROVIDER_GATE_DIR overrides the slot directory — the test suite
 * points each worker process at its own temp dir, because sharing the real
 * machine gate across parallel workers is exactly the contention the gate
 * exists to create.
 */
export function defaultGateDir(): string {
  return process.env.ERRLOOKUP_PROVIDER_GATE_DIR || join(tmpdir(), "errlookup-provider-gate");
}

export class MachineGate {
  private readonly dir: string;
  constructor(readonly limit: number, dir?: string) {
    this.dir = dir ?? defaultGateDir();
    mkdirSync(this.dir, { recursive: true });
  }

  async acquire(): Promise<() => void> {
    for (;;) {
      for (let i = 0; i < this.limit; i++) {
        const slot = join(this.dir, `slot-${i}`);
        if (this.tryTake(slot)) {
          let released = false;
          return () => {
            if (released) return; // double-release must not free someone else's slot
            released = true;
            rmSync(slot, { recursive: true, force: true });
          };
        }
      }
      await sleep(POLL_MS + Math.random() * POLL_MS);
    }
  }

  private tryTake(slot: string): boolean {
    if (!this.claim(slot)) {
      if (!this.holderDead(slot)) return false;
      // Reclaim: the rm and re-mkdir race against other reclaimers, and mkdir
      // arbitrates — exactly one process wins the recreated slot.
      rmSync(slot, { recursive: true, force: true });
      if (!this.claim(slot)) return false;
    }
    writeFileSync(join(slot, "pid"), String(process.pid));
    return true;
  }

  private claim(slot: string): boolean {
    try {
      mkdirSync(slot); // non-recursive: EEXIST = occupied
      return true;
    } catch {
      return false;
    }
  }

  private holderDead(slot: string): boolean {
    try {
      const pid = Number(readFileSync(join(slot, "pid"), "utf8").trim());
      if (!Number.isFinite(pid) || pid <= 0) return true;
      try {
        process.kill(pid, 0);
        return false; // alive
      } catch {
        return true; // ESRCH — the holder is gone
      }
    } catch {
      // No pid file: the holder may be mid-acquire — reclaim only when stale.
      try {
        return Date.now() - statSync(slot).mtimeMs > PIDLESS_GRACE_MS;
      } catch {
        return false; // slot vanished under us; the next claim() decides
      }
    }
  }
}
