---
sidebar_position: 2
title: 5xx Server Errors
description: Complete reference for HTTP 5xx server error status codes
keywords: [http, 500, 502, 503, 504, server error]
---

# HTTP 5xx Server Errors

Server error responses indicate that the server failed to fulfill a valid request.

## Quick Reference

| Code | Name | Retry? | Common Cause |
|------|------|--------|--------------|
| 500 | Internal Server Error | Maybe | Unhandled exception |
| 501 | Not Implemented | No | Feature not built |
| 502 | Bad Gateway | Retry | Upstream server error |
| 503 | Service Unavailable | Retry (backoff) | Server overloaded/maintenance |
| 504 | Gateway Timeout | Retry | Upstream timeout |
| 505 | HTTP Version Not Supported | Change version | Unsupported HTTP version |
| 506 | Variant Also Negotiates | No | Server misconfiguration |
| 507 | Insufficient Storage | Wait | No space left (WebDAV) |
| 508 | Loop Detected | No | Infinite redirect loop (WebDAV) |
| 510 | Not Extended | No | Extension required |
| 511 | Network Auth Required | Authenticate | Captive portal |

## Detailed Explanations

### 500 Internal Server Error

Generic server-side error. Something went wrong, but the server isn't telling you what.

**What's happening on the server**:
- Unhandled exception
- Null pointer / undefined access
- Database connection failure
- Configuration error
- Out of memory

**As a client**:
- Check if the request is correct
- Retry with exponential backoff
- Report to API provider if persistent

**Server-side debugging**:
```bash
# Check application logs
tail -f /var/log/app/error.log

# Check system resources
df -h        # Disk space
free -m      # Memory
```

### 502 Bad Gateway

The server acting as a gateway received an invalid response from upstream.

**Architecture**:
```
Client → Load Balancer (502) → App Server (crashed)
Client → nginx (502) → Node.js app (error)
Client → API Gateway (502) → Microservice (bad response)
```

**Common causes**:
- Upstream server crashed
- Upstream returned malformed response
- Connection refused by upstream
- Upstream closed connection unexpectedly

**Debugging**:
```bash
# Check if upstream is running
curl -v http://localhost:3000/health

# Check nginx upstream logs
tail -f /var/log/nginx/error.log
# "upstream prematurely closed connection"
```

### 503 Service Unavailable

Server temporarily unable to handle requests.

**Common causes**:
- Server overloaded
- Maintenance mode
- Dependency (database, cache) is down
- Too many connections
- Deployment in progress

**Response headers**:
```
Retry-After: 120
# or
Retry-After: Wed, 21 Oct 2023 07:28:00 GMT
```

**Kubernetes context**:
```yaml
# Pod not ready yet
readinessProbe:
  httpGet:
    path: /health
    port: 8080
# Returns 503 until ready
```

**Handling**:
```javascript
// Implement circuit breaker
const circuitBreaker = new CircuitBreaker(fetchData, {
  timeout: 3000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000
});

// Returns fallback during outage
circuitBreaker.fallback(() => cachedData);
```

### 504 Gateway Timeout

The gateway didn't receive a timely response from upstream.

**Typical timeout chain**:
```
Client (30s) → CDN (60s) → Load Balancer (30s) → App (10s) → Database
```

**Common causes**:
- Slow database queries
- Long-running computation
- Network issues between services
- Upstream server overwhelmed

**Nginx configuration**:
```nginx
# Increase timeouts if needed
proxy_connect_timeout 60s;
proxy_send_timeout 60s;
proxy_read_timeout 60s;
```

**Debugging**:
```bash
# Check slow queries
# PostgreSQL
SELECT * FROM pg_stat_activity WHERE state = 'active';

# MySQL
SHOW FULL PROCESSLIST;
```

### 502 vs 503 vs 504

| Code | Problem | Upstream Status |
|------|---------|-----------------|
| 502 | Bad response | Responded incorrectly |
| 503 | Unavailable | Refusing connections |
| 504 | Timeout | Didn't respond in time |

## Retry Strategies

### Exponential Backoff

```javascript
async function fetchWithBackoff(url, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url);

      if (response.status >= 500 && response.status < 600) {
        // Server error - worth retrying
        throw new Error(`Server error: ${response.status}`);
      }

      return response;
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;

      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      const jitter = Math.random() * 1000;
      await sleep(delay + jitter);
    }
  }
}
```

### Circuit Breaker Pattern

```javascript
class CircuitBreaker {
  constructor(fn, options = {}) {
    this.fn = fn;
    this.failures = 0;
    this.threshold = options.threshold || 5;
    this.resetTimeout = options.resetTimeout || 30000;
    this.state = 'CLOSED';  // CLOSED, OPEN, HALF_OPEN
  }

  async execute(...args) {
    if (this.state === 'OPEN') {
      throw new Error('Circuit is OPEN');
    }

    try {
      const result = await this.fn(...args);
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  onFailure() {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.state = 'OPEN';
      setTimeout(() => {
        this.state = 'HALF_OPEN';
      }, this.resetTimeout);
    }
  }
}
```

## Monitoring 5xx Errors

### What to Track

- **Error rate**: 5xx / total requests
- **Error budget**: Acceptable error rate (e.g., 99.9% = 0.1% errors allowed)
- **Mean Time To Recovery (MTTR)**: How long until errors stop

### Alert Thresholds

```yaml
# Example Prometheus alerting rules
groups:
  - name: http_errors
    rules:
      - alert: HighErrorRate
        expr: sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.01
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High 5xx error rate (> 1%)"
```

## See Also

- [HTTP Status Codes Overview](/concepts/networking/http-status-codes)
- [4xx Client Errors](/reference/http/4xx-client-errors)
- [Network Error Troubleshooting](/guides/troubleshooting/network-errors)
