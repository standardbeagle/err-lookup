---
sidebar_position: 2
title: Debugging Go Programs
description: Goroutine dumps, panic analysis, race detection, and profiling Go applications
keywords: [go, golang, debug, panic, goroutine, race, pprof]
---

# Debugging Go Programs

Go's error handling is famously explicit, but when things go wrong, you need to know how to investigate. This guide covers panics, goroutine dumps, race conditions, and profiling.

## Understanding Go Panics

A panic is Go's mechanism for unrecoverable errors. When a panic isn't recovered, it prints a stack trace and terminates.

### Anatomy of a Panic

```
panic: runtime error: index out of range [5] with length 3

goroutine 1 [running]:
main.processItems(0xc0000b6000, 0x3, 0x4)
        /home/user/app/main.go:25 +0x8f
main.main()
        /home/user/app/main.go:12 +0x45
exit status 2
```

**Breaking it down**:
1. **Panic message**: `runtime error: index out of range [5] with length 3`
   - Tried to access index 5 of a slice with 3 elements

2. **Goroutine state**: `goroutine 1 [running]`
   - Which goroutine panicked and what it was doing

3. **Stack trace**: Functions from innermost (crash site) to outermost
   - `main.go:25` - The exact line that panicked
   - `+0x8f` - Offset in the function (useful for optimized builds)

### Common Panic Causes

**1. Nil pointer dereference**
```go
var user *User
fmt.Println(user.Name)  // panic: runtime error: invalid memory address
```

**2. Index out of range**
```go
items := []int{1, 2, 3}
fmt.Println(items[5])  // panic: index out of range [5] with length 3
```

**3. Closing a closed channel**
```go
ch := make(chan int)
close(ch)
close(ch)  // panic: close of closed channel
```

**4. Send on closed channel**
```go
ch := make(chan int)
close(ch)
ch <- 1  // panic: send on closed channel
```

**5. Invalid type assertion**
```go
var i interface{} = "hello"
n := i.(int)  // panic: interface conversion: string is not int
```

### Recovering from Panics

```go
func safeOperation() (err error) {
    defer func() {
        if r := recover(); r != nil {
            err = fmt.Errorf("recovered from panic: %v", r)
            // Log stack trace for debugging
            debug.PrintStack()
        }
    }()

    riskyOperation()
    return nil
}
```

## Goroutine Dumps

When your program hangs or behaves strangely, dump all goroutines to see what they're doing.

### Getting a Goroutine Dump

**Method 1: SIGQUIT (Ctrl+\)**
```bash
# In terminal running the program
# Press Ctrl+\

# Or send signal
kill -SIGQUIT <pid>
```

**Method 2: HTTP endpoint (for servers)**
```go
import _ "net/http/pprof"

func main() {
    go func() {
        http.ListenAndServe("localhost:6060", nil)
    }()
    // ... rest of your app
}
```
```bash
# Get goroutine dump
curl http://localhost:6060/debug/pprof/goroutine?debug=2
```

**Method 3: Programmatic**
```go
import "runtime/pprof"

func dumpGoroutines() {
    pprof.Lookup("goroutine").WriteTo(os.Stdout, 2)
}
```

### Reading Goroutine Dumps

```
goroutine 1 [select, 5 minutes]:
main.worker()
        /home/user/app/worker.go:42 +0x1f5
created by main.main
        /home/user/app/main.go:15 +0x85

goroutine 18 [chan receive]:
main.consumer(0xc0000b8000)
        /home/user/app/consumer.go:23 +0x6e
created by main.main
        /home/user/app/main.go:20 +0xc5

goroutine 24 [IO wait]:
internal/poll.runtime_pollWait(...)
net/http.(*persistConn).readLoop(0xc0001a6000)
        ...
```

**Key states to look for**:
- `[running]` - Currently executing
- `[select]` - Waiting in select statement
- `[chan receive]` - Blocked on channel read
- `[chan send]` - Blocked on channel write (possible deadlock!)
- `[semacquire]` - Waiting for mutex/semaphore
- `[IO wait]` - Waiting for I/O
- `[sleep]` - In time.Sleep
- `[GC assist wait]` - Helping GC

### Detecting Deadlocks

Go's runtime detects simple deadlocks:

```go
func main() {
    ch := make(chan int)
    <-ch  // Deadlock: nobody will ever send
}
// fatal error: all goroutines are asleep - deadlock!
```

For complex deadlocks, look for goroutines stuck in `[chan send]` or `[semacquire]`:

```
goroutine 5 [chan send]:      # Waiting to send
goroutine 6 [chan send]:      # Both goroutines waiting to send
                              # Nobody is receiving -> deadlock
```

## Race Detection

Data races are concurrent read/write (or write/write) to the same variable without synchronization.

### Enabling Race Detector

```bash
# Build with race detector
go build -race ./...

# Test with race detector
go test -race ./...

# Run with race detector
go run -race main.go
```

### Understanding Race Reports

```
WARNING: DATA RACE
Write at 0x00c0000a4010 by goroutine 7:
  main.increment()
      /home/user/app/counter.go:15 +0x4e

Previous read at 0x00c0000a4010 by goroutine 6:
  main.getCount()
      /home/user/app/counter.go:20 +0x3e

Goroutine 7 (running) created at:
  main.main()
      /home/user/app/main.go:10 +0x8f

Goroutine 6 (running) created at:
  main.main()
      /home/user/app/main.go:9 +0x6f
```

**Reading the report**:
1. Location of the write that caused the race
2. Location of the conflicting read
3. Where each goroutine was created

### Fixing Races

**Option 1: Mutex**
```go
type Counter struct {
    mu    sync.Mutex
    count int
}

func (c *Counter) Increment() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.count++
}
```

**Option 2: Atomic operations**
```go
type Counter struct {
    count int64
}

func (c *Counter) Increment() {
    atomic.AddInt64(&c.count, 1)
}
```

**Option 3: Channels**
```go
type Counter struct {
    inc chan struct{}
    get chan int
}

func (c *Counter) run() {
    count := 0
    for {
        select {
        case <-c.inc:
            count++
        case c.get <- count:
        }
    }
}
```

## Using Delve Debugger

[Delve](https://github.com/go-delve/delve) is the Go debugger.

```bash
# Install
go install github.com/go-delve/delve/cmd/dlv@latest

# Debug a program
dlv debug main.go

# Attach to running process
dlv attach <pid>

# Debug a test
dlv test ./...
```

### Common Commands

```
(dlv) break main.go:25        # Set breakpoint
(dlv) breakpoint              # List breakpoints
(dlv) continue                # Run until breakpoint
(dlv) next                    # Step over
(dlv) step                    # Step into
(dlv) stepout                 # Step out of function
(dlv) print variable          # Print variable value
(dlv) locals                  # Show local variables
(dlv) stack                   # Show stack trace
(dlv) goroutines              # List all goroutines
(dlv) goroutine 5             # Switch to goroutine 5
```

## Profiling with pprof

### CPU Profiling

```go
import "runtime/pprof"

func main() {
    f, _ := os.Create("cpu.prof")
    pprof.StartCPUProfile(f)
    defer pprof.StopCPUProfile()

    // ... your code
}
```

```bash
# Analyze
go tool pprof cpu.prof

# Interactive commands
(pprof) top10          # Top 10 functions by CPU
(pprof) list funcName  # Source code view
(pprof) web            # Generate graph (needs graphviz)
```

### Memory Profiling

```go
import "runtime/pprof"

func main() {
    // ... your code

    f, _ := os.Create("mem.prof")
    pprof.WriteHeapProfile(f)
    f.Close()
}
```

```bash
go tool pprof mem.prof

(pprof) top10 --inuse_space    # Current allocations
(pprof) top10 --alloc_space    # Total allocations
```

### HTTP Profiling (Production)

```go
import _ "net/http/pprof"

func main() {
    go func() {
        http.ListenAndServe("localhost:6060", nil)
    }()
}
```

```bash
# CPU profile (30 seconds)
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# Heap profile
go tool pprof http://localhost:6060/debug/pprof/heap

# Goroutine profile
go tool pprof http://localhost:6060/debug/pprof/goroutine
```

## Common Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| `nil pointer dereference` | Accessing nil pointer | Check for nil before use |
| `index out of range` | Array/slice bounds | Validate indices |
| `deadlock` | All goroutines blocked | Review channel/mutex usage |
| `send on closed channel` | Sending after close | Coordinate closure |
| `concurrent map writes` | Unsynchronized map access | Use sync.Map or mutex |

## See Also

- [Reading Stack Traces](/guides/debugging/reading-stack-traces) - General stack trace analysis
- [Concurrency](/concepts/programming/concurrency) - Understanding concurrent programming
- [Memory Management](/concepts/os/memory-management) - Why memory errors happen
