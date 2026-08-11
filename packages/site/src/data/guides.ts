import { getIndex, type IndexError } from "./load.js";

/**
 * Explainer guides: one evergreen article per failure class, matched to error
 * records by code and message shape (tags proved too scattered to key on).
 * The registry drives everything — guide pages, the hub, the links on error
 * pages, and the sitemap — so adding a guide is one entry plus one article.
 */
export interface GuideDef {
  slug: string;
  title: string;
  /** Link text on error pages — completes the sentence "Read the guide: …". */
  short: string;
  description: string;
  codes: RegExp | null;
  message: RegExp;
}

export const GUIDES: GuideDef[] = [
  {
    slug: "connection-failures",
    title: "Connection failures: ECONNREFUSED, ECONNRESET, and friends",
    short: "why connections get refused, reset, or dropped",
    description:
      "What ECONNREFUSED, ECONNRESET, EPIPE, and 'socket hang up' actually mean, how to tell them apart, and how to debug each one.",
    codes: /^(ECONNREFUSED|ECONNRESET|ECONNABORTED|EPIPE|EHOSTUNREACH|ENETUNREACH)$/,
    message: /connection (refused|reset|aborted|closed)|socket hang up|broken pipe/i,
  },
  {
    slug: "dns-resolution",
    title: "DNS resolution errors: ENOTFOUND and getaddrinfo failures",
    short: "how hostname lookups fail and how to debug them",
    description:
      "Why getaddrinfo ENOTFOUND and EAI_AGAIN happen, the difference between a wrong name and a broken resolver, and how to isolate each case.",
    codes: /^(ENOTFOUND|EAI_AGAIN|ESERVFAIL)$/,
    message: /getaddrinfo|name resolution|name or service not known|could not resolve host|dns (lookup|resolution|query)/i,
  },
  {
    slug: "ssl-tls-certificates",
    title: "SSL/TLS and certificate errors",
    short: "how TLS handshakes and certificate validation fail",
    description:
      "Expired certificates, self-signed chains, hostname mismatches, and handshake failures: what each TLS error means and the safe way to fix it.",
    codes: /CERT|PKIX|SSL|TLS/,
    message: /certificat|\bssl\b|\btls\b|handshake/i,
  },
  {
    slug: "timeouts",
    title: "Timeouts: ETIMEDOUT, deadlines, and hung requests",
    short: "what actually expires when a request times out",
    description:
      "Connect timeouts vs read timeouts vs deadlines, why each one fires, and how to pick budgets that fail fast without flaking.",
    codes: /^(ETIMEDOUT|ESOCKETTIMEDOUT|ERR_SOCKET_CONNECTION_TIMEOUT)$/,
    message: /timed? ?out|timeout|deadline exceeded/i,
  },
  {
    slug: "http-status-errors",
    title: "HTTP status errors: handling 4xx and 5xx responses",
    short: "how to handle 4xx and 5xx responses properly",
    description:
      "Which HTTP status codes are your bug, which are the server's, which are retryable, and how libraries surface them as errors.",
    codes: /^ERR_BAD_(REQUEST|RESPONSE)$/,
    message: /status code \d|http \d{3}|bad gateway|service unavailable|too many requests|gateway timeout|internal server error/i,
  },
  {
    slug: "authentication-failures",
    title: "Authentication and authorization failures",
    short: "expired tokens, bad credentials, and missing scopes",
    description:
      "401 vs 403, expired and malformed tokens, clock skew, and missing scopes: how auth failures surface as errors and how to debug them.",
    codes: null,
    message: /unauthori[sz]ed|forbidden|authenticat|invalid (token|credentials|api ?key)|token (is )?(expired|invalid)|expired token|access denied/i,
  },
  {
    slug: "parsing-and-encoding",
    title: "Parsing and encoding errors: unexpected token, malformed input",
    short: "why parsers reject input and how to find the real culprit",
    description:
      "Unexpected token, unexpected end of input, invalid UTF-8, malformed JSON: what parsers are really complaining about and how to locate the bad byte.",
    codes: null,
    message: /unexpected token|unexpected end of (json|input)|invalid json|parse error|malformed|invalid utf|(failed|unable) to (parse|decode)|invalid character/i,
  },
];

export function guideBySlug(slug: string): GuideDef {
  const g = GUIDES.find((g) => g.slug === slug);
  if (!g) throw new Error(`unknown guide slug: ${slug}`);
  return g;
}

export function matchesGuide(g: GuideDef, code: string | null, msg: string): boolean {
  return (code != null && g.codes != null && g.codes.test(code)) || g.message.test(msg);
}

/** Guides linked from one error page. */
export function guidesFor(code: string | null, msg: string): GuideDef[] {
  return GUIDES.filter((g) => matchesGuide(g, code, msg));
}

/** All matching records for a guide's occurrences section, from the search index. */
export function guideErrors(g: GuideDef): IndexError[] {
  return getIndex().errors.filter((e) => matchesGuide(g, e.code, e.msg));
}

export function guideHref(slug: string): string {
  return `/guides/${slug}/`;
}
