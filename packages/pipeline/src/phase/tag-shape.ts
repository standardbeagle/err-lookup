/**
 * Procedural reading of an error: which failure mode it describes and what it
 * is about, taken from the proposed family name and from the message text,
 * plus the few content signals that settle a family outright.
 *
 * Proposed names are regular. 57k of them reduce to a handful of failure
 * modes (`invalid`, `missing`, `not-found`, `unsupported`, `mismatch`, ...)
 * wrapped around an object (argument, config, file, json, http, ...). Parsed
 * that way, 81% of the corpus's proposed records land in about 230
 * (mode × object) cells — a workable candidate set produced without a single
 * model call. `tag-cells.ts` pools them and `tag-propose.ts` has them checked.
 *
 * Everything here is deterministic and cheap enough to run over the whole
 * corpus. None of it decides a family by itself except `contentFamily`, which
 * is limited to signals measured precise enough to trust.
 */

/**
 * What went wrong, independent of what it went wrong with. Fine-grained on
 * purpose: `expired × auth` and `timeout × remote` are families of their own,
 * and a coarser vocabulary would fold them into `invalid` and `failed`.
 */
export type FailureMode =
  | "absent"
  | "empty"
  | "null"
  | "invalid"
  | "range"
  | "mismatch"
  | "unsupported"
  | "disabled"
  | "deprecated"
  | "conflict"
  | "denied"
  | "timeout"
  | "expired"
  | "refused"
  | "state"
  | "invariant"
  | "cancelled"
  | "failed";

/** What the failure is about. */
export type ObjectClass =
  | "argument"
  | "config"
  | "filesystem"
  | "format"
  | "remote"
  | "network"
  | "auth"
  | "storage"
  | "entity"
  | "type"
  | "array"
  | "state"
  | "operation"
  | "dependency";

export interface Shape {
  mode: FailureMode | null;
  object: ObjectClass | null;
  /**
   * The object token that decided `object`, e.g. "url" for `format`. Cells
   * split on it when one subject carries enough records to be a family of its
   * own — `invalid × format` is too broad, `invalid × format:url` is not.
   */
  subject: string | null;
}

// Longest pattern first, so "already-exists" beats "exists".
const SUFFIX_MODES: [string, FailureMode][] = sortByLength({
  "not-found": "absent",
  "does-not-exist": "absent",
  "not-exist": "absent",
  missing: "absent",
  required: "absent",
  unset: "absent",
  "not-set": "absent",
  "not-provided": "absent",
  "not-specified": "absent",
  "not-configured": "absent",
  empty: "empty",
  "out-of-range": "range",
  "out-of-bounds": "range",
  exceeded: "range",
  overflow: "range",
  "too-large": "range",
  "too-long": "range",
  "too-many": "range",
  mismatch: "mismatch",
  incompatible: "mismatch",
  "not-implemented": "unsupported",
  "not-supported": "unsupported",
  unsupported: "unsupported",
  "not-available": "unsupported",
  "not-enabled": "disabled",
  disabled: "disabled",
  deprecated: "deprecated",
  "already-exists": "conflict",
  "already-in-use": "conflict",
  "already-registered": "conflict",
  exists: "conflict",
  conflict: "conflict",
  duplicate: "conflict",
  denied: "denied",
  forbidden: "denied",
  unauthorized: "denied",
  blocked: "denied",
  rejected: "denied",
  detected: "denied",
  "not-permitted": "denied",
  "not-allowed": "denied",
  "not-authenticated": "denied",
  timeout: "timeout",
  "timed-out": "timeout",
  "deadline-exceeded": "timeout",
  expired: "expired",
  refused: "refused",
  violation: "invariant",
  panic: "invariant",
  transition: "state",
  "not-initialized": "state",
  uninitialized: "state",
  "in-use": "state",
  "after-close": "state",
  closed: "state",
  cancelled: "cancelled",
  canceled: "cancelled",
  aborted: "cancelled",
  interrupted: "cancelled",
  failed: "failed",
  failure: "failed",
  error: "failed",
  errors: "failed",
  exhausted: "failed",
  response: "failed",
});

const PREFIX_MODES: [string, FailureMode][] = sortByLength({
  missing: "absent",
  no: "absent",
  unset: "absent",
  undefined: "absent",
  empty: "empty",
  null: "null",
  nil: "null",
  none: "null",
  invalid: "invalid",
  malformed: "invalid",
  bad: "invalid",
  illegal: "invalid",
  wrong: "invalid",
  unknown: "invalid",
  unrecognized: "invalid",
  unexpected: "invalid",
  corrupt: "invalid",
  corrupted: "invalid",
  unsupported: "unsupported",
  unimplemented: "unsupported",
  deprecated: "deprecated",
  conflicting: "conflict",
  "mutually-exclusive": "conflict",
  duplicate: "conflict",
  ambiguous: "conflict",
  incompatible: "mismatch",
  insufficient: "denied",
  unauthorized: "denied",
  forbidden: "denied",
  "too-many": "range",
  "not-a": "mismatch",
});

const OBJECT_TOKENS: Record<ObjectClass, string[]> = {
  argument: [
    "argument", "arguments", "arg", "args", "parameter", "parameters", "param", "params", "field",
    "fields", "property", "properties", "prop", "input", "option", "options", "flag", "flags",
    "attribute", "kwarg", "kwargs", "value", "values", "enum", "constructor", "cli", "usage",
  ],
  config: ["config", "configuration", "setting", "settings", "env", "environment", "variable", "var"],
  filesystem: [
    "file", "files", "path", "directory", "dir", "folder", "mkdir", "disk", "filesystem", "fs",
    "symlink", "tmp", "temp", "archive", "zip",
  ],
  format: [
    "json", "yaml", "yml", "xml", "toml", "csv", "protobuf", "proto", "template", "regex", "pattern",
    "url", "uri", "date", "time", "timestamp", "duration", "version", "semver", "identifier", "name",
    "syntax", "parse", "encoding", "utf8", "base64", "cron", "glob", "expression", "escape", "eof",
    "uuid", "email", "number", "serialization", "deserialization", "unmarshal", "marshal", "decode",
    "schema",
  ],
  remote: [
    "http", "api", "request", "response", "upstream", "endpoint", "rpc", "grpc", "graphql", "webhook",
    "status", "fetch", "download", "upload", "redirects", "non",
  ],
  network: ["connection", "socket", "dns", "port", "network", "tls", "ssl", "host", "address", "proxy", "pipe"],
  auth: [
    "auth", "authentication", "authorization", "credential", "credentials", "token", "jwt", "oauth",
    "password", "permission", "permissions", "key", "secret", "login", "signature", "certificate",
    "cert", "decryption", "encryption", "checksum",
  ],
  // "schema" is a data-format word here — schema-validation-failed is about a
  // document failing its declared shape, not about a database.
  storage: ["database", "db", "sql", "table", "column", "row", "transaction", "migration", "index", "query"],
  entity: [
    "resource", "entity", "object", "user", "item", "model", "record", "collection", "plugin", "node",
    "element", "selector", "account", "project", "document", "session",
  ],
  type: ["type", "types", "dtype", "class", "instance", "cast", "conversion"],
  array: ["tensor", "shape", "array", "dimension", "dimensions", "rank", "matrix", "vector", "length", "size", "buffer"],
  state: ["state", "lifecycle", "invariant", "internal", "assertion", "initialization", "init", "mutex", "lock", "thread"],
  operation: [
    "operation", "method", "function", "feature", "command", "subprocess", "process", "execution",
    "platform", "backend", "git", "memory",
  ],
  dependency: ["dependency", "dependencies", "package", "library", "import", "binary", "executable", "module", "extension"],
};

const OBJECT_OF: Map<string, ObjectClass> = new Map(
  Object.entries(OBJECT_TOKENS).flatMap(([cls, toks]) => toks.map((t) => [t, cls as ObjectClass]))
);

function sortByLength(table: Record<string, FailureMode>): [string, FailureMode][] {
  return Object.entries(table).sort((a, b) => b[0].length - a[0].length);
}

/** Decompose a kebab-case family name into mode, object and the deciding token. */
export function nameShape(name: string): Shape {
  let mode: FailureMode | null = null;
  let rest = name;

  for (const [pat, m] of SUFFIX_MODES) {
    if (rest === pat || rest.endsWith(`-${pat}`)) {
      mode = m;
      rest = rest.slice(0, rest.length - pat.length).replace(/-+$/, "");
      break;
    }
  }
  if (mode === null) {
    // A mode that sits mid-name: "path-is-not-a-directory", "resource-not-found-404".
    for (const [pat, m] of SUFFIX_MODES) {
      const i = rest.indexOf(`-${pat}-`);
      if (pat.includes("-") && i >= 0) {
        mode = m;
        rest = rest.slice(0, i);
        break;
      }
    }
  }
  for (const [pat, m] of PREFIX_MODES) {
    if (rest === pat || rest.startsWith(`${pat}-`)) {
      // A prefix is more specific than the generic "-failed"/"-error" suffix:
      // "invalid-json-error" is about invalid JSON, not a failure of JSON.
      if (mode === null || mode === "failed") mode = m;
      rest = rest.slice(pat.length).replace(/^-+/, "");
      break;
    }
  }

  let object: ObjectClass | null = null;
  let subject: string | null = null;
  for (const token of rest.split("-")) {
    const cls = OBJECT_OF.get(token);
    if (cls) {
      object = cls;
      subject = token;
      break;
    }
  }
  return { mode, object, subject };
}

/**
 * Failure mode stated in a message, or null when the wording commits to none.
 * Ordered specific-first: "value must be between 1 and 5" is a range fault
 * even though the same message could also be called invalid.
 */
const MESSAGE_MODES: [FailureMode, RegExp][] = [
  ["null", /\b(must not be|cannot be|can't be|may not be|should not be|is|was)\s+(null|nil|none|undefined)\b|\bnull (argument|reference|pointer)\b/i],
  ["empty", /\b(must not be|cannot be|can't be|may not be|is|was)\s+(empty|blank)\b|\bempty (string|list|array|value|name)\b/i],
  ["range", /\bmust be (between|greater|less|at least|at most|positive|negative|non-negative|>=|<=|>|<)|\bout of (range|bounds)\b|\bexceeds?\b|\btoo (large|long|many|big|small)\b|\bmaximum\b|\bminimum\b/i],
  ["absent", /\b(is|are) (required|missing)\b|\bmissing\b|\brequired\b|\bnot (set|provided|specified|configured|defined)\b|\bnot found\b|\bdoes not exist\b|\bno such\b|\bcould not (find|locate)\b|\bunable to find\b/i],
  ["conflict", /\balready (exists|registered|defined|in use)\b|\bduplicate\b|\bmutually exclusive\b|\bcannot be (used|combined|specified) (together|with)\b|\bconflict/i],
  ["unsupported", /\bnot (supported|implemented)\b|\bunsupported\b|\bnot yet implemented\b/i],
  ["denied", /\b(permission|access) denied\b|\bforbidden\b|\bunauthori[sz]ed\b|\bnot (allowed|permitted)\b|\binsufficient (permission|privilege)/i],
  ["timeout", /\btimed? ?out\b|\bdeadline\b/i],
  ["expired", /\bexpired\b/i],
  ["mismatch", /\bmismatch\b|\bdoes not match\b|\bincompatible\b/i],
  ["state", /\balready (closed|started|running|initiali[sz]ed|disposed)\b|\bnot (initiali[sz]ed|started|running|open|connected)\b|\bafter (close|dispose)\b/i],
  ["failed", /\bfailed to\b|\bcould not\b|\bunable to\b|\bfailed\b/i],
  ["invalid", /\binvalid\b|\bmalformed\b|\bunknown\b|\bunrecognized\b|\bunexpected\b|\billegal\b|\bmust be\b/i],
];

export function messageMode(message: string): FailureMode | null {
  for (const [mode, rx] of MESSAGE_MODES) if (rx.test(message)) return mode;
  return null;
}

/**
 * Modes that describe a fault without saying which. "failed to load" and
 * "invalid value" are true of almost every error; two readings agreeing on
 * one of these is weak evidence, and disagreeing with one is not evidence
 * against anything.
 */
export const WEAK_MODES: ReadonlySet<FailureMode> = new Set<FailureMode>(["failed", "invalid"]);

/** The fields of a page the content signals read. */
export interface PageSignals {
  errorClass: string | null;
  errorCode: string | null;
  httpStatus: number | null;
  errorMessage: string;
}

/**
 * Exception classes that name their family outright. Only classes measured
 * precise on a 30k-page sample are here: `ArgumentNullException` agrees with
 * the page's own proposal three times in four and the rest is noise in the
 * proposals. `IllegalStateException`, `InvalidOperationException` and
 * `TypeError` were measured and left out — libraries throw them for
 * everything, so the class says which runtime, not which fault.
 */
const CLASS_FAMILIES: Record<string, string[]> = {
  "null-argument": ["ArgumentNullException", "NullPointerException", "ArgumentNullError"],
  "value-out-of-range": ["ArgumentOutOfRangeException", "OutOfRangeException"],
  "index-out-of-range": [
    "IndexError", "IndexOutOfRangeException", "IndexOutOfBoundsException",
    "ArrayIndexOutOfBoundsException", "StringIndexOutOfBoundsException",
  ],
  "integer-overflow": ["OverflowError", "OverflowException", "ZeroDivisionError", "DivideByZeroException"],
  "unsupported-operation": [
    "NotImplementedError", "NotImplementedException", "UnsupportedOperationException", "NotSupportedException",
  ],
  "unsupported-platform": ["PlatformNotSupportedException"],
  "file-not-found": ["FileNotFoundError", "FileNotFoundException", "NoSuchFileException"],
  "directory-not-found": ["DirectoryNotFoundException"],
  "file-already-exists": ["FileExistsError", "FileAlreadyExistsException"],
  "path-is-not-a-directory": ["IsADirectoryError", "NotADirectoryError"],
  "request-timeout": ["TimeoutError", "TimeoutException", "SocketTimeoutException", "TimeoutExpired"],
  "missing-dependency": ["ImportError", "ModuleNotFoundError", "ClassNotFoundException", "NoClassDefFoundError", "DllNotFoundException"],
  "json-parse-error": ["JSONDecodeError", "JsonParseException", "JsonReaderException", "JsonSyntaxException"],
  "connection-refused": ["ConnectionRefusedError", "ConnectException"],
  "connection-reset": ["ConnectionResetError", "BrokenPipeError", "ConnectionAbortedError"],
  "thread-interrupted": ["InterruptedException", "ThreadInterruptedException"],
  "operation-cancelled": ["CancelledError", "OperationCanceledException", "TaskCanceledException", "CancellationException"],
  "out-of-memory": ["MemoryError", "OutOfMemoryError", "OutOfMemoryException", "InsufficientMemoryException"],
  "invalid-escape-sequence": ["UnicodeDecodeError", "UnicodeEncodeError", "DecoderFallbackException"],
};

const FAMILY_OF_CLASS: Map<string, string> = new Map(
  Object.entries(CLASS_FAMILIES).flatMap(([family, classes]) => classes.map((c) => [c, family]))
);

const ERRNO_FAMILIES: Record<string, string> = {
  ENOENT: "file-not-found",
  EACCES: "file-permission-denied",
  EPERM: "file-permission-denied",
  EEXIST: "file-already-exists",
  ECONNREFUSED: "connection-refused",
  ECONNRESET: "connection-reset",
  EPIPE: "connection-reset",
  ETIMEDOUT: "request-timeout",
  EADDRINUSE: "address-already-in-use",
  ENOSPC: "disk-full",
  ENOTDIR: "path-is-not-a-directory",
  EISDIR: "path-is-not-a-directory",
  ENOTFOUND: "dns-resolution-failed",
  EAI_AGAIN: "dns-resolution-failed",
};
const ERRNO_RE = new RegExp(`\\b(${Object.keys(ERRNO_FAMILIES).join("|")})\\b`);

/**
 * HTTP statuses whose meaning does not depend on the library. 400, 422 and
 * 500 are absent on purpose: a server library raising HTTPException(400,
 * "name is required") is a missing argument, and the status says nothing the
 * message does not.
 */
const HTTP_FAMILIES: Record<number, string> = {
  401: "authentication-required",
  403: "permission-denied",
  413: "payload-too-large",
  429: "rate-limit-exceeded",
  408: "request-timeout",
  504: "request-timeout",
};

/** Every family a content rule can produce, so tests can hold them to the taxonomy. */
export const CONTENT_RULE_FAMILIES: ReadonlySet<string> = new Set([
  ...Object.keys(CLASS_FAMILIES),
  ...Object.values(ERRNO_FAMILIES),
  ...Object.values(HTTP_FAMILIES),
]);

export interface ContentFamily {
  family: string;
  source: "class" | "errno" | "http";
}

/**
 * The family a page's own content settles, or null. When two signals on one
 * page disagree nothing is settled: the rules are only worth running because
 * they are precise, and a page that trips two of them is not a page they
 * describe.
 */
export function contentFamily(page: PageSignals): ContentFamily | null {
  const found: ContentFamily[] = [];
  const cls = (page.errorClass ?? "").split(/[.:\\]+/).pop() ?? "";
  const byClass = FAMILY_OF_CLASS.get(cls);
  if (byClass) found.push({ family: byClass, source: "class" });

  const code = page.errorCode ?? "";
  const errno = ERRNO_FAMILIES[code] ?? ERRNO_FAMILIES[ERRNO_RE.exec(page.errorMessage)?.[1] ?? ""];
  if (errno) found.push({ family: errno, source: "errno" });

  const byStatus = page.httpStatus != null ? HTTP_FAMILIES[page.httpStatus] : undefined;
  if (byStatus) found.push({ family: byStatus, source: "http" });

  if (found.length === 0) return null;
  const families = new Set(found.map((f) => f.family));
  return families.size === 1 ? found[0]! : null;
}
