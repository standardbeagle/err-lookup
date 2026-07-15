#!/usr/bin/env node
import { runServer } from "./server.js";

runServer().catch((e) => {
  console.error((e as Error).stack ?? (e as Error).message);
  process.exit(1);
});
