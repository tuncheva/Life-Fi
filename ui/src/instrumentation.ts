// Starts the Life-Fi backend (engine connection, alerts, history) when the Next.js server boots,
// so alerts and history keep running even before a browser opens the dashboard.
// A bad configuration is printed, never fatal: the server stays up and the API answers
// 500 {"error":"config"} with the list, instead of a supervisor restart loop.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getRuntime } = await import("./server/runtime");
    try {
      getRuntime();
    } catch (err) {
      console.error((err as Error).message);
    }
  }
}
