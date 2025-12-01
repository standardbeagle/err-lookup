import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  conceptsSidebar: [
    {
      type: "category",
      label: "Networking",
      items: [
        "concepts/networking/dns",
        "concepts/networking/http-status-codes",
        "concepts/networking/tcp-ip",
        "concepts/networking/tls-ssl",
        "concepts/networking/websockets",
      ],
    },
    {
      type: "category",
      label: "Operating Systems",
      items: [
        "concepts/os/signals",
        "concepts/os/exit-codes",
        "concepts/os/file-descriptors",
        "concepts/os/memory-management",
        "concepts/os/processes-threads",
      ],
    },
    {
      type: "category",
      label: "Programming",
      items: [
        "concepts/programming/type-systems",
        "concepts/programming/memory-safety",
        "concepts/programming/concurrency",
        "concepts/programming/error-handling-patterns",
      ],
    },
    {
      type: "category",
      label: "Databases",
      items: [
        "concepts/databases/transactions",
        "concepts/databases/connection-pooling",
        "concepts/databases/deadlocks",
      ],
    },
  ],
  guidesSidebar: [
    {
      type: "category",
      label: "Debugging",
      items: [
        "guides/debugging/reading-stack-traces",
        "guides/debugging/debugging-go",
        "guides/debugging/debugging-node",
        "guides/debugging/debugging-rust",
        "guides/debugging/debugging-python",
      ],
    },
    {
      type: "category",
      label: "Troubleshooting",
      items: [
        "guides/troubleshooting/network-errors",
        "guides/troubleshooting/memory-errors",
        "guides/troubleshooting/permission-errors",
        "guides/troubleshooting/timeout-errors",
      ],
    },
  ],
  referenceSidebar: [
    {
      type: "category",
      label: "HTTP Status Codes",
      items: [
        "reference/http/4xx-client-errors",
        "reference/http/5xx-server-errors",
      ],
    },
    {
      type: "category",
      label: "Exit Codes",
      items: [
        "reference/exit-codes/unix",
        "reference/exit-codes/windows",
      ],
    },
    {
      type: "category",
      label: "Signals",
      items: [
        "reference/signals/unix-signals",
      ],
    },
    {
      type: "category",
      label: "Error Codes",
      items: [
        "reference/errno/common-errno",
      ],
    },
  ],
};

export default sidebars;
