// Starts the Life-Fi backend (engine connection, alerts, history) when the Next.js server boots,
// so alerts and history keep running even before a browser opens the dashboard.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getRuntime } = await import("./server/runtime");
    getRuntime();
  }
}
