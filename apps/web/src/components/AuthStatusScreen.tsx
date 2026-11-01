import type { ReactNode } from "react";
import { ErrorNotice } from "./ErrorNotice";

/** Full-page frame for the signed-out states: the login form, session checks and connection errors. */
export function AuthStatusScreen({ children, error, onRetry }: { children?: ReactNode; error?: string; onRetry?: () => void }) {
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center px-5 py-12">
      <div className="rise w-full max-w-sm">
        <div className="mb-8">
          <span className="display text-ink text-[2.25rem] leading-none">Recall</span>
          <p className="text-muted mt-2 text-[0.8125rem] leading-snug">Meetings become decisions, decisions become work.</p>
        </div>
        {error ? <ErrorNotice message={error} onRetry={onRetry} /> : typeof children === "string" ? <p className="meta" role="status">{children}</p> : children}
      </div>
    </main>
  );
}
