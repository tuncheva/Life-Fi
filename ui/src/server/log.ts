// Small console logger with the pino call shape the server modules use: log.info({ ...fields }, "message").
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug: (o: unknown, msg?: string) => void;
  info: (o: unknown, msg?: string) => void;
  warn: (o: unknown, msg?: string) => void;
  error: (o: unknown, msg?: string) => void;
}

export function createLogger(level = (process.env.LIFEFI_LOG ?? "info") as Level): Logger {
  const min = ORDER[level] ?? ORDER.info;
  const out = (lvl: Level) => (o: unknown, msg?: string) => {
    if (ORDER[lvl] < min) return;
    const time = new Date().toTimeString().slice(0, 8);
    const fields = o && typeof o === "object" && Object.keys(o).length ? ` ${JSON.stringify(o)}` : "";
    const line = `[lifefi ${time}] ${lvl.toUpperCase()}: ${msg ?? ""}${fields}`;
    if (lvl === "error") console.error(line);
    else if (lvl === "warn") console.warn(line);
    else console.log(line);
  };
  return { debug: out("debug"), info: out("info"), warn: out("warn"), error: out("error") };
}
