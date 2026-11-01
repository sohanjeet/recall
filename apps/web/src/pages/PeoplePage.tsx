import { Link } from "react-router";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";

export function PeoplePage() {
  return (
    <>
      <PageHeader title="People" description="Owners and their open work." />
      <EmptyState
        title="Per-person pages are not built yet"
        action={
          <Link to="/reminders" className="btn-secondary">
            See each owner’s work in Weekly digests
          </Link>
        }
      >
        Owners are matched to people from meeting transcripts, but there is no directory view yet. Each owner’s overdue,
        upcoming and completed tasks are grouped under Reminders &amp; digests.
      </EmptyState>
    </>
  );
}
