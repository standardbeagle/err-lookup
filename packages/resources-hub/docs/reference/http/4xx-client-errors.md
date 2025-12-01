---
sidebar_position: 1
title: 4xx Client Errors
description: Complete reference for HTTP 4xx client error status codes
keywords: [http, 400, 401, 403, 404, client error]
---

# HTTP 4xx Client Errors

Client error responses indicate that the request was invalid or cannot be processed.

## Quick Reference

| Code | Name | Retry? | Common Cause |
|------|------|--------|--------------|
| 400 | Bad Request | Fix request | Malformed syntax |
| 401 | Unauthorized | After auth | Missing/invalid credentials |
| 402 | Payment Required | After payment | Reserved for future use |
| 403 | Forbidden | Check permissions | Authenticated but not authorized |
| 404 | Not Found | Fix URL | Resource doesn't exist |
| 405 | Method Not Allowed | Change method | Wrong HTTP method |
| 406 | Not Acceptable | Fix Accept header | Content negotiation failed |
| 407 | Proxy Auth Required | Add proxy auth | Proxy needs authentication |
| 408 | Request Timeout | Retry | Server timed out waiting |
| 409 | Conflict | Resolve conflict | Resource state conflict |
| 410 | Gone | Don't retry | Resource permanently removed |
| 411 | Length Required | Add Content-Length | Missing Content-Length header |
| 412 | Precondition Failed | Check conditions | Conditional request failed |
| 413 | Payload Too Large | Reduce size | Request body too big |
| 414 | URI Too Long | Shorten URL | URL exceeds limit |
| 415 | Unsupported Media Type | Fix Content-Type | Wrong content type |
| 416 | Range Not Satisfiable | Fix Range header | Invalid byte range |
| 417 | Expectation Failed | Remove Expect header | Expect header not met |
| 418 | I'm a Teapot | Enjoy the joke | RFC 2324 (joke) |
| 421 | Misdirected Request | Try different connection | Wrong server for request |
| 422 | Unprocessable Entity | Fix request body | Validation failed |
| 423 | Locked | Wait or unlock | Resource is locked (WebDAV) |
| 424 | Failed Dependency | Fix dependent request | Dependent request failed (WebDAV) |
| 425 | Too Early | Wait | Request replayed too early |
| 426 | Upgrade Required | Upgrade protocol | TLS upgrade needed |
| 428 | Precondition Required | Add conditions | Conditional headers required |
| 429 | Too Many Requests | Wait, then retry | Rate limit exceeded |
| 431 | Request Header Fields Too Large | Reduce headers | Headers too big |
| 451 | Unavailable For Legal Reasons | N/A | Legal restriction |

## Detailed Explanations

### 400 Bad Request

The server cannot process the request due to client error.

**Common causes**:
- Invalid JSON syntax
- Missing required fields
- Invalid parameter format
- Malformed URL encoding

```bash
# Invalid JSON
curl -X POST https://api.example.com/users \
  -H "Content-Type: application/json" \
  -d '{"name": invalid}'  # Missing quotes

# Fix: Valid JSON
curl -X POST https://api.example.com/users \
  -H "Content-Type: application/json" \
  -d '{"name": "valid"}'
```

### 401 Unauthorized

Authentication required. Despite the name, this is about **authentication** (who are you?), not authorization (what can you do?).

**Common causes**:
- Missing Authorization header
- Expired token
- Invalid credentials
- Malformed auth header

```bash
# Missing auth
curl https://api.example.com/users
# Returns 401

# With auth
curl -H "Authorization: Bearer <token>" https://api.example.com/users
```

**Response headers to check**:
```
WWW-Authenticate: Bearer realm="api", error="invalid_token"
```

### 403 Forbidden

Authenticated but not allowed. You've proven who you are, but you don't have permission.

**Common causes**:
- Insufficient role/permissions
- IP not allowlisted
- Resource owned by different user
- Account suspended

**Difference from 401**: With 403, re-authenticating won't help.

### 404 Not Found

The resource doesn't exist.

**Common causes**:
- Typo in URL
- Resource deleted
- Wrong API version
- ID doesn't exist

```bash
# These might be different!
GET /api/v1/users/123  # v1 exists
GET /api/v2/users/123  # v2 might not exist yet
```

**Note**: Some APIs return 404 instead of 403 to hide resource existence.

### 405 Method Not Allowed

The HTTP method isn't supported for this resource.

```bash
# Endpoint only allows GET
curl -X DELETE https://api.example.com/users/123
# Returns 405
```

**Response header**:
```
Allow: GET, HEAD, OPTIONS
```

### 409 Conflict

The request conflicts with current state.

**Common causes**:
- Duplicate unique constraint (email already exists)
- Concurrent modification (optimistic locking failed)
- Invalid state transition

```bash
# Creating duplicate user
curl -X POST https://api.example.com/users \
  -d '{"email": "existing@example.com"}'
# Returns 409 with error: "Email already registered"
```

### 422 Unprocessable Entity

Request is syntactically valid but semantically wrong.

**Common causes**:
- Validation failures
- Business rule violations
- Invalid field values

```json
// Common response format
{
  "errors": {
    "email": ["must be a valid email"],
    "age": ["must be at least 18"]
  }
}
```

### 429 Too Many Requests

Rate limit exceeded.

**Response headers**:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1625097600
Retry-After: 60
```

**Handling strategy**:
```javascript
async function fetchWithBackoff(url, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(url);
    if (response.status !== 429) return response;

    const retryAfter = response.headers.get('Retry-After') || Math.pow(2, i);
    await sleep(retryAfter * 1000);
  }
  throw new Error('Rate limit exceeded');
}
```

## See Also

- [HTTP Status Codes Overview](/concepts/networking/http-status-codes)
- [5xx Server Errors](/reference/http/5xx-server-errors)
