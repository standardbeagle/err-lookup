#!/usr/bin/env node
/**
 * Minimal ACP agent for tests: speaks just enough of the protocol to exercise
 * AcpProvider — initialize, session/new, session/prompt with a permission
 * round-trip, agent_message_chunk streaming, and (when the prompt names an
 * output file) writing the JSON payload to that file like a real agent would.
 *
 * Behavior toggles via env:
 *   FAKE_ACP_PAYLOAD  JSON to emit (default {"fake":true})
 *   FAKE_ACP_SKIP_FILE=1  never write the output file (failure-path testing)
 *   FAKE_ACP_STALL=1  go silent after session/prompt (idle-watchdog testing)
 *   FAKE_ACP_DRIP="<ms>,<count>"  before finishing, stream one message chunk
 *     every <ms> for <count> chunks (proves events hold the idle timer off)
 *   FAKE_ACP_ECHO_ENV=1  payload reports the env the agent was spawned with
 *     (isolation testing: XDG_CONFIG_HOME + OPENCODE_CONFIG_CONTENT)
 */
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const payload =
  process.env.FAKE_ACP_ECHO_ENV === "1"
    ? JSON.stringify({
        fake: true,
        xdgConfigHome: process.env.XDG_CONFIG_HOME ?? null,
        home: process.env.HOME ?? null,
        xdgDataHome: process.env.XDG_DATA_HOME ?? null,
        opencodeConfig: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "null"),
      })
    : process.env.FAKE_ACP_PAYLOAD ?? '{"fake":true}';
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

let promptId = null;
let awaitingPermission = false;

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "fake", version: "0" } } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "ses_fake" } });
  } else if (msg.method === "session/prompt") {
    promptId = msg.id;
    if (process.env.FAKE_ACP_STALL === "1") return; // hang forever, no events
    // Ask permission first, like opencode does before tool use.
    awaitingPermission = true;
    send({
      jsonrpc: "2.0",
      id: 999,
      method: "session/request_permission",
      params: {
        sessionId: "ses_fake",
        options: [
          { optionId: "reject", kind: "reject_once", name: "Reject" },
          { optionId: "ok", kind: "allow_once", name: "Allow" },
        ],
      },
    });
    const text = msg.params?.prompt?.[0]?.text ?? "";
    // A MARKER in the prompt is echoed into the payload so a concurrency test can
    // prove each call read back its OWN output file and not a sibling's.
    const marker = text.match(/MARKER:(\w+)/);
    const body = marker ? JSON.stringify({ fake: true, marker: marker[1] }) : payload;
    const m = text.match(/Write the final JSON to the file "([^"]+)"/);
    if (m && process.env.FAKE_ACP_SKIP_FILE !== "1") {
      writeFileSync(m[1], body);
    }
  } else if (msg.id === 999 && awaitingPermission) {
    // permission response from the client
    awaitingPermission = false;
    if (msg.result?.outcome?.optionId !== "ok") {
      send({ jsonrpc: "2.0", id: promptId, error: { code: -1, message: "permission denied" } });
      return;
    }
    const chunk = (text) =>
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "ses_fake", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
      });
    const finish = () => {
      chunk(`wrote output. ${payload}`);
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    };
    const drip = (process.env.FAKE_ACP_DRIP ?? "").match(/^(\d+),(\d+)$/);
    if (drip) {
      const [ms, count] = [Number(drip[1]), Number(drip[2])];
      let sent = 0;
      const t = setInterval(() => {
        chunk(`drip ${sent}`);
        if (++sent >= count) {
          clearInterval(t);
          finish();
        }
      }, ms);
    } else {
      finish();
    }
  }
});
