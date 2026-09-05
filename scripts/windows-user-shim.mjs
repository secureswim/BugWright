// tsx names its temporary directory with process.geteuid() on Unix and os.userInfo() on Windows.
// Some Windows sessions transiently return UV_ENOMEM for userInfo after Docker starts.
if (process.platform === "win32" && typeof process.geteuid !== "function") {
  Object.defineProperty(process, "geteuid", { value: () => 0, configurable: true });
}

// Load tsx only after the process shim is active. Separate --import flags can be
// evaluated concurrently, which made this workaround intermittent on Windows.
await import("tsx");
