import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MachineGate } from "../src/util/machine-gate.js";
import { sleep } from "../src/util/watchdog.js";

/** Resolves "pending" unless the promise settles within `ms`. */
async function outcome<T>(p: Promise<T>, ms: number): Promise<T | "pending"> {
  return Promise.race([p, sleep(ms).then(() => "pending" as const)]);
}

function gateDir(): string {
  return mkdtempSync(join(tmpdir(), "gate-test-"));
}

describe("MachineGate", () => {
  it("shares one budget across gate instances, as two processes would", async () => {
    const dir = gateDir();
    // Two instances over the same dir = the drain and the sweep. The whole
    // point of the gate: their PRIVATE limits must not add up.
    const a = new MachineGate(2, dir);
    const b = new MachineGate(2, dir);
    const r1 = await a.acquire();
    const r2 = await a.acquire();
    const blocked = b.acquire();
    expect(await outcome(blocked, 600)).toBe("pending");
    r1();
    const r3 = await blocked; // a released slot is b's to take
    r3();
    r2();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reclaims a slot whose holder process is dead", async () => {
    const dir = gateDir();
    const slot = join(dir, "slot-0");
    mkdirSync(slot);
    // A pid that cannot be running: beyond every Linux pid_max default.
    writeFileSync(join(slot, "pid"), "99999999");
    const g = new MachineGate(1, dir);
    const release = await g.acquire(); // SIGKILLed drains must not leak capacity
    release();
    rmSync(dir, { recursive: true, force: true });
  });

  it("respects a slot held by a live process", async () => {
    const dir = gateDir();
    const slot = join(dir, "slot-0");
    mkdirSync(slot);
    writeFileSync(join(slot, "pid"), String(process.pid)); // provably alive
    const g = new MachineGate(1, dir);
    expect(await outcome(g.acquire(), 600)).toBe("pending");
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves a fresh pidless slot alone (holder mid-acquire) but reclaims a stale one", async () => {
    const dir = gateDir();
    const slot = join(dir, "slot-0");
    mkdirSync(slot); // no pid file: a holder between mkdir and the pid write
    const g = new MachineGate(1, dir);
    expect(await outcome(g.acquire(), 400)).toBe("pending");
    // Stale: pretend the acquire crashed long ago.
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(slot, old, old);
    const release = await g.acquire();
    release();
    rmSync(dir, { recursive: true, force: true });
  });

  it("double release frees the slot once, never someone else's re-take", async () => {
    const dir = gateDir();
    const g = new MachineGate(1, dir);
    const r1 = await g.acquire();
    r1();
    const r2 = await g.acquire(); // the slot is legitimately re-taken
    r1(); // late double release of the FIRST hold must be a no-op
    expect(await outcome(g.acquire(), 400)).toBe("pending"); // r2 still holds
    r2();
    rmSync(dir, { recursive: true, force: true });
  });
});
