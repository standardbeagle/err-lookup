---
sidebar_position: 1
title: Reading Stack Traces
description: How to extract useful information from crash reports and stack traces across languages
keywords: [stack trace, backtrace, crash, debug, error]
---

# Reading Stack Traces

A stack trace shows the chain of function calls that led to an error. Learning to read them is one of the most valuable debugging skills you can develop.

## What Is a Stack Trace?

When a program crashes or throws an exception, it captures the **call stack** - the list of functions that were active at that moment. Think of it as breadcrumbs showing how the program got to where it crashed.

```
Function D ← Crashed here
Called by Function C
Called by Function B
Called by Function A
Called by main()
```

## Universal Patterns

Regardless of language, stack traces share common elements:

1. **The crash location** - Usually at or near the top
2. **The call chain** - Functions that led to the crash
3. **File and line numbers** - Where in the source code
4. **Sometimes**: Variable values, memory addresses

**Key insight**: Read from the crash (top) upward to understand what the program was trying to do.

## Language-Specific Stack Traces

### JavaScript / Node.js

```
TypeError: Cannot read properties of undefined (reading 'name')
    at getUserName (/app/src/users.js:15:22)
    at processUser (/app/src/handlers.js:42:18)
    at /app/src/routes.js:23:5
    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)
    at next (/app/node_modules/express/lib/router/route.js:144:13)
```

**Breaking it down**:
- **Error type**: `TypeError` - tried to access property on undefined
- **Error message**: `Cannot read properties of undefined (reading 'name')`
- **Crash location**: `users.js:15:22` (line 15, column 22)
- **Call chain**: routes.js → handlers.js → users.js

**Tips for Node.js**:
- Look for your code (not `node_modules`)
- The `:22` column number helps find the exact expression
- Anonymous functions show as `at /app/...` without function name

### Python

```
Traceback (most recent call last):
  File "/app/main.py", line 10, in <module>
    process_data(data)
  File "/app/processor.py", line 45, in process_data
    result = transform(item)
  File "/app/transformer.py", line 23, in transform
    return item['key']
KeyError: 'key'
```

**Python is different**: Most recent call is at the **bottom**, not top.

**Breaking it down**:
- Read from bottom up for the crash, top down for the flow
- **Error**: `KeyError: 'key'` - dictionary missing the key 'key'
- **Crash location**: `transformer.py:23`
- **Flow**: main.py → processor.py → transformer.py

### Go

```
panic: runtime error: invalid memory address or nil pointer dereference
[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x4a2e8f]

goroutine 1 [running]:
main.(*User).GetName(0x0)
        /app/user.go:15 +0x1f
main.processUsers(0xc0000b6000, 0x3, 0x4)
        /app/main.go:42 +0x8f
main.main()
        /app/main.go:12 +0x45
```

**Breaking it down**:
- **Panic reason**: `nil pointer dereference`
- **Signal**: SIGSEGV at address 0x0 (nil)
- **Crash location**: `user.go:15` in `GetName` method
- **Receiver was nil**: `(*User).GetName(0x0)` - the `0x0` is nil

**Go-specific**:
- `+0x1f` is the byte offset in the function (for optimized builds)
- `goroutine 1 [running]` tells you which goroutine crashed
- Method receivers show as first argument: `(*User).GetName(0x0)`

### Rust

```
thread 'main' panicked at src/main.rs:10:5:
index out of bounds: the len is 3 but the index is 5
stack backtrace:
   0: rust_begin_unwind
   1: core::panicking::panic_fmt
   2: core::panicking::panic_bounds_check
   3: app::process_items
             at ./src/processor.rs:25:10
   4: app::main
             at ./src/main.rs:10:5
```

**Breaking it down**:
- **Panic location**: `src/main.rs:10:5`
- **Message**: `index out of bounds: len is 3 but index is 5`
- Stack shows both Rust runtime (`rust_begin_unwind`) and your code

**Rust-specific**:
- Enable full backtraces: `RUST_BACKTRACE=1`
- For more detail: `RUST_BACKTRACE=full`

### Java

```
Exception in thread "main" java.lang.NullPointerException: Cannot invoke "String.length()" because "str" is null
        at com.example.StringUtils.getLength(StringUtils.java:15)
        at com.example.Processor.process(Processor.java:42)
        at com.example.Main.main(Main.java:10)
Caused by: java.io.IOException: Connection reset
        at java.base/java.net.SocketInputStream.read(SocketInputStream.java:186)
        ... 5 more
```

**Breaking it down**:
- **Exception**: `NullPointerException` with helpful message (Java 14+)
- **Crash location**: `StringUtils.java:15`
- **Caused by**: Shows the original exception that was wrapped

**Java-specific**:
- `... 5 more` means 5 frames were identical to frames above
- Multiple "Caused by" sections show exception chaining

### C/C++

```
Program received signal SIGSEGV, Segmentation fault.
0x0000555555555169 in process_data (data=0x0) at main.c:25
25          return data->value;
(gdb) bt
#0  0x0000555555555169 in process_data (data=0x0) at main.c:25
#1  0x00005555555551a5 in main (argc=1, argv=0x7fffffffe0a8) at main.c:35
```

**Breaking it down**:
- **Signal**: SIGSEGV (segmentation fault)
- **Crash**: `main.c:25` - accessing `data->value` when `data` is null (0x0)
- **Stack**: `bt` (backtrace) command shows call chain

**C/C++ specific**:
- Need debug symbols (`-g` flag) for readable stack traces
- Use `addr2line` to convert addresses to lines for release builds

## Common Patterns to Recognize

### Null/Nil/Undefined Access
```
# JavaScript
Cannot read properties of undefined
# Python
AttributeError: 'NoneType' object has no attribute
# Go
nil pointer dereference
# Java
NullPointerException
```

### Index Out of Bounds
```
# JavaScript
RangeError: Invalid array length
# Python
IndexError: list index out of range
# Go
index out of range [5] with length 3
# Rust
index out of bounds: the len is 3 but the index is 5
```

### Type Mismatch
```
# JavaScript
TypeError: X is not a function
# Python
TypeError: unsupported operand type(s)
# Go
cannot convert X (type Y) to type Z
```

## Strategies for Debugging

### 1. Find YOUR Code First

Skip framework internals. Look for paths containing your project:
```
# Your code - focus here
at /app/src/users.js:15:22

# Framework code - usually not the bug
at Layer.handle (/app/node_modules/express/...)
```

### 2. Identify the Immediate Cause

The top of the stack (or bottom for Python) tells you WHAT happened:
```
TypeError: Cannot read properties of undefined (reading 'name')
```
Something was `undefined` when you tried to access `.name`.

### 3. Work Backwards to Find WHY

Look at the call chain to understand how you got there:
```
getUserName() ← name was undefined here
  ↑ called by
processUser() ← maybe user object was bad?
  ↑ called by
handleRequest() ← what was the input?
```

### 4. Check Variables at Each Level

If you have a debugger, set breakpoints at each level. If not, add logging:
```javascript
function processUser(user) {
    console.log('processUser received:', user);  // What did we get?
    return getUserName(user);
}
```

### 5. Reproduce Minimally

Once you understand the flow, create the smallest case that triggers the error:
```javascript
// Full stack trace pointed to getUserName with undefined user
getUserName(undefined);  // Does this reproduce it?
```

## See Also

- [Debugging Go](/guides/debugging/debugging-go) - Go-specific debugging
- [Debugging Node](/guides/debugging/debugging-node) - Node.js debugging
- [Debugging Python](/guides/debugging/debugging-python) - Python debugging
- [Unix Signals](/concepts/os/signals) - Understanding SIGSEGV and friends
