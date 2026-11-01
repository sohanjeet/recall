/** Shows who the audit history will record. The server takes this from the verified session, not from the page. */
export function ActingAs({ email }: { email: string }) {
  return (
    <p className="text-muted max-w-64 text-xs leading-snug">
      Acting as <span className="text-ink font-medium break-all">{email}</span>. Every approval is recorded under your account.
    </p>
  );
}
