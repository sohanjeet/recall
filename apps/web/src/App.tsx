import { Route, Routes } from "react-router";
import { AppShell } from "./components/AppShell";
import { RequireAuth } from "./components/RequireAuth";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { LoginPage } from "./pages/LoginPage";
import { MeetingDetailPage } from "./pages/MeetingDetailPage";
import { MeetingsPage } from "./pages/MeetingsPage";
import { NewMeetingPage } from "./pages/NewMeetingPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { PeoplePage } from "./pages/PeoplePage";
import { RemindersPage } from "./pages/RemindersPage";

export function App() {
  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<MeetingsPage />} />
          <Route path="meetings/new" element={<NewMeetingPage />} />
          <Route path="meetings/:id" element={<MeetingDetailPage />} />
          <Route path="approvals" element={<ApprovalsPage />} />
          <Route path="reminders" element={<RemindersPage />} />
          <Route path="people" element={<PeoplePage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
