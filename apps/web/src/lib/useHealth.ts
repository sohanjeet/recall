import type { HealthResponse } from "@recall/shared";
import { useEffect, useState } from "react";
import { api } from "./api";

export type HealthState =
  | { kind: "loading" }
  | { kind: "unreachable" }
  | { kind: "ready"; health: HealthResponse };

const POLL_MS = 30_000;

export function useHealth(): HealthState {
  const [state, setState] = useState<HealthState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const check = () =>
      api
        .health()
        .then((health) => !cancelled && setState({ kind: "ready", health }))
        .catch(() => !cancelled && setState({ kind: "unreachable" }));
    void check();
    const id = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return state;
}
