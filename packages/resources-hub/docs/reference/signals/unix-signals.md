---
sidebar_position: 1
title: Unix Signals Reference
description: Complete reference for Unix/Linux signals with numbers and default actions
keywords: [signal, unix, linux, SIGTERM, SIGKILL, SIGSEGV]
---

# Unix Signals Reference

Complete reference for signals in Unix-like operating systems (Linux, macOS, BSD).

## Signal Table

| Signal | Number | Default Action | Can Catch? | Description |
|--------|--------|----------------|------------|-------------|
| SIGHUP | 1 | Terminate | Yes | Hangup / reload configuration |
| SIGINT | 2 | Terminate | Yes | Interrupt from keyboard (Ctrl+C) |
| SIGQUIT | 3 | Core dump | Yes | Quit from keyboard (Ctrl+\) |
| SIGILL | 4 | Core dump | Yes | Illegal instruction |
| SIGTRAP | 5 | Core dump | Yes | Trace/breakpoint trap |
| SIGABRT | 6 | Core dump | Yes | Abort signal from abort(3) |
| SIGBUS | 7 | Core dump | Yes | Bus error (bad memory access) |
| SIGFPE | 8 | Core dump | Yes | Floating-point exception |
| SIGKILL | 9 | Terminate | **No** | Kill signal (cannot be caught) |
| SIGUSR1 | 10 | Terminate | Yes | User-defined signal 1 |
| SIGSEGV | 11 | Core dump | Yes | Invalid memory reference |
| SIGUSR2 | 12 | Terminate | Yes | User-defined signal 2 |
| SIGPIPE | 13 | Terminate | Yes | Broken pipe |
| SIGALRM | 14 | Terminate | Yes | Timer signal from alarm(2) |
| SIGTERM | 15 | Terminate | Yes | Termination signal |
| SIGSTKFLT | 16 | Terminate | Yes | Stack fault on coprocessor |
| SIGCHLD | 17 | Ignore | Yes | Child stopped or terminated |
| SIGCONT | 18 | Continue | Yes | Continue if stopped |
| SIGSTOP | 19 | Stop | **No** | Stop process (cannot be caught) |
| SIGTSTP | 20 | Stop | Yes | Stop typed at terminal (Ctrl+Z) |
| SIGTTIN | 21 | Stop | Yes | Background read from tty |
| SIGTTOU | 22 | Stop | Yes | Background write to tty |
| SIGURG | 23 | Ignore | Yes | Urgent condition on socket |
| SIGXCPU | 24 | Core dump | Yes | CPU time limit exceeded |
| SIGXFSZ | 25 | Core dump | Yes | File size limit exceeded |
| SIGVTALRM | 26 | Terminate | Yes | Virtual alarm clock |
| SIGPROF | 27 | Terminate | Yes | Profiling timer expired |
| SIGWINCH | 28 | Ignore | Yes | Window resize signal |
| SIGIO | 29 | Terminate | Yes | I/O now possible |
| SIGPWR | 30 | Terminate | Yes | Power failure |
| SIGSYS | 31 | Core dump | Yes | Bad system call |

## Exit Codes from Signals

When a process is killed by a signal, its exit code is `128 + signal_number`:

```bash
$ ./program
Segmentation fault
$ echo $?
139   # 128 + 11 (SIGSEGV)
```

| Signal | Exit Code | Calculation |
|--------|-----------|-------------|
| SIGHUP | 129 | 128 + 1 |
| SIGINT | 130 | 128 + 2 |
| SIGQUIT | 131 | 128 + 3 |
| SIGKILL | 137 | 128 + 9 |
| SIGSEGV | 139 | 128 + 11 |
| SIGTERM | 143 | 128 + 15 |

## Sending Signals

### Using kill Command

```bash
# By signal name
kill -SIGTERM 12345
kill -TERM 12345

# By signal number
kill -15 12345

# Multiple processes
kill -TERM 12345 12346 12347

# Kill by name
pkill -TERM my_program
killall -TERM my_program
```

### Common Use Cases

```bash
# Graceful shutdown
kill -SIGTERM <pid>

# Force kill (last resort)
kill -SIGKILL <pid>
kill -9 <pid>

# Reload configuration (many daemons)
kill -SIGHUP <pid>

# Dump state for debugging
kill -SIGQUIT <pid>
kill -SIGUSR1 <pid>   # Application-specific
```

## Signal Handling in Code

### C

```c
#include <signal.h>

void handler(int signum) {
    printf("Caught signal %d\n", signum);
    // Cleanup
    exit(0);
}

int main() {
    signal(SIGTERM, handler);
    signal(SIGINT, handler);
    // SIGKILL cannot be caught

    while(1) {
        // Main loop
    }
}
```

### Go

```go
package main

import (
    "os"
    "os/signal"
    "syscall"
)

func main() {
    sigs := make(chan os.Signal, 1)
    signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)

    go func() {
        sig := <-sigs
        fmt.Println("Received:", sig)
        // Cleanup
        os.Exit(0)
    }()

    // Main logic
}
```

### Python

```python
import signal
import sys

def handler(signum, frame):
    print(f"Caught signal {signum}")
    sys.exit(0)

signal.signal(signal.SIGTERM, handler)
signal.signal(signal.SIGINT, handler)

# Main logic
```

### Node.js

```javascript
process.on('SIGTERM', () => {
    console.log('SIGTERM received');
    // Cleanup
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received');
    // Cleanup
    process.exit(0);
});
```

## Common Scenarios

### SIGSEGV (Segmentation Fault)

Your program accessed invalid memory.

```c
// Causes
int *ptr = NULL;
*ptr = 42;              // NULL dereference

char *str = "hello";
str[0] = 'H';           // Write to read-only memory

int arr[10];
arr[100] = 1;           // Out of bounds (if crosses page)
```

### SIGPIPE (Broken Pipe)

Writing to a pipe/socket where the reader closed their end.

```bash
# Example: reader exits before writer finishes
./producer | ./consumer  # Consumer exits early
# Producer gets SIGPIPE
```

**Handling in code**:
```c
// Ignore SIGPIPE, handle write() return value instead
signal(SIGPIPE, SIG_IGN);
```

### SIGTERM vs SIGKILL

```
SIGTERM: "Please shut down gracefully"
  ↓
Process cleans up, closes files, saves state
  ↓
Process exits

SIGKILL: "Die immediately"
  ↓
Kernel terminates process
  ↓
No cleanup, no signal handler
```

**When SIGKILL is sent automatically**:
- OOM killer (out of memory)
- Docker/Kubernetes after gracePeriodSeconds
- Systemd after TimeoutStopSec

## Debugging Signal Issues

### Check what killed a process

```bash
# Via exit code
$ echo $?
137  # SIGKILL (128 + 9)

# Via dmesg (OOM, SIGSEGV)
$ dmesg | grep -i "killed\|segfault"
Out of memory: Killed process 12345 (my_app)
my_app[12345]: segfault at 0 ip 00...

# Via strace
$ strace -f ./my_app 2>&1 | grep -i sig
--- SIGSEGV {si_signo=SIGSEGV, ...} ---
```

### Core Dumps

```bash
# Enable core dumps
ulimit -c unlimited

# Run program that crashes
./my_program

# Analyze with gdb
gdb ./my_program core
(gdb) bt   # Backtrace
```

## See Also

- [Unix Signals Concept](/concepts/os/signals) - Deep dive into signal behavior
- [Exit Codes](/concepts/os/exit-codes) - Understanding exit codes
- [Memory Management](/concepts/os/memory-management) - Why SIGSEGV happens
