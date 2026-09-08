import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, MoreHorizontal } from "lucide-react";

export function ActionMenu({ children, label = "More actions" }: { children: ReactNode; label?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return (
    <details
      ref={ref}
      className="action-menu"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          if (ref.current) ref.current.open = false;
          ref.current?.querySelector("summary")?.focus();
        }
      }}
    >
      <summary className="button" aria-label={label} title={label}>
        <MoreHorizontal size={18} />
      </summary>
      <div
        className="action-menu-items"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button,a") && ref.current) ref.current.open = false;
        }}
      >
        {children}
      </div>
    </details>
  );
}

export function CopyButton({
  value,
  label = "Copy output URL",
  className = "button",
  onError
}: {
  value: string;
  label?: string;
  className?: string;
  onError?: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={className}
      aria-label={copied ? "Copied" : label}
      onClick={() => {
        void (async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch {
            onError?.("Could not copy output URL.");
          }
        })();
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      <span role="status">{copied ? "Copied" : label}</span>
    </button>
  );
}

export function RecordInput({
  value,
  onCommit
}: {
  value: { wins: number; losses: number; draws: number };
  onCommit: (value: { wins: number; losses: number; draws: number }) => void;
}) {
  const formatted = `${value.wins}-${value.losses}-${value.draws}`;
  const [draft, setDraft] = useState(formatted);
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (!focused && !invalid) setDraft(formatted);
  }, [formatted, focused, invalid]);
  const commit = () => {
    const match = draft.trim().match(/^(\d{1,7})\s*[-/]\s*(\d{1,7})\s*[-/]\s*(\d{1,7})$/);
    if (!match || match.slice(1).some((part) => Number(part) > 1_000_000)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (draft !== formatted) onCommit({ wins: Number(match[1]), losses: Number(match[2]), draws: Number(match[3]) });
  };
  return (
    <label className="field">
      <span>Record (W-L-T)</span>
      <input
        value={draft}
        aria-invalid={invalid || undefined}
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          setDraft(e.target.value);
          setInvalid(false);
        }}
        onBlur={() => {
          commit();
          setFocused(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") {
            setDraft(formatted);
            setInvalid(false);
            e.preventDefault();
          }
        }}
      />
      {invalid ? (
        <small className="field-error" role="alert">
          Use wins-losses-ties, e.g. 12-3-1.
        </small>
      ) : null}
    </label>
  );
}
