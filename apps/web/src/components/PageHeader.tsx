import { useEffect, type ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  useEffect(() => {
    document.title = `${title} · Recall`;
  }, [title]);
  return (
    <header className="rise border-line mb-10 flex flex-wrap items-end justify-between gap-x-8 gap-y-5 border-b pb-8">
      <div className="max-w-xl min-w-0">
        <h1 className="page-title">{title}</h1>
        {description && <p className="text-muted mt-3 text-base">{description}</p>}
      </div>
      {actions}
    </header>
  );
}
