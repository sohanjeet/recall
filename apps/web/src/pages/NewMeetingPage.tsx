import { parseTranscript, UNLABELLED_SPEAKER, type MeetingSource } from "@recall/shared";
import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { ErrorNotice } from "../components/ErrorNotice";
import { PageHeader } from "../components/PageHeader";
import { api } from "../lib/api";

const MAX_TRANSCRIPT = 50_000;
const input = "field";

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function NewMeetingPage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [occurredAt, setOccurredAt] = useState(today);
  const [participantsText, setParticipantsText] = useState("");
  const [source, setSource] = useState<MeetingSource>("paste");
  const [transcript, setTranscript] = useState("");
  const [speakerMap, setSpeakerMap] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<"idle" | "saving" | "analyzing">("idle");
  const [error, setError] = useState<string | null>(null);

  const participants = useMemo(
    () => participantsText.split(",").map((p) => p.trim()).filter(Boolean),
    [participantsText],
  );
  const speakers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of parseTranscript(transcript)) counts.set(s.speakerLabel, (counts.get(s.speakerLabel) ?? 0) + 1);
    return [...counts];
  }, [transcript]);

  const busy = phase !== "idle";
  const tooLong = transcript.length > MAX_TRANSCRIPT;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPhase("saving");
    let id: string;
    try {
      const cleanMap = Object.fromEntries(
        Object.entries(speakerMap).filter(([label, name]) => name.trim() && speakers.some(([l]) => l === label)),
      );
      id = (await api.createMeeting({ title, occurredAt, participants, transcript, source, speakerMap: cleanMap })).id;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the meeting");
      setPhase("idle");
      return;
    }
    // The meeting is saved either way; a failed analysis is recorded on it and can be retried there.
    setPhase("analyzing");
    await api.analyzeMeeting(id).catch(() => undefined);
    navigate(`/meetings/${id}`);
  }

  return (
    <>
      <PageHeader title="New meeting" description="Paste a speaker-labelled transcript or dictate a recap." />
      <form onSubmit={onSubmit} className="rise-2 space-y-7">
        <div className="grid gap-4 sm:grid-cols-[1fr_11rem]">
          <label className="label">
            Title
            <input className={`${input} mt-1`} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} disabled={busy} />
          </label>
          <label className="label">
            Meeting date
            <input type="date" className={`${input} mt-1`} value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} required disabled={busy} />
          </label>
        </div>

        <div className="grid gap-4 sm:grid-cols-[1fr_11rem]">
          <div>
            <label htmlFor="participants-input" className="label">Participants</label>
            <input id="participants-input" aria-describedby="participants-help" className={`${input} mt-1`} value={participantsText} onChange={(e) => setParticipantsText(e.target.value)} placeholder="Sam, Ana, Priya" disabled={busy} />
            <span id="participants-help" className="hint">Comma-separated. Helps match owners to people.</span>
          </div>
          <label className="label">
            Source
            <select className={`${input} mt-1`} value={source} onChange={(e) => setSource(e.target.value as MeetingSource)} disabled={busy}>
              <option value="paste">Pasted transcript</option>
              <option value="dictation">Dictation (Wispr Flow)</option>
            </select>
          </label>
        </div>

        <div>
          <label htmlFor="transcript-input" className="label">Transcript</label>
          <textarea
            id="transcript-input"
            aria-describedby="transcript-help"
            aria-invalid={tooLong}
            className={`${input} mt-1 min-h-72 resize-y font-mono text-[0.8125rem] leading-relaxed`}
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            placeholder={"Sam: Let's ship the beta on Monday.\nAna: I'll send the release notes by Friday.\n\nOr dictate a recap with Wispr Flow without speaker labels."}
            required
            disabled={busy}
          />
          <span id="transcript-help" className={`hint tabular-nums ${tooLong ? "!text-conflict font-medium" : ""}`}>
            {transcript.length.toLocaleString()} / {MAX_TRANSCRIPT.toLocaleString()} characters. Edit the text freely to correct transcription mistakes before analyzing.
          </span>
        </div>

        {speakers.length > 0 && (
          <fieldset className="panel p-5" disabled={busy}>
            <legend className="display px-1 text-lg">Detected speakers</legend>
            <p className="meta mb-4">Fix a mislabelled speaker by entering the real name; the original transcript is kept as-is.</p>
            <ul className="space-y-2">
              {speakers.map(([label, count]) => (
                <li key={label} className="grid grid-cols-[1fr_1fr] items-center gap-3 text-sm">
                  <span>
                    {label === UNLABELLED_SPEAKER ? "No speaker labels" : label} <span className="text-muted tabular-nums">· {count} segment{count === 1 ? "" : "s"}</span>
                  </span>
                  <input
                    className={input}
                    aria-label={`Real name for ${label}`}
                    placeholder="Real name (optional)"
                    value={speakerMap[label] ?? ""}
                    onChange={(e) => setSpeakerMap((m) => ({ ...m, [label]: e.target.value }))}
                    list="participants"
                  />
                </li>
              ))}
            </ul>
            <datalist id="participants">
              {participants.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </fieldset>
        )}

        {error && <ErrorNotice message={error} />}

        <div className="border-line flex flex-wrap items-center gap-x-5 gap-y-3 border-t pt-6">
          <button type="submit" disabled={busy || tooLong} className="btn-primary px-5">
            {phase === "saving" ? "Saving…" : phase === "analyzing" ? "Extracting decisions and tasks…" : "Save and analyze"}
          </button>
          <p className="meta">Results are saved as drafts. Nothing is sent to Linear until you approve it.</p>
        </div>
      </form>
    </>
  );
}
