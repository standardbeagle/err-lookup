/**
 * Seed a fixture dataset into packages/site/public/data for local dev + the
 * site build test. In production the pipeline's `errlookup export` produces
 * these files; this script stands in so the site can build without the DB.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { buildSearchIndex } from "../../schema/src/search-core.js";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(root, "public", "data");

const shaAxios = "2e88108521a8e1c0b9b0ed8f5a04b29c21c2e9fc";
const shaIs = "7821031c66cdeb7256a0feb2d506535f9e84fcaf";

const errors = [
  {
    id: "a1b2c3d4e5f60718",
    repo: "axios/axios",
    slug: "err-bad-response",
    errorCode: "ERR_BAD_RESPONSE",
    errorMessage: "Request failed with status code {status}",
    messagePattern: "Request failed with status code (.+?)",
    errorType: "http",
    errorClass: "AxiosError",
    httpStatus: 416,
    severity: "error",
    filePath: "lib/core/settle.js",
    lineNumber: 18,
    sourceCode:
      "export function settle(resolve, reject, response) {\n  if (!validateStatus || validateStatus(response.status)) {\n    resolve(response);\n  } else {\n    reject(new AxiosError('Request failed with status code ' + response.status, ERR_BAD_RESPONSE));\n  }\n}",
    sourceCodeStart: 12,
    sourceCodeEnd: 20,
    githubUrl: `https://github.com/axios/axios/blob/${shaAxios}/lib/core/settle.js#L18`,
    documentation:
      "Axios rejects with `ERR_BAD_RESPONSE` when the server returns a status code that fails the request's `validateStatus` check. By default any status outside 200–399 is an error.",
    triggerScenarios:
      "Calling `axios.get(url)` against an endpoint returning a non-2xx status (404, 500, 416) without relaxing `validateStatus`.",
    commonSituations:
      "Server down (500), route missing (404), auth expired (401/403), or a proxy returning an unexpected intermediate status.",
    solutions: [
      "Inspect `error.response.status` and `error.response.data` to handle the specific status.",
      "Pass `validateStatus: (s) => s < 500` to accept 4xx as non-errors.",
      "Add a response interceptor to normalize the error shape app-wide.",
    ],
    exampleFix:
      "// BEFORE:\nawait axios.get('https://api.example.com/missing');\n\n// AFTER:\ntry { await axios.get(url); }\ncatch (e) { if (e.response?.status === 404) console.warn('not found'); else throw e; }",
    handlingStrategy: "try-catch",
    validationCode: "const isOk = (s) => s >= 200 && s < 400;",
    typeGuard: "const isAxiosError = (e) => Boolean(e?.isAxiosError);",
    tryCatchPattern: "try { await axios(url); } catch (e) { if (e.code === 'ERR_BAD_RESPONSE') handle(e); else throw e; }",
    preventionTips: ["Set `validateStatus` per-call.", "Use response interceptors for centralized mapping."],
    tags: ["http", "network", "axios"],
    analyzedSha: shaAxios,
    analyzedAt: "2026-07-14T00:00:00Z",
    schemaVersion: 2,
  },
  {
    id: "b2c3d4e5f6071829",
    repo: "axios/axios",
    slug: "econnaborted",
    errorCode: "ECONNABORTED",
    errorMessage: "timeout of {ms}ms exceeded",
    messagePattern: "timeout of (.+?)ms exceeded",
    errorType: "exception",
    errorClass: "AxiosError",
    httpStatus: null,
    severity: "error",
    filePath: "lib/adapters/http.js",
    lineNumber: 280,
    sourceCode: "if (req timed out) reject(new AxiosError('timeout of ' + timeout + 'ms exceeded', ECONNABORTED));",
    sourceCodeStart: 275,
    sourceCodeEnd: 282,
    githubUrl: `https://github.com/axios/axios/blob/${shaAxios}/lib/adapters/http.js#L280`,
    documentation:
      "Axios rejects with `ECONNABORTED` when the request exceeds the configured `timeout` (ms) before a response arrives.",
    triggerScenarios: "A slow server, a stalled connection, or a `timeout` value too low for the workload.",
    commonSituations: "Mobile/flaky networks, cold-start backends, large payloads without raised timeout.",
    solutions: [
      "Raise `timeout` for endpoints known to be slow.",
      "Retry with backoff for idempotent requests.",
      "Stream large responses instead of buffering.",
    ],
    exampleFix: "// axios.get(url, { timeout: 30000 }) // raise from default",
    handlingStrategy: "retry",
    validationCode: null,
    typeGuard: null,
    tryCatchPattern: "try { await axios(url, { timeout: 30000 }); } catch (e) { if (e.code === 'ECONNABORTED') retry(); }",
    preventionTips: ["Set per-route timeouts.", "Distinguish connect vs read timeouts."],
    tags: ["network", "timeout", "axios"],
    analyzedSha: shaAxios,
    analyzedAt: "2026-07-14T00:00:00Z",
    schemaVersion: 2,
  },
  {
    id: "c3d4e5f607182930",
    repo: "sindresorhus/is",
    slug: "expected-function",
    errorCode: null,
    errorMessage: "Expected a function, got {type}",
    messagePattern: "Expected a function, got (.+?)",
    errorType: "exception",
    errorClass: "TypeError",
    httpStatus: null,
    severity: "error",
    filePath: "index.js",
    lineNumber: 18,
    sourceCode: "if (typeof input !== 'function') throw new TypeError(`Expected a function, got ${typeof input}`);",
    sourceCodeStart: 14,
    sourceCodeEnd: 22,
    githubUrl: `https://github.com/sindresorhus/is/blob/${shaIs}/index.js#L18`,
    documentation:
      "`is` throws a TypeError when a value expected to be callable is not a function, guarding dynamic dispatch.",
    triggerScenarios: "Passing undefined, an object, or a primitive where a callback is expected.",
    commonSituations: "Optional-dependency resolving to undefined, misnamed import, migration shuffling arguments.",
    solutions: [
      "Guard with `typeof x === 'function'` before invoking.",
      "Provide a default no-op at the call site.",
      "Add a type annotation so the mismatch surfaces at compile time.",
    ],
    exampleFix: "run(typeof cb === 'function' ? cb : () => {})",
    handlingStrategy: "type-guard",
    validationCode: "const isFn = (x) => typeof x === 'function';",
    typeGuard: "const isFunction = (x) => typeof x === 'function';",
    tryCatchPattern: null,
    preventionTips: ["Type the callback parameter.", "Default to a no-op when undefined."],
    tags: ["typescript", "validation"],
    analyzedSha: shaIs,
    analyzedAt: "2026-07-14T00:00:00Z",
    schemaVersion: 2,
  },
];

const repos = [
  {
    repo: "axios/axios",
    description: "Promise based HTTP client for the browser and node.js",
    language: "JavaScript",
    stars: 106000,
    defaultBranch: "main",
    analyzedSha: shaAxios,
    analyzedAt: "2026-07-14T00:00:00Z",
    errorCount: 2,
  },
  {
    repo: "sindresorhus/is",
    description: "Type check values",
    language: "TypeScript",
    stars: 1900,
    defaultBranch: "main",
    analyzedSha: shaIs,
    analyzedAt: "2026-07-14T00:00:00Z",
    errorCount: 1,
  },
];

const datasetVersion = "2026-07-14T00:00:00Z";

const indexErrors = errors.map((e) => ({
  id: e.id,
  repo: e.repo,
  slug: e.slug,
  code: e.errorCode,
  msg: e.errorMessage,
  pattern: e.messagePattern,
  type: e.errorType,
  cls: e.errorClass,
  tags: e.tags,
  sev: e.severity,
}));

function write(rel, content) {
  const abs = resolve(dataDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content), "utf8");
}

const indexJson = JSON.stringify({ schemaVersion: 2, datasetVersion, errors: indexErrors });
const reposJson = JSON.stringify(repos);

write("index.json", indexJson);
write("repos.json", reposJson);
for (const r of repos) {
  const [owner, name] = r.repo.split("/");
  write(`repos/${owner}/${name}.json`, errors.filter((e) => e.repo === r.repo));
}
for (const e of errors) write(`errors/${e.id}.json`, e);

for (const f of buildSearchIndex(indexErrors)) write(f.relPath, f.content);

// Info pages — in production the collector (errlookup collect-info) writes
// these; one fixture page keeps /info/ rendering covered by the build test.
const infoPage = {
  slug: "err-bad-response",
  clusterKey: "code:ERR_BAD_RESPONSE",
  title: "ERR_BAD_RESPONSE: when the server's answer fails validation",
  summary:
    "HTTP clients raise ERR_BAD_RESPONSE when the server replies, but with a status the request was not configured to accept.",
  background:
    "The request completed at the transport layer — this family is about policy, not connectivity.\n\nClients ship a default acceptance window (usually 2xx) and surface everything else as an error carrying the full response.",
  commonCauses: [
    { cause: "Server-side failure", detail: "The endpoint returned 5xx; the client is only the messenger." },
    { cause: "Overly strict validateStatus", detail: "Expected 4xx responses (e.g. 404 probes) rejected by the default window." },
  ],
  fixes: ["Inspect the attached response before treating the error as fatal.", "Widen validateStatus for statuses the caller genuinely handles."],
  guideSlugs: ["http-status-errors"],
  errorIds: ["a1b2c3d4e5f60718"],
  errorCount: 1,
  repoCount: 1,
  generatedAt: "2026-07-14T00:00:00Z",
  schemaVersion: 1,
};
write("info/index.json", [
  {
    slug: infoPage.slug,
    title: infoPage.title,
    summary: infoPage.summary,
    errorCount: infoPage.errorCount,
    repoCount: infoPage.repoCount,
    generatedAt: infoPage.generatedAt,
  },
]);
write(`info/${infoPage.slug}.json`, infoPage);

const sha = (s) => createHash("sha256").update(s).digest("hex");
const manifest = {
  schemaVersion: 2,
  datasetVersion,
  counts: { repos: repos.length, errors: errors.length },
  files: {
    index: { path: "/data/index.json", bytes: Buffer.byteLength(indexJson), sha256: sha(indexJson) },
    repos: { path: "/data/repos.json", bytes: Buffer.byteLength(reposJson), sha256: sha(reposJson) },
  },
};
write("manifest.json", manifest);

console.log(`seeded ${repos.length} repos / ${errors.length} errors into ${dataDir}`);
