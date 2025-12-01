---
sidebar_position: 1
title: DNS Resolution
description: How domain names become IP addresses, common failures, and debugging DNS issues
keywords: [dns, domain, resolution, NXDOMAIN, SERVFAIL, timeout]
---

# DNS Resolution

DNS (Domain Name System) translates human-readable domain names like `api.example.com` into IP addresses like `93.184.216.34`. When DNS fails, your application can't find the server it needs to connect to.

## How DNS Resolution Works

When your code makes a request to `api.example.com`, here's what happens:

```
Your App → Local Resolver → Root DNS → TLD DNS → Authoritative DNS → IP Address
```

### Step by Step

1. **Local Cache Check**: Your OS checks if it already knows the IP (cached from a previous lookup)
2. **Resolver Query**: If not cached, your configured DNS resolver (like `8.8.8.8` or your ISP's DNS) is queried
3. **Recursive Resolution**: The resolver walks the DNS hierarchy:
   - Root servers (`.`) → "Ask the `.com` servers"
   - TLD servers (`.com`) → "Ask `example.com`'s nameservers"
   - Authoritative servers → "Here's the IP: `93.184.216.34`"
4. **Response Caching**: The result is cached based on the TTL (Time To Live)

## Common DNS Errors

### NXDOMAIN (Non-Existent Domain)

```
Error: getaddrinfo ENOTFOUND api.example.com
```

**What it means**: The domain doesn't exist in DNS.

**Common causes**:
- Typo in the domain name
- Domain registration expired
- DNS records not yet propagated after setup
- Subdomain doesn't exist (e.g., `api.` subdomain not configured)

**How to debug**:
```bash
# Check if the domain resolves at all
dig api.example.com

# Check specific record types
dig api.example.com A      # IPv4 address
dig api.example.com AAAA   # IPv6 address
dig api.example.com CNAME  # Alias record
```

### SERVFAIL (Server Failure)

**What it means**: The DNS server encountered an error processing your query.

**Common causes**:
- DNSSEC validation failed
- Authoritative nameserver is down or misconfigured
- Network issues between resolvers

**How to debug**:
```bash
# Try a different DNS resolver
dig @8.8.8.8 api.example.com
dig @1.1.1.1 api.example.com

# Check if DNSSEC is the problem
dig api.example.com +dnssec
```

### Timeout Errors

```
Error: DNS resolution timed out
Error: getaddrinfo EAI_AGAIN
```

**What it means**: The DNS query took too long.

**Common causes**:
- Network connectivity issues
- DNS server is overloaded or unreachable
- Firewall blocking UDP port 53
- All configured nameservers are down

**How to debug**:
```bash
# Test basic connectivity to DNS server
ping 8.8.8.8

# Test DNS over TCP (if UDP is blocked)
dig @8.8.8.8 api.example.com +tcp

# Check your system's DNS configuration
cat /etc/resolv.conf  # Linux/Mac
```

## DNS Caching Issues

DNS responses are cached at multiple levels:

| Level | Location | TTL Control |
|-------|----------|-------------|
| Application | Your code's HTTP client | Library-specific |
| OS | System resolver cache | `/etc/nsswitch.conf` |
| Local DNS | Router, corporate DNS | Server configuration |
| Resolver | 8.8.8.8, 1.1.1.1, etc. | Record TTL |

### Stale Cache Problems

When you update DNS records, the old IP might be cached:

```bash
# Flush OS DNS cache
# macOS
sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder

# Linux (systemd-resolved)
sudo systemd-resolve --flush-caches

# Windows
ipconfig /flushdns
```

### Low TTL Tradeoffs

- **Low TTL (60s)**: Fast failover, but more DNS queries (higher latency, more cost)
- **High TTL (86400s)**: Fewer queries, but slow propagation of changes

## DNS in Containers and Kubernetes

Container environments add complexity:

### Docker
```yaml
# docker-compose.yml
services:
  app:
    dns:
      - 8.8.8.8
      - 8.8.4.4
```

### Kubernetes
- Pods use CoreDNS for service discovery
- `service.namespace.svc.cluster.local` resolves to cluster IPs
- External DNS queries go through CoreDNS upstream

Common K8s DNS issues:
```bash
# Debug from inside a pod
kubectl exec -it pod-name -- nslookup kubernetes.default
kubectl exec -it pod-name -- cat /etc/resolv.conf
```

## Programming Language Specifics

### Node.js
```javascript
// Node.js caches DNS by default (since v16)
// To disable:
const dns = require('dns');
dns.setDefaultResultOrder('verbatim');

// Or use dns.resolve directly for fresh lookups
dns.resolve4('api.example.com', (err, addresses) => {
  console.log(addresses);
});
```

### Go
```go
// Go uses the system resolver by default
// For pure Go resolver (no CGO):
// Build with: CGO_ENABLED=0

// Custom resolver with timeout
resolver := &net.Resolver{
    PreferGo: true,
    Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
        d := net.Dialer{Timeout: 5 * time.Second}
        return d.DialContext(ctx, "udp", "8.8.8.8:53")
    },
}
```

### Python
```python
import socket

# Python uses getaddrinfo which respects /etc/hosts and nsswitch.conf
socket.getaddrinfo('api.example.com', 443)

# For async DNS, use aiodns
import aiodns
resolver = aiodns.DNSResolver()
result = await resolver.query('api.example.com', 'A')
```

## Related Error Messages

When you see these errors, DNS is likely involved:

| Error | Language | Meaning |
|-------|----------|---------|
| `ENOTFOUND` | Node.js | Domain doesn't exist |
| `EAI_AGAIN` | Node.js | Temporary DNS failure |
| `no such host` | Go | Domain doesn't exist |
| `i/o timeout` | Go | DNS query timed out |
| `socket.gaierror` | Python | getaddrinfo failed |
| `Name or service not known` | Linux | General DNS failure |

## See Also

- [TCP/IP Fundamentals](/concepts/networking/tcp-ip) - What happens after DNS resolves
- [Network Error Troubleshooting](/guides/troubleshooting/network-errors) - Systematic debugging approach
- [TLS/SSL](/concepts/networking/tls-ssl) - Certificate validation after connection
