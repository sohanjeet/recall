import type { SessionUser } from "@recall/shared";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiRequestError, api, setAuthBridge } from "./api";

export type AuthState =
  | { status: "loading" }
  | { status: "unconfigured" }
  | { status: "unreachable"; message: string }
  | { status: "signedOut"; notice?: string }
  | { status: "signedIn"; user: SessionUser };

interface AuthContextValue {
  state: AuthState;
  /** Resolves to an error message, or null on success. */
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  retry: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = "recall.auth";
const EXPIRED = "Your session has expired. Sign in again to continue.";

const readStorage = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const FORBIDDEN = "This account does not have access to this Recall workspace.";

/**
 * Supabase Auth session for the app. The anon key and URL come from the server at runtime; the browser keeps only
 * Supabase's own session (in localStorage) and sends the short-lived access token as a bearer token to /api.
 * Every API request is still verified server-side; nothing here is trusted for authorization.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const client = useRef<SupabaseClient | null>(null);

  // Drops the local session without waiting on the network, then shows the login page with a reason.
  const endSession = useCallback(async (notice?: string) => {
    setState({ status: "signedOut", notice });
    await client.current?.auth.signOut({ scope: "local" }).catch(() => undefined);
  }, []);

  // Confirms with the server that the session is valid and allow-listed before showing the app.
  const confirm = useCallback(async (): Promise<string | null> => {
    try {
      setState({ status: "signedIn", user: await api.me() });
      return null;
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 0) {
        setState({ status: "unreachable", message: err.message });
        return err.message;
      }
      const message = err instanceof ApiRequestError && err.status === 403 ? FORBIDDEN : err instanceof ApiRequestError && err.status === 401 ? EXPIRED : err instanceof Error ? err.message : "Could not sign in";
      await endSession(message);
      return message;
    }
  }, [endSession]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    setState({ status: "loading" });
    (async () => {
      let config;
      try {
        config = await api.authConfig();
      } catch (err) {
        if (!cancelled) setState({ status: "unreachable", message: err instanceof Error ? err.message : "Could not reach the Recall server" });
        return;
      }
      if (cancelled) return;
      if (!config.enabled) return setState({ status: "unconfigured" });

      // A stored session that does not survive initialisation (its refresh token was rejected) means it expired.
      const hadStoredSession = !client.current && readStorage(STORAGE_KEY) !== null;
      const supabase = (client.current ??= createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: STORAGE_KEY },
      }));
      setAuthBridge({
        // getSession refreshes an expired access token using the stored refresh token.
        getToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
        refreshToken: async () => (await supabase.auth.refreshSession()).data.session?.access_token ?? null,
        onSessionLost: (reason) => void endSession(reason === "forbidden" ? FORBIDDEN : EXPIRED),
      });
      // Sign-out in another tab, or a refresh token that can no longer be used.
      const { data } = supabase.auth.onAuthStateChange((event) => {
        if (event === "SIGNED_OUT") setState((s) => (s.status === "signedIn" ? { status: "signedOut", notice: EXPIRED } : s));
      });
      unsubscribe = () => data.subscription.unsubscribe();

      const { data: session } = await supabase.auth.getSession();
      if (cancelled) return;
      if (session.session) await confirm();
      else setState({ status: "signedOut", notice: hadStoredSession ? EXPIRED : undefined });
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
      setAuthBridge(null);
    };
  }, [attempt, confirm, endSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      retry: () => setAttempt((n) => n + 1),
      signIn: async (email, password) => {
        const supabase = client.current;
        if (!supabase) return "Sign-in is not available right now.";
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) return error.code === "invalid_credentials" ? "Email or password is incorrect." : error.message;
        return confirm();
      },
      signOut: async () => {
        setState({ status: "signedOut" });
        // Revokes the refresh token server-side; falls back to clearing this browser if Supabase is unreachable.
        const { error } = (await client.current?.auth.signOut()) ?? {};
        if (error) await client.current?.auth.signOut({ scope: "local" }).catch(() => undefined);
      },
    }),
    [state, confirm],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

/** The signed-in user; only call inside routes guarded by RequireAuth. */
export function useUser(): SessionUser {
  const { state } = useAuth();
  if (state.status !== "signedIn") throw new Error("useUser called without a signed-in user");
  return state.user;
}
