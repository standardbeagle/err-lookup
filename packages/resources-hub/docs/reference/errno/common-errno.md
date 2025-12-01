---
sidebar_position: 1
title: Common errno Values
description: Standard C errno values and their meanings
keywords: [errno, error, c, system call]
---

# Common errno Values

| errno | Name | Description |
|-------|------|-------------|
| 1 | EPERM | Operation not permitted |
| 2 | ENOENT | No such file or directory |
| 3 | ESRCH | No such process |
| 4 | EINTR | Interrupted system call |
| 5 | EIO | I/O error |
| 9 | EBADF | Bad file descriptor |
| 11 | EAGAIN | Resource temporarily unavailable |
| 12 | ENOMEM | Out of memory |
| 13 | EACCES | Permission denied |
| 14 | EFAULT | Bad address |
| 17 | EEXIST | File exists |
| 22 | EINVAL | Invalid argument |
| 24 | EMFILE | Too many open files |
| 28 | ENOSPC | No space left on device |
| 32 | EPIPE | Broken pipe |
| 110 | ETIMEDOUT | Connection timed out |
| 111 | ECONNREFUSED | Connection refused |
| 113 | EHOSTUNREACH | No route to host |

## See Also

- [Unix Signals Reference](/reference/signals/unix-signals)
- [Exit Codes](/reference/exit-codes/unix)
