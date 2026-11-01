import { useCallback, useEffect, useState } from "react";
import { ApiRequestError } from "./api";

export type AsyncState<T> =
  | { kind: "loading" }
  | { kind: "error"; message: string; status?: number }
  | { kind: "ready"; data: T };

/** Runs `load` on mount and whenever `deps` change; `reload` re-runs it and `set` replaces the data. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<AsyncState<T>>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    load().then(
      (data) => !cancelled && setState({ kind: "ready", data }),
      (err: unknown) => !cancelled && setState({ kind: "error", message: err instanceof Error ? err.message : "Something went wrong", status: err instanceof ApiRequestError ? err.status : undefined }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const set = useCallback((data: T) => setState({ kind: "ready", data }), []);
  return { state, reload, set };
}
