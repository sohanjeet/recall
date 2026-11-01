import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router";
import { AuthStatusScreen } from "../components/AuthStatusScreen";
import { useAuth } from "../lib/auth";

/** Only same-app paths are followed after sign-in, never an arbitrary URL. */
function safeNext(from: unknown): string {
  return typeof from === "string" && from.startsWith("/") && !from.startsWith("//") && !from.startsWith("/login") ? from : "/";
}

export function LoginPage() {
  const { state, signIn, retry } = useAuth();
  const location = useLocation();
  const next = safeNext((location.state as { from?: unknown } | null)?.from);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Sign in · Recall";
  }, []);

  if (state.status === "signedIn") return <Navigate to={next} replace />;
  if (state.status === "loading") return <AuthStatusScreen>Checking your session…</AuthStatusScreen>;
  if (state.status === "unreachable") return <AuthStatusScreen error={state.message} onRetry={retry} />;
  if (state.status === "unconfigured") {
    return (
      <AuthStatusScreen>
        <p role="alert" className="notice-caution">
          Sign-in is not configured on this server. Set <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> in the server environment and restart it.
        </p>
      </AuthStatusScreen>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const message = await signIn(email, password);
    // On success the auth state changes and this page redirects; only failures need handling here.
    if (message) {
      setError(message);
      setPassword("");
      setBusy(false);
    }
  }

  const shown = error ?? state.notice;
  return (
    <AuthStatusScreen>
      <h1 className="section-title">Sign in</h1>
      <form onSubmit={onSubmit} className="mt-6 space-y-5">
        {shown && (
          <p role="alert" className={error ? "notice-error" : "notice-caution"}>
            {shown}
          </p>
        )}
        <label className="label">
          Email
          <input
            type="email"
            className="field mt-1"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            autoFocus
            required
            maxLength={254}
            disabled={busy}
          />
        </label>
        <label className="label">
          Password
          <input
            type="password"
            className="field mt-1"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            maxLength={128}
            disabled={busy}
          />
        </label>
        <button type="submit" className="btn-primary w-full" disabled={busy || !email.trim() || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="text-muted border-line mt-8 border-t pt-4 text-xs leading-snug">
        Access is limited to members of this workspace. Ask the workspace owner for an account.
      </p>
    </AuthStatusScreen>
  );
}
