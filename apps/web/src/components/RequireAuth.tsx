import { Navigate, Outlet, useLocation } from "react-router";
import { useAuth } from "../lib/auth";
import { AuthStatusScreen } from "./AuthStatusScreen";

/** Renders child routes only for a server-confirmed session; otherwise sends the visitor to /login and back after. */
export function RequireAuth() {
  const { state, retry } = useAuth();
  const location = useLocation();

  if (state.status === "loading") return <AuthStatusScreen>Checking your session…</AuthStatusScreen>;
  if (state.status === "unreachable") return <AuthStatusScreen error={state.message} onRetry={retry} />;
  if (state.status !== "signedIn") {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}${location.hash}` }} />;
  }
  return <Outlet />;
}
