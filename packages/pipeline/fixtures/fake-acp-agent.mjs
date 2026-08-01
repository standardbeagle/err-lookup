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
 */
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const payload = process.env.FAKE_ACP_PAYLOAD ?? '{"fake":true}';
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
    const m = text.match(/Write the final JSON to the file "([^"]+)"/);
    if (m && process.env.FAKE_ACP_SKIP_FILE !== "1") {
      writeFileSync(m[1], payload);
    }
  } else if (msg.id === 999 && awaitingPermission) {
    // permission response from the client
    awaitingPermission = false;
    if (msg.result?.outcome?.optionId !== "ok") {
      send({ jsonrpc: "2.0", id: promptId, error: { code: -1, message: "permission denied" } });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "ses_fake", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `wrote output. ${payload}` } } },
    });
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  }
});
