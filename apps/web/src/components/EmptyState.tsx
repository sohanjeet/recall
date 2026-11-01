import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, children, action }: EmptyStateProps) {
  return (
    <div className="border-line-strong rounded-lg border border-dashed px-6 py-14 text-left md:px-12">
      <h2 className="display text-[1.375rem]">{title}</h2>
      <div className="text-muted mt-2 max-w-md text-sm">{children}</div>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
