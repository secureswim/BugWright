// CommonJS preloads run before ESM loader hooks in the main process and loader workers.
// This avoids tsx falling back to os.userInfo(), which can intermittently return
// UV_ENOMEM on Windows after Docker Desktop starts.
if (process.platform === "win32" && typeof process.geteuid !== "function") {
  Object.defineProperty(process, "geteuid", { value: () => 0, configurable: true });
}
