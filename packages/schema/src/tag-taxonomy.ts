/**
 * The canonical background-family taxonomy: the closed list of families a
 * record's `backgroundTag` is allowed to name.
 *
 * `tags.ts` folds spelling and hand-written synonyms, and that was enough to
 * keep a name stable once it existed. It never bounded how many names could
 * exist: the enrichment prompt asks the model to coin a family, so the corpus
 * grew 56,960 distinct families over 496,100 records, 37,280 of them used
 * exactly once, while the top 250 covered 63% of the records. Sprawl on that
 * scale is not a spelling problem — `unsupported-operation`,
 * `operation-not-supported`, `method-not-implemented` and
 * `feature-not-implemented` are four names for one article, and no rule over
 * their characters says so.
 *
 * So the vocabulary stops being derived and becomes declared. A proposal is
 * mapped onto one of these families by a typed classifier
 * (`phase/tag-classify.ts`), or onto nothing at all; a family that is not in
 * this file cannot be published. Growth is a promotion: a proposal that keeps
 * arriving and fits nothing here shows up in `errlookup tags candidates`, and
 * someone adds it below with a rubric.
 *
 * Editing rules, in order of how often they are broken:
 *
 *   1. One line of `criteria` per family, written for a classifier that sees
 *      only this line and the error text. Say what belongs, then name the
 *      neighbouring family it is NOT. A rubric that describes the name back
 *      to itself ("invalid config value: the config value is invalid") makes
 *      the choice worse than no rubric.
 *   2. Every family must have a distinct `tagKey`. Two names that fold to the
 *      same key are the same family to the resolver, and the second one would
 *      be unreachable. `tag-taxonomy.test.ts` fails the build on this.
 *   3. When merging existing families, keep the name carrying the most
 *      records. It is the one whose article already holds the internal links,
 *      and renaming loses them for nothing.
 *   4. At most FAMILY_CHOICE_LIMIT entries. The whole list is offered as one
 *      Choice question so every classification sees every option; the model's
 *      hard cap is 255 options and one slot is spent on "none of these".
 */

/** A family a record's `backgroundTag` may name, with the rubric that selects it. */
export interface CanonicalFamily {
  /** Kebab-case family name, exactly as it is stored and published. */
  tag: string;
  /** One line telling a classifier what belongs here and what does not. */
  criteria: string;
}

/**
 * Options a single Choice question may carry, less the "none of these" slot.
 * Growing past this means the taxonomy no longer fits one decision and has to
 * be split into a two-stage (domain, then family) classification.
 */
export const FAMILY_CHOICE_LIMIT = 254;

export const CANONICAL_FAMILIES: readonly CanonicalFamily[] = [
  // ── Arguments, parameters, options ──────────────────────────────────────
  {
    tag: "missing-required-argument",
    criteria:
      "A required argument, parameter, field, property or option was not supplied at all by the caller. Use when the key is absent; if it was supplied but empty use empty-required-field, if supplied as null use null-argument, if it is a configuration key use missing-required-config.",
  },
  {
    tag: "empty-required-field",
    criteria:
      "A required value was supplied but carries nothing — empty string, empty list, empty object, whitespace only. The key is present, the content is not.",
  },
  {
    tag: "null-argument",
    criteria:
      "An argument was passed as null, nil, undefined, None or a zero pointer where the callee requires a value, including null members inside a supplied collection.",
  },
  {
    tag: "invalid-argument-value",
    criteria:
      "An argument of an acceptable type carries content the callee refuses after checking it, and no more specific family applies. The general fallback for argument validation.",
  },
  {
    tag: "invalid-argument-format",
    criteria:
      "A string argument does not match the syntax the callee parses, and no format-specific family fits (see invalid-url-format, invalid-date-format, invalid-regex-pattern, invalid-identifier-format).",
  },
  {
    tag: "invalid-argument-count",
    criteria:
      "The number of arguments is wrong: too few, too many, or a variadic call whose count does not match a format string, signature or arity check. About how many, not about what they contain.",
  },
  {
    tag: "value-out-of-range",
    criteria:
      "A numeric or sized value is outside the accepted bounds — negative where positive is required, over a maximum, under a minimum, a bad percentage, a port outside 1-65535. Not for indexing past the end of a collection (index-out-of-range).",
  },
  {
    tag: "invalid-enum-value",
    criteria:
      "The value is outside a fixed set of names the callee defines — a mode, strategy, driver, algorithm, log level or other closed option set. The message usually lists the accepted names.",
  },
  {
    tag: "mutually-exclusive-options",
    criteria:
      "Two or more supplied options, flags, arguments or config keys cannot be used together, or one of them requires a companion that is absent. The fault is the combination, not any single value.",
  },
  {
    tag: "invalid-identifier-format",
    criteria:
      "A name, key, identifier, slug or label breaks the rules for identifiers here: reserved word, forbidden characters, wrong length, wrong prefix or casing.",
  },
  {
    tag: "duplicate-identifier",
    criteria:
      "A name, key or id is already taken in a registry, map, namespace or plugin table, so the second registration is refused. Not for a stored entity that already exists (resource-already-exists) or a file (file-already-exists).",
  },
  {
    tag: "invalid-constructor-argument",
    criteria:
      "An object, client or handle cannot be constructed because the arguments to its constructor or factory are unusable together — about building the instance, not calling a method on one.",
  },

  // ── Command line ────────────────────────────────────────────────────────
  {
    tag: "missing-cli-argument",
    criteria:
      "A command-line invocation is missing a required flag, option, subcommand or positional argument, so the tool exits with usage. Use only when the surface is a CLI; the library-call equivalent is missing-required-argument.",
  },
  {
    tag: "invalid-cli-argument",
    criteria:
      "A command-line flag, option or positional argument was supplied with a value the tool rejects, or an unknown flag was passed. Use only when the surface is a CLI.",
  },

  // ── Configuration ───────────────────────────────────────────────────────
  {
    tag: "missing-required-config",
    criteria:
      "A configuration file, block, key, field or credential the component needs is absent from the configuration it was given. About configuration, not about arguments to a call.",
  },
  {
    tag: "invalid-config-value",
    criteria:
      "A single configuration value is present but unusable: wrong type, unsupported setting, or a value the loader validates and rejects. Two settings that contradict each other are mutually-exclusive-options.",
  },
  {
    tag: "unknown-config-key",
    criteria:
      "The configuration contains a key the reader does not recognize — a typo or a setting from another version — and it refuses rather than ignores it.",
  },
  {
    tag: "missing-env-var",
    criteria:
      "A required environment variable is unset or empty at the point it is read.",
  },
  {
    tag: "invalid-env-var-value",
    criteria:
      "An environment variable is set but its value cannot be used: unparseable, out of range, or not one of the accepted names.",
  },
  {
    tag: "config-file-not-found",
    criteria:
      "The configuration file itself is missing at every path the loader searched. Not a missing key inside a file that was found (missing-required-config).",
  },
  {
    tag: "config-parse-error",
    criteria:
      "A configuration file was found but could not be parsed or loaded into settings — syntax error, wrong document shape, unsupported version of the format.",
  },

  // ── Validation, schema, types ───────────────────────────────────────────
  {
    tag: "schema-validation-failed",
    criteria:
      "A document, payload or request was checked against a declared schema (JSON Schema, protobuf, OpenAPI, a validator library, a model's field rules) and failed it. The check is schema-driven, not a hand-written argument guard.",
  },
  {
    tag: "type-mismatch",
    criteria:
      "A value is the wrong type for where it is used — a string where a number is required, a list where an object is, a wrong class or interface, or input of a kind a documented API refuses. About the type, not about the content of a right-typed value.",
  },
  {
    tag: "type-conversion-failed",
    criteria:
      "An explicit cast, coercion or parse from one type to another failed on the value it was given: string to number, timestamp to date, bytes to string.",
  },
  {
    tag: "incompatible-source-type",
    criteria:
      "The kind of source, input or backend supplied is not one this operation handles at all — a directory where a file reader was invoked, a stream where a buffer is required, an unsupported input modality.",
  },

  // ── Serialization and parsing ───────────────────────────────────────────
  {
    tag: "json-parse-error",
    criteria:
      "Text that was supposed to be JSON could not be parsed: truncated, trailing content, wrong quoting, HTML where JSON was expected. Covers decoding a JSON response body.",
  },
  {
    tag: "json-serialization-failed",
    criteria:
      "A value could not be encoded to JSON — circular reference, unsupported type, a marshaller refusing a field.",
  },
  {
    tag: "protobuf-unmarshal-failed",
    criteria:
      "A binary wire format could not be decoded into a message: protobuf, msgpack, avro, gob, flatbuffers. Wrong field tags, truncated buffer, wrong message type.",
  },
  {
    tag: "yaml-parse-error",
    criteria: "A YAML document could not be parsed — indentation, duplicate keys, bad anchors, unexpected node type.",
  },
  {
    tag: "xml-parse-error",
    criteria: "An XML or HTML document could not be parsed — malformed markup, unclosed tags, bad entities, wrong encoding declaration.",
  },
  {
    tag: "template-parse-error",
    criteria:
      "A template could not be compiled: unknown directive, unbalanced block, bad expression syntax. Not a template that compiled and then failed while rendering (template-render-failed).",
  },
  {
    tag: "template-render-failed",
    criteria:
      "A compiled template failed while executing — a missing variable, a function that threw, a value the template could not print.",
  },
  {
    tag: "invalid-regex-pattern",
    criteria: "A regular expression could not be compiled, or is rejected for unsupported syntax or catastrophic backtracking.",
  },
  {
    tag: "invalid-glob-pattern",
    criteria: "A glob, path pattern or selector expression could not be compiled or matched nothing legal.",
  },
  {
    tag: "invalid-date-format",
    criteria: "A date or timestamp string does not match the expected layout, or names an impossible instant or timezone.",
  },
  {
    tag: "invalid-duration-format",
    criteria: "A duration, interval, timeout or cron-like schedule string could not be parsed into a span of time.",
  },
  {
    tag: "invalid-version-string",
    criteria: "A version or version-range string is not valid semver or the scheme in use, so it cannot be compared or resolved.",
  },
  {
    tag: "unexpected-eof",
    criteria: "Input ended in the middle of a structure the reader was consuming — truncated stream, partial frame, unterminated block.",
  },
  {
    tag: "invalid-escape-sequence",
    criteria: "A string contains an escape, encoding or code point the decoder rejects — bad percent-encoding, invalid UTF-8, unknown escape.",
  },

  // ── URLs, network addresses ─────────────────────────────────────────────
  {
    tag: "invalid-url-format",
    criteria:
      "A URL or URI is unusable: malformed, missing scheme or host, relative where absolute is required, or carrying a scheme this client does not speak.",
  },
  {
    tag: "invalid-ip-address",
    criteria: "An IP address, CIDR block, host:port pair or network mask could not be parsed or is not routable here.",
  },

  // ── HTTP and remote calls ───────────────────────────────────────────────
  {
    tag: "http-error-response",
    criteria:
      "A remote service answered with an error status — any non-2xx, including a 4xx the caller provoked (400, 404 from an API, 405 method not allowed) and a 5xx from the server. The call completed; the answer was an error. Not rate limiting (rate-limit-exceeded) and not auth (authentication-required, permission-denied).",
  },
  {
    tag: "http-request-failed",
    criteria:
      "An outbound HTTP, RPC or SDK call never produced a response: transport error, TLS failure, aborted socket, client-side exception while sending. No status code was received.",
  },
  {
    tag: "unexpected-response-shape",
    criteria:
      "A successful response arrived and parsed, but its content is not what the caller requires: a missing field, a null where an object was promised, a different schema version. The status was a success and the body was valid — an error status is http-error-response.",
  },
  {
    tag: "empty-api-response",
    criteria: "A call succeeded but came back with nothing — empty body, zero results where at least one is required, no content.",
  },
  {
    tag: "rate-limit-exceeded",
    criteria: "A service refused the call because a rate, request or usage limit was hit — 429, quota exhausted, too many concurrent calls. Retry timing is the fix.",
  },
  {
    tag: "request-timeout",
    criteria: "An operation exceeded its deadline: a request timeout, a context deadline, a lock or wait that expired. Nothing answered in time.",
  },
  {
    tag: "connection-refused",
    criteria: "A connection could not be established because nothing accepted it — refused, host unreachable, service not listening on that port.",
  },
  {
    tag: "connection-reset",
    criteria: "An established connection died mid-flight — reset by peer, broken pipe, EOF on a live socket, stream closed under the reader.",
  },
  {
    tag: "dns-resolution-failed",
    criteria: "A hostname could not be resolved to an address.",
  },
  {
    tag: "address-already-in-use",
    criteria: "A socket, port or unix path could not be bound because something already holds it.",
  },
  {
    tag: "unsupported-content-type",
    criteria: "A request or response carries a media type, encoding or content type this endpoint does not accept or cannot decode.",
  },
  {
    tag: "payload-too-large",
    criteria: "A request or response body exceeds a protocol, server or client size limit. For a file on disk or an upload measured as a file, use file-size-limit-exceeded.",
  },

  // ── Authentication, authorization, crypto ───────────────────────────────
  {
    tag: "missing-credentials",
    criteria: "No credential was supplied at all where one is required — API key, token, password, certificate or profile absent from every source checked.",
  },
  {
    tag: "invalid-credentials",
    criteria: "A credential was supplied and rejected as wrong: bad key, malformed token, wrong password, credential for another account or environment.",
  },
  {
    tag: "authentication-required",
    criteria: "The caller is not authenticated for this operation — no session, signed out, login required before continuing. About identity, not about rights (permission-denied).",
  },
  {
    tag: "authentication-failed",
    criteria: "An authentication exchange ran and failed: OAuth token exchange, handshake, SSO callback, state or nonce mismatch. A flow completed unsuccessfully rather than a credential being absent or plainly wrong.",
  },
  {
    tag: "token-expired",
    criteria: "A token, session, lease or signed URL was valid but has expired and must be refreshed.",
  },
  {
    tag: "permission-denied",
    criteria: "The identity is known but is not allowed to do this — insufficient scope, role or ACL, forbidden by policy. For the filesystem refusing on file mode use file-permission-denied.",
  },
  {
    tag: "signature-verification-failed",
    criteria: "A cryptographic signature, MAC or webhook signature did not verify against the payload and key.",
  },
  {
    tag: "checksum-mismatch",
    criteria: "Content did not match its expected hash, digest, size or integrity manifest — a corrupted or substituted artifact rather than a failed signature.",
  },
  {
    tag: "decryption-failed",
    criteria: "Data could not be decrypted or unsealed — wrong key, wrong algorithm, corrupt ciphertext, bad padding.",
  },
  {
    tag: "invalid-certificate",
    criteria: "A TLS or PEM certificate, key or chain is unusable: malformed, expired, untrusted issuer, hostname mismatch, half of a cert/key pair missing.",
  },
  {
    tag: "path-traversal-blocked",
    criteria: "A path, archive entry or URL was refused because it escapes the directory or origin it is confined to. A guard fired on purpose.",
  },

  // ── Filesystem ──────────────────────────────────────────────────────────
  {
    tag: "file-not-found",
    criteria: "A file does not exist at the path given. For a missing directory use directory-not-found, for a missing configuration file use config-file-not-found.",
  },
  {
    tag: "directory-not-found",
    criteria: "A directory does not exist at the path given, or a parent in the path is absent.",
  },
  {
    tag: "file-already-exists",
    criteria:
      "The filesystem already holds a file or directory at the destination and the operation refuses to overwrite it. For a uniqueness conflict in a data store use resource-already-exists.",
  },
  {
    tag: "file-open-failed",
    criteria:
      "Acquiring a handle failed although the path was reachable: opening an archive, mapping a buffer, creating a temporary file, a sidecar or socket file that would not open. The failure is in the open itself; failing while reading bytes afterwards is file-read-failed.",
  },
  {
    tag: "file-read-failed",
    criteria: "Opening or reading a file failed for a reason other than absence or permissions — I/O error, unreadable device, decode failure while reading.",
  },
  {
    tag: "file-write-failed",
    criteria: "Writing, flushing or syncing a file failed for a reason other than permissions or a full disk.",
  },
  {
    tag: "file-operation-failed",
    criteria: "A filesystem operation other than plain read or write failed: delete, rename, move, copy, stat, symlink, chmod, close.",
  },
  {
    tag: "directory-creation-failed",
    criteria: "Creating a directory or temporary working directory failed for a reason other than permissions.",
  },
  {
    tag: "file-permission-denied",
    criteria: "The filesystem refused an operation on file mode or ownership — read, write, create or execute denied by the OS. For a service refusing on policy use permission-denied.",
  },
  {
    tag: "path-is-not-a-directory",
    criteria: "A path exists but is the wrong kind of node: a file where a directory is required, a directory where a file is, a broken symlink or special file.",
  },
  {
    tag: "invalid-file-path",
    criteria: "A path string is unusable before any filesystem call: empty, too long, illegal characters, unresolvable relative path.",
  },
  {
    tag: "unsupported-file-format",
    criteria: "A file's format, extension or codec is not one this reader handles — wrong image type, unknown archive format, unsupported model or data file.",
  },
  {
    tag: "file-size-limit-exceeded",
    criteria: "A file or upload is larger than the limit the code enforces. For an HTTP body over a protocol limit use payload-too-large.",
  },
  {
    tag: "disk-full",
    criteria: "The device has no space or inodes left for the write.",
  },

  // ── Resources and lookups ───────────────────────────────────────────────
  {
    tag: "resource-not-found",
    criteria:
      "A named entity, record, row, key, session, model, plugin, table or object does not exist in the store or registry it was looked up in. The general lookup miss; use file-not-found for the filesystem and user-not-found for a user.",
  },
  {
    tag: "user-not-found",
    criteria:
      "A user, account, member or principal could not be found by the id, email or handle given. Use this rather than resource-not-found whenever the missing entity is a person.",
  },
  {
    tag: "element-not-found",
    criteria: "A DOM element, selector, UI node or accessibility target did not match anything on the page.",
  },
  {
    tag: "empty-result-set",
    criteria: "A query or search ran successfully and returned no rows where the caller requires at least one.",
  },
  {
    tag: "resource-already-exists",
    criteria: "Creating an entity, row, account or object failed because one with that key already exists — a uniqueness conflict in a store.",
  },
  {
    tag: "resource-in-use",
    criteria: "An object cannot be changed, deleted or released because something still holds it — open handle, active lease, referenced row, busy device.",
  },
  {
    tag: "resource-limit-exceeded",
    criteria: "A cap on allocated resources was hit that is not about request rate: too many open files, connection pool exhausted, plan quota, max concurrent workers.",
  },
  {
    tag: "out-of-memory",
    criteria: "An allocation failed or a heap, buffer or GPU memory limit was reached.",
  },

  // ── State and lifecycle ─────────────────────────────────────────────────
  {
    tag: "invalid-state-transition",
    criteria:
      "The object or system is in a state where this call is not legal: used after close, started twice, read before initialization, wrong lifecycle phase. The call itself is supported, just not now.",
  },
  {
    tag: "operation-cancelled",
    criteria: "Work stopped because it was cancelled or aborted — context cancelled, signal aborted, user interrupt, shutdown in progress. Not a timeout (request-timeout).",
  },
  {
    tag: "internal-invariant-violation",
    criteria:
      "An assertion about the library's own state failed and the message says this should be unreachable or asks for a bug report. The caller did nothing wrong that the code can name.",
  },
  {
    tag: "unsupported-operation",
    criteria:
      "The operation itself does not exist here: not implemented, abstract method not overridden, unsupported query operator, read-only implementation. Not a wrong-typed argument to an operation that does exist (type-mismatch), not a state (invalid-state-transition), not a licence or flag (feature-not-enabled), not an HTTP 405 from a server (http-error-response).",
  },
  {
    tag: "feature-not-enabled",
    criteria: "The capability exists but is switched off for this caller — feature flag, licence tier, build tag, experiment not enabled.",
  },
  {
    tag: "deprecated-api-usage",
    criteria: "The call is refused or warned against because it is deprecated, removed or replaced by another API.",
  },
  {
    tag: "unsupported-platform",
    criteria: "The operating system, architecture, runtime, browser or device does not support this code path or binary.",
  },
  {
    tag: "version-mismatch",
    criteria: "Two components, files, schemas or protocols carry versions that cannot work together, including a runtime or peer dependency below the required minimum.",
  },
  {
    tag: "module-init-failed",
    criteria: "A module, plugin, extension or native binding failed while loading or initializing, so nothing it provides is usable.",
  },
  {
    tag: "missing-dependency",
    criteria: "A required package, module, native library or binary is not installed, so the feature cannot run at all.",
  },
  {
    tag: "missing-optional-dependency",
    criteria: "An optional extra is not installed and the message names the install command that would enable this path. The core library works without it.",
  },
  {
    tag: "missing-context-provider",
    criteria: "A hook, injector or context consumer ran outside the provider, scope or request context that supplies its value.",
  },

  // ── Processes and tooling ───────────────────────────────────────────────
  {
    tag: "command-not-found",
    criteria: "An external executable could not be found on PATH or at the configured location.",
  },
  {
    tag: "command-execution-failed",
    criteria: "A subprocess was started and failed — non-zero exit, killed by a signal, spawn error, unreadable output. Use git-command-failed when the tool is git.",
  },
  {
    tag: "git-command-failed",
    criteria: "A git operation failed: clone, fetch, checkout, merge, bad ref or object, authentication to a remote.",
  },
  {
    tag: "not-a-git-repository",
    criteria: "The working directory is not inside a git repository, or the repository is absent where the tool requires one.",
  },
  {
    tag: "missing-build-artifact",
    criteria: "A build output, bundle, generated file or compiled asset the runtime expects has not been produced.",
  },

  // ── Concurrency ─────────────────────────────────────────────────────────
  {
    tag: "mutex-poisoned",
    criteria: "A lock, channel or shared primitive is unusable because a holder panicked, a channel is closed, or a concurrent-access rule was broken.",
  },
  {
    tag: "thread-interrupted",
    criteria: "A blocking wait was interrupted, or work was scheduled on the wrong thread, loop or executor.",
  },

  // ── Data, numerics, arrays ──────────────────────────────────────────────
  {
    tag: "shape-mismatch",
    criteria: "Array, tensor, matrix or vector dimensions do not line up for the operation — wrong rank, non-broadcastable shapes, mismatched lengths between parallel sequences.",
  },
  {
    tag: "dtype-mismatch",
    criteria: "The element type of an array, tensor or column is not the one the operation requires, including a device or precision mismatch.",
  },
  {
    tag: "index-out-of-range",
    criteria: "An index, slice, offset or key position falls outside the bounds of the collection, buffer or string being accessed.",
  },
  {
    tag: "integer-overflow",
    criteria: "An arithmetic result does not fit its type, or a numeric operation is undefined — overflow, underflow, division by zero, NaN where a finite value is required.",
  },

  // ── Databases ───────────────────────────────────────────────────────────
  {
    tag: "database-query-failed",
    criteria: "A read query failed at the database: syntax error, unknown column, planner or driver error while selecting.",
  },
  {
    tag: "database-write-failed",
    criteria: "An insert, update, delete, migration or transaction commit failed at the database. For a uniqueness conflict use resource-already-exists.",
  },
  {
    tag: "database-connection-failed",
    criteria: "A connection to the database could not be opened or was lost — bad DSN, auth to the server, pool closed, server unreachable.",
  },
];

/** Every canonical family name, for membership checks on the write path. */
export const CANONICAL_TAGS: ReadonlySet<string> = new Set(CANONICAL_FAMILIES.map((f) => f.tag));

/** Whether a tag may be stored as a record's background family. */
export function isCanonicalFamily(tag: string | null | undefined): boolean {
  return tag != null && CANONICAL_TAGS.has(tag);
}

/** Rubric for one family, or null when the name is not canonical. */
export function familyCriteria(tag: string): string | null {
  return CANONICAL_FAMILIES.find((f) => f.tag === tag)?.criteria ?? null;
}
