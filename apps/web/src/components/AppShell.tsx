import { NavLink, Outlet } from "react-router";
import { useAuth, useUser } from "../lib/auth";
import { HealthIndicator } from "./HealthIndicator";

const NAV = [
  { to: "/", label: "Meetings", end: true },
  { to: "/meetings/new", label: "New meeting", end: false },
  { to: "/approvals", label: "Approvals", end: false },
  { to: "/reminders", label: "Reminders & digests", end: false },
  { to: "/people", label: "People", end: false },
] as const;

export function AppShell() {
  const user = useUser();
  const { signOut } = useAuth();
  const account = (
    <div className="flex min-w-0 items-center justify-between gap-3 md:block">
      <p className="text-muted min-w-0 truncate text-xs" title={user.email}>
        Signed in as <span className="text-ink font-medium">{user.email}</span>
      </p>
      <button type="button" className="btn-quiet -mx-2 !min-h-8 !px-2 text-xs md:mt-1.5" onClick={() => void signOut()}>
        Sign out
      </button>
    </div>
  );
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[16rem_1fr]">
      <a href="#main" className="bg-ink text-paper sr-only z-50 rounded-md px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
        Skip to content
      </a>
      <aside className="border-line bg-paper flex flex-col gap-4 border-b px-5 pt-5 pb-3 md:sticky md:top-0 md:h-dvh md:gap-10 md:border-r md:border-b-0 md:px-7 md:py-9">
        <div>
          <span className="display text-ink text-[1.75rem] leading-none">Recall</span>
          <p className="text-muted mt-2 hidden text-[0.8125rem] leading-snug md:block">
            Meetings become decisions,
            <br />
            decisions become work.
          </p>
        </div>
        <nav aria-label="Primary" className="-mx-2 flex flex-wrap gap-x-0.5 gap-y-0.5 pb-1.5 md:mx-0 md:flex-col md:flex-nowrap md:pb-0">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `relative shrink-0 rounded-md px-2.5 py-2 text-sm whitespace-nowrap transition-colors duration-200 md:px-3 ${
                  isActive
                    ? "text-ink after:bg-accent font-semibold after:absolute after:inset-x-2.5 after:bottom-0 after:h-0.5 after:rounded-full md:after:inset-x-auto md:after:top-2 md:after:bottom-2 md:after:-left-7 md:after:h-auto md:after:w-0.5"
                    : "text-muted hover:text-ink"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="md:hidden">{account}</div>
        <div className="mt-auto hidden space-y-5 md:block">
          <HealthIndicator />
          <div className="border-line border-t pt-4">{account}</div>
        </div>
      </aside>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-4xl px-5 py-8 outline-none md:px-12 md:py-14">
        <Outlet />
      </main>
    </div>
  );
}
