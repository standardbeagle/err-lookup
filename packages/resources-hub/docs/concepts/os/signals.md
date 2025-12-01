---
sidebar_position: 1
title: Unix Signals
description: Understanding SIGSEGV, SIGKILL, SIGTERM and other signals that crash or stop your programs
keywords: [signal, SIGSEGV, SIGKILL, SIGTERM, segfault, crash]
---

# Unix Signals

Signals are software interrupts sent to a process to notify it of events. When your program crashes with "Segmentation fault" or gets killed by the OOM killer, signals are involved.

## What Are Signals?

Signals are a form of inter-process communication in Unix-like systems. They can:

- Notify a process of an event (keyboard interrupt, child terminated)
- Request a process to terminate (politely or forcefully)
- Indicate a fatal error (invalid memory access, divide by zero)

```bash
# Send a signal manually
kill -SIGTERM 12345    # Request graceful shutdown
kill -SIGKILL 12345    # Force immediate termination
kill -SIGUSR1 12345    # Custom signal for application use
```

## Signal Categories

### Termination Signals

| Signal | Number | Default Action | Can Catch? | Use Case |
|--------|--------|----------------|------------|----------|
| SIGTERM | 15 | Terminate | Yes | Polite shutdown request |
| SIGINT | 2 | Terminate | Yes | Ctrl+C from terminal |
| SIGQUIT | 3 | Core dump | Yes | Ctrl+\ - quit with dump |
| SIGKILL | 9 | Terminate | **No** | Force kill (last resort) |
| SIGHUP | 1 | Terminate | Yes | Terminal closed / reload config |

### Error Signals

| Signal | Number | Cause | Core Dump? |
|--------|--------|-------|------------|
| SIGSEGV | 11 | Invalid memory access | Yes |
| SIGBUS | 7 | Bus error (alignment) | Yes |
| SIGFPE | 8 | Floating point exception | Yes |
| SIGILL | 4 | Illegal instruction | Yes |
| SIGABRT | 6 | abort() called | Yes |

### Job Control Signals

| Signal | Number | Default Action | Use Case |
|--------|--------|----------------|----------|
| SIGSTOP | 19 | Stop process | Pause (can't catch) |
| SIGCONT | 18 | Continue | Resume stopped process |
| SIGTSTP | 20 | Stop process | Ctrl+Z from terminal |

## SIGSEGV (Segmentation Fault)

The most dreaded signal. Your program tried to access memory it shouldn't.

### Common Causes

**1. Null pointer dereference**
```c
char *ptr = NULL;
*ptr = 'x';  // SIGSEGV
```

**2. Use after free**
```c
char *ptr = malloc(100);
free(ptr);
*ptr = 'x';  // SIGSEGV (usually)
```

**3. Buffer overflow**
```c
char buffer[10];
buffer[100] = 'x';  // SIGSEGV (if page boundary crossed)
```

**4. Stack overflow**
```c
void recursive() {
    char buffer[1024];
    recursive();  // Eventually SIGSEGV
}
```

**5. Writing to read-only memory**
```c
char *str = "hello";  // String literal in read-only section
str[0] = 'H';         // SIGSEGV
```

### Debugging SIGSEGV

**Get a core dump**:
```bash
# Enable core dumps
ulimit -c unlimited

# Run program
./my_program

# Core dump created: core or core.12345
```

**Analyze with GDB**:
```bash
gdb ./my_program core
(gdb) bt          # Backtrace - where did it crash?
(gdb) frame 0     # Look at crash frame
(gdb) info locals # Local variables
(gdb) info registers
```

**Use AddressSanitizer** (much better for development):
```bash
# Compile with ASan
gcc -fsanitize=address -g my_program.c -o my_program

# Run - get detailed error report
./my_program
```

### In Managed Languages

**Go**: Usually means CGO code or unsafe package misuse
```go
// This can SIGSEGV
var ptr *int
*ptr = 42  // panic: runtime error: invalid memory address
```

**Rust**: Only possible in `unsafe` blocks or FFI
```rust
unsafe {
    let ptr: *mut i32 = std::ptr::null_mut();
    *ptr = 42;  // SIGSEGV
}
```

**Node.js**: Native addon crashed or V8 bug
```
FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed
# Usually followed by SIGSEGV in native code
```

## SIGKILL (Kill)

The uncatchable termination signal. Process dies immediately.

### Who Sends SIGKILL?

**1. OOM Killer** (Out of Memory)
```bash
# Check if OOM killed your process
dmesg | grep -i "killed process"

# In the output:
# Out of memory: Killed process 12345 (my_app)
```

**2. Manual kill**
```bash
kill -9 12345      # Last resort
pkill -9 my_app    # Kill by name
```

**3. Kubernetes** (pod eviction)
```yaml
# Pod exceeded memory limit
# terminationGracePeriodSeconds expired
```

**4. Systemd** (service timeout)
```ini
[Service]
TimeoutStopSec=30    # After this, SIGKILL
```

### Why SIGKILL Instead of SIGTERM?

Process didn't respond to SIGTERM. Common reasons:
- Stuck in uninterruptible I/O (D state)
- Deadlocked
- Infinite loop without signal handling
- Bug in signal handler

## SIGTERM vs SIGINT vs SIGKILL

| Signal | Source | Catchable | Graceful | When to Use |
|--------|--------|-----------|----------|-------------|
| SIGINT | Ctrl+C | Yes | Yes | Interactive termination |
| SIGTERM | kill, systemd | Yes | Yes | Standard shutdown |
| SIGKILL | kill -9, OOM | **No** | **No** | Process won't die |

### Proper Signal Handling

**Go**:
```go
func main() {
    // Create channel for signals
    sigs := make(chan os.Signal, 1)
    signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)

    go func() {
        sig := <-sigs
        fmt.Println("Received:", sig)
        // Cleanup: close connections, flush buffers
        cleanup()
        os.Exit(0)
    }()

    // Main application logic
    runServer()
}
```

**Node.js**:
```javascript
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully');
    await server.close();
    await db.disconnect();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT received (Ctrl+C)');
    await server.close();
    process.exit(0);
});
```

**Python**:
```python
import signal
import sys

def signal_handler(sig, frame):
    print(f'Received {signal.Signals(sig).name}')
    # Cleanup
    sys.exit(0)

signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)
```

## Signal Exit Codes

When a process is killed by a signal, its exit code is `128 + signal_number`:

| Signal | Number | Exit Code |
|--------|--------|-----------|
| SIGHUP | 1 | 129 |
| SIGINT | 2 | 130 |
| SIGKILL | 9 | 137 |
| SIGSEGV | 11 | 139 |
| SIGTERM | 15 | 143 |

```bash
./my_program
echo $?  # Exit code

# 139 = 128 + 11 = SIGSEGV
# 137 = 128 + 9 = SIGKILL
```

## Debugging Signal Issues

### Find what signal killed your process

```bash
# Using wait status
./my_program
if [ $? -gt 128 ]; then
    echo "Killed by signal $((${?} - 128))"
fi

# Using strace
strace -f ./my_program 2>&1 | grep -E "SIG|killed"

# Check dmesg for kernel-sent signals
sudo dmesg | tail -50
```

### Common Container Issues

**Exit code 137 in Docker/Kubernetes**:
```yaml
# Usually memory limit hit
resources:
  limits:
    memory: "256Mi"  # Increase if needed
```

**Exit code 143 (SIGTERM)**:
- Container gracefully shut down
- Deployment rolling update
- Pod eviction

## See Also

- [Exit Codes](/concepts/os/exit-codes) - Interpreting process exit codes
- [Memory Management](/concepts/os/memory-management) - Why SIGSEGV happens
- [Debugging Go](/guides/debugging/debugging-go) - Stack traces and signal handling in Go
- [Unix Signals Reference](/reference/signals/unix-signals) - Complete signal list
