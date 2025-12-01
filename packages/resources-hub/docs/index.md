---
slug: /
sidebar_position: 1
title: ErrLookup Resources
---

# ErrLookup Resources

**The missing manual for error messages.**

When you encounter an error, you need more than just "what" - you need "why" and "how to fix it". This resource center provides deep background on the concepts, protocols, and systems that generate the errors you see every day.

## What You'll Find Here

### [Concepts](/concepts)
Deep dives into the fundamentals: how DNS resolution works, what HTTP status codes really mean, why your process received SIGSEGV, and more.

### [Guides](/guides)
Practical debugging guides: how to read stack traces, language-specific debugging techniques, and systematic approaches to common error categories.

### [Reference](/reference)
Quick lookup tables: HTTP status codes, Unix signals, exit codes, and errno values - all in one place.

---

## Popular Topics

| Topic | What It Covers |
|-------|----------------|
| [DNS Resolution](/concepts/networking/dns) | How domain names become IP addresses, common failures, and debugging DNS issues |
| [HTTP Status Codes](/concepts/networking/http-status-codes) | The complete guide to 4xx and 5xx errors |
| [Unix Signals](/concepts/os/signals) | SIGSEGV, SIGKILL, SIGTERM - what they mean and why you receive them |
| [Reading Stack Traces](/guides/debugging/reading-stack-traces) | How to extract useful information from crash reports |
| [Debugging Go](/guides/debugging/debugging-go) | Goroutine dumps, race detection, and panic analysis |

---

## How This Connects to Error Pages

When you're viewing an error on a project-specific ErrLookup site, you'll see links to relevant resources here. For example:

- A `ECONNREFUSED` error links to [TCP/IP concepts](/concepts/networking/tcp-ip)
- A `SIGSEGV` crash links to [Unix Signals](/concepts/os/signals) and [Memory Safety](/concepts/programming/memory-safety)
- An HTTP 503 links to [HTTP Status Codes](/concepts/networking/http-status-codes)

This gives you the background knowledge to not just fix the immediate error, but understand the underlying system.

---

## Contributing

Found something wrong or want to add a new topic? Resources are open source - submit a PR or open an issue on [GitHub](https://github.com/errlookup/resources).
