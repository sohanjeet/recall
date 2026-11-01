import type { HealthResponse, ServiceState } from "@recall/shared";
import { useHealth } from "../lib/useHealth";

const LABELS: Record<keyof HealthResponse["services"], string> = {
  database: "Database",
  groq: "Groq",
  taskTracker: "Linear",
  email: "Email",
};

const DOT: Record<ServiceState, string> = {
  ok: "bg-ok",
  down: "bg-conflict",
  unconfigured: "border-faint border bg-transparent",
};

export function HealthIndicator() {
  const state = useHealth();

  if (state.kind === "loading") return <p className="text-muted text-xs">Checking services…</p>;
  if (state.kind === "unreachable")
    return (
      <p className="text-conflict text-xs" role="status">
        API unreachable. Is the server running on :8787?
      </p>
    );

  const services = Object.entries(state.health.services) as [keyof HealthResponse["services"], ServiceState][];
  return (
    <ul className="space-y-1.5 text-xs" aria-label="Service status">
      {services.map(([key, value]) => (
        <li key={key} className="flex items-center justify-between gap-2">
          <span className="text-muted">{LABELS[key]}</span>
          <span className="text-ink flex items-center gap-1.5">
            <span className={`size-1.5 rounded-full ${DOT[value]}`} aria-hidden />
            {value}
          </span>
        </li>
      ))}
    </ul>
  );
}
