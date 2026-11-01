import { Link } from "react-router";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" />
      <EmptyState
        title="Nothing here"
        action={
          <Link to="/" className="btn-secondary">
            Back to meetings
          </Link>
        }
      >
        That page does not exist.
      </EmptyState>
    </>
  );
}
