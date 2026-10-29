"use client";
// PIN for dashboard writes (plan-v2 §7.4), asked in a real dialog instead of
// window.prompt: the acknowledge moment on a phone and in the demo must not be a
// browser popup. `withPin(fn)` asks when no PIN is stored, runs fn, and on a 401
// clears the PIN and asks again with "that PIN is not right".
import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { ApiError, getPin, setPin } from "./api";

type Ask = (error: string | null) => Promise<boolean>;

interface PinApi {
  withPin: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
}

const PinContext = createContext<PinApi | null>(null);

/** A message a non-engineer can act on. */
export function friendlyError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "engine_offline") return "The sensor software is not running, so this can't be done right now.";
    if (e.code === "pin") return "That PIN is not right.";
    if (e.code === "notify") return `The phone notification could not be sent: ${e.message}. Check the ntfy server and topic.`;
    return e.message;
  }
  if (e instanceof TypeError) return "Can't reach the Life-Fi box. Check the connection and try again.";
  return (e as Error)?.message ?? "Something went wrong.";
}

export function PinProvider({ children }: { children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState("");

  const ask: Ask = (err) =>
    new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setError(err);
      setValue("");
      dialog.current?.showModal();
    });

  const finish = (ok: boolean) => {
    if (ok) setPin(value);
    dialog.current?.close();
    resolver.current?.(ok);
    resolver.current = null;
  };

  const withPin = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    let err: string | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!getPin() || err) {
        if (!(await ask(err))) return undefined;
      }
      try {
        return await fn();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          setPin("");
          err = "That PIN is not right. Try again.";
          continue;
        }
        throw e;
      }
    }
    return undefined;
  };

  return (
    <PinContext.Provider value={{ withPin }}>
      {children}
      <dialog
        ref={dialog}
        onCancel={() => finish(false)}
        className="m-auto w-[min(92vw,22rem)] rounded-card border border-line bg-surface p-0 text-fg shadow-2xl backdrop:bg-black/50"
        aria-labelledby="pin-title"
      >
        <form
          method="dialog"
          className="p-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (value) finish(true);
          }}
        >
          <h2 id="pin-title" className="text-lg font-semibold">
            Enter the dashboard PIN
          </h2>
          <p className="mt-1 text-sm text-muted">Needed to acknowledge alerts and change the setup. Ask whoever installed Life-Fi.</p>
          <input
            autoFocus
            type="password"
            inputMode="numeric"
            autoComplete="off"
            aria-label="PIN"
            aria-invalid={!!error}
            aria-describedby={error ? "pin-error" : undefined}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="mt-4 block w-full rounded-lg border border-line bg-surface-2 px-3 py-3 text-center font-mono text-2xl tracking-[0.5em]"
          />
          {error && (
            <p id="pin-error" role="alert" className="mt-2 text-sm font-medium text-danger">
              {error}
            </p>
          )}
          <div className="mt-5 flex gap-2">
            <button type="button" onClick={() => finish(false)} className="flex-1 rounded-lg border border-line px-4 py-3 font-semibold">
              Cancel
            </button>
            <button type="submit" disabled={!value} className="flex-1 rounded-lg bg-primary px-4 py-3 font-semibold text-primary-fg disabled:opacity-40">
              Continue
            </button>
          </div>
        </form>
      </dialog>
    </PinContext.Provider>
  );
}

export function usePin(): PinApi {
  const v = useContext(PinContext);
  if (!v) throw new Error("usePin must be used inside <PinProvider>");
  return v;
}
