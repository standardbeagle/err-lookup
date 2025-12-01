---
sidebar_position: 2
title: HTTP Status Codes
description: Complete guide to HTTP response codes, what they mean, and how to handle them
keywords: [http, status code, 404, 500, 503, rest api]
---

# HTTP Status Codes

HTTP status codes are three-digit numbers that servers return to indicate the result of a request. Understanding them is crucial for debugging API integrations and web applications.

## Status Code Categories

| Range | Category | Meaning |
|-------|----------|---------|
| 1xx | Informational | Request received, continuing process |
| 2xx | Success | Request successfully received and processed |
| 3xx | Redirection | Further action needed to complete request |
| 4xx | Client Error | Request contains bad syntax or cannot be fulfilled |
| 5xx | Server Error | Server failed to fulfill valid request |

## Client Errors (4xx)

These indicate something wrong with the request itself.

### 400 Bad Request

**What it means**: The server cannot process the request due to malformed syntax.

**Common causes**:
- Invalid JSON in request body
- Missing required fields
- Wrong Content-Type header
- Malformed URL parameters

```javascript
// Example: Sending invalid JSON
fetch('/api/users', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{ invalid json }'  // Missing quotes around key
});
```

**How to fix**: Validate your request payload before sending. Use JSON.stringify() for objects.

### 401 Unauthorized

**What it means**: Authentication is required and has failed or not been provided.

**Common causes**:
- Missing Authorization header
- Expired token
- Invalid credentials
- Token not properly formatted

```bash
# Correct format
curl -H "Authorization: Bearer eyJhbGc..." https://api.example.com/users

# Wrong: Missing "Bearer" prefix
curl -H "Authorization: eyJhbGc..." https://api.example.com/users
```

**How to fix**: Check token expiration, refresh tokens, verify the auth header format.

### 403 Forbidden

**What it means**: Server understood the request but refuses to authorize it.

**Key difference from 401**: You're authenticated, but don't have permission.

**Common causes**:
- Insufficient permissions/roles
- IP not allowlisted
- Resource belongs to different user
- Rate limiting (some APIs use 403)

**How to fix**: Check user permissions, API key scopes, or contact the API provider.

### 404 Not Found

**What it means**: The requested resource doesn't exist.

**Common causes**:
- Typo in URL path
- Resource was deleted
- Wrong API version (`/v1/` vs `/v2/`)
- ID doesn't exist in database

```bash
# These are different endpoints!
GET /api/users/123    # User with ID 123
GET /api/user/123     # Typo: "user" vs "users"
```

**How to fix**: Verify the URL, check API documentation, confirm the resource exists.

### 405 Method Not Allowed

**What it means**: The HTTP method isn't supported for this endpoint.

```bash
# Endpoint only accepts GET
POST /api/users/123   # Returns 405
GET /api/users/123    # Works
```

**How to fix**: Check the API documentation for allowed methods.

### 409 Conflict

**What it means**: Request conflicts with current state of the resource.

**Common causes**:
- Duplicate entry (unique constraint violation)
- Concurrent modification conflict
- Resource already exists

```javascript
// Trying to create a user that already exists
POST /api/users
{ "email": "already-exists@example.com" }
// Returns 409
```

**How to fix**: Check if resource exists before creating, handle idempotency.

### 422 Unprocessable Entity

**What it means**: Request is syntactically correct but semantically invalid.

**Common causes**:
- Validation errors (email format, password requirements)
- Business rule violations
- Invalid field values

```json
// Response body often includes details
{
  "errors": {
    "email": ["must be a valid email address"],
    "password": ["must be at least 8 characters"]
  }
}
```

**How to fix**: Read the error response body for specific validation failures.

### 429 Too Many Requests

**What it means**: Rate limit exceeded.

**Headers to check**:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1625097600
Retry-After: 60
```

**How to fix**: Implement exponential backoff, respect Retry-After header.

```javascript
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(url, options);
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After') || 60;
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      continue;
    }
    return response;
  }
  throw new Error('Max retries exceeded');
}
```

## Server Errors (5xx)

These indicate the server failed to process a valid request.

### 500 Internal Server Error

**What it means**: Generic server-side error.

**Common causes** (on the server):
- Unhandled exception
- Database connection failure
- Null pointer / undefined access
- Configuration error

**As a client**: Not much you can do except retry and report to the API provider.

### 502 Bad Gateway

**What it means**: Server acting as gateway received invalid response from upstream.

**Common in**:
- Load balancer → app server communication
- Reverse proxy (nginx) → backend
- API gateway → microservice

**Common causes**:
- Upstream server crashed
- Upstream server returned malformed response
- Timeout waiting for upstream

### 503 Service Unavailable

**What it means**: Server temporarily unable to handle requests.

**Common causes**:
- Server overloaded
- Maintenance mode
- Dependency service down
- Container restarting

**Headers to check**:
```
Retry-After: 120
```

**How to handle**: Implement circuit breaker pattern, retry with backoff.

### 504 Gateway Timeout

**What it means**: Gateway didn't receive timely response from upstream.

**Common causes**:
- Slow database queries
- Long-running computation
- Network issues between services
- Upstream service is down

**Typical timeout chain**:
```
Client (30s) → Load Balancer (60s) → App Server (30s) → Database (10s)
```

## Handling Status Codes in Code

### JavaScript/TypeScript
```typescript
async function apiCall(url: string) {
  const response = await fetch(url);

  if (response.ok) {  // 200-299
    return response.json();
  }

  switch (response.status) {
    case 401:
      throw new AuthError('Please log in again');
    case 403:
      throw new PermissionError('Access denied');
    case 404:
      throw new NotFoundError('Resource not found');
    case 429:
      const retryAfter = response.headers.get('Retry-After');
      throw new RateLimitError(`Rate limited. Retry after ${retryAfter}s`);
    case 500:
    case 502:
    case 503:
    case 504:
      throw new ServerError('Server error, please try again');
    default:
      throw new Error(`Unexpected status: ${response.status}`);
  }
}
```

### Go
```go
resp, err := http.Get(url)
if err != nil {
    return err
}
defer resp.Body.Close()

switch resp.StatusCode {
case http.StatusOK:
    // Handle success
case http.StatusUnauthorized:
    return ErrUnauthorized
case http.StatusForbidden:
    return ErrForbidden
case http.StatusNotFound:
    return ErrNotFound
case http.StatusTooManyRequests:
    retryAfter := resp.Header.Get("Retry-After")
    return &RateLimitError{RetryAfter: retryAfter}
default:
    if resp.StatusCode >= 500 {
        return ErrServerError
    }
    return fmt.Errorf("unexpected status: %d", resp.StatusCode)
}
```

## See Also

- [4xx Client Errors Reference](/reference/http/4xx-client-errors) - Complete list with examples
- [5xx Server Errors Reference](/reference/http/5xx-server-errors) - Complete list with examples
- [Network Error Troubleshooting](/guides/troubleshooting/network-errors) - When you can't even get a status code
- [TLS/SSL](/concepts/networking/tls-ssl) - Errors before HTTP even starts
