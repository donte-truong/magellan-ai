import { AlertCircle, ArrowUpRight, Check, LoaderCircle } from "lucide-react";
import { safeSourceUrl } from "@/lib/api";
import { supportLabels, type SupportLabel } from "@/lib/types";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32">
          <path d="M7 25V7l9 11L25 7v18" />
          <circle cx="16" cy="18" r="2" />
        </svg>
      </span>
      {!compact && <span>Magellan</span>}
    </span>
  );
}

export function SupportBadge({ label }: { label: SupportLabel }) {
  return (
    <span className={`support-badge support-${label}`}>
      <span className="status-dot" />
      {supportLabels[label]}
    </span>
  );
}

export function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="error-notice" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
      {retry && (
        <button className="text-button" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span className="loading-inline" role="status">
      <LoaderCircle className="spin" size={17} />
      <span>{label}</span>
    </span>
  );
}

export function SourceLink({ url, children }: { url?: string | null; children: React.ReactNode }) {
  const safe = safeSourceUrl(url);
  return safe ? (
    <a className="source-link" href={safe} target="_blank" rel="noopener noreferrer">
      {children}
      <ArrowUpRight size={14} />
    </a>
  ) : (
    <span className="source-link">{children}</span>
  );
}

export function Stepper({
  step,
  canNavigate,
  onChange,
}: {
  step: number;
  canNavigate: boolean;
  onChange: (step: number) => void;
}) {
  return (
    <nav className="stepper" aria-label="Exploration progress">
      {["Choose a product", "Bill of materials", "Explore the network"].map((name, index) => (
        <button
          key={name}
          className={`step ${step === index ? "current" : ""} ${step > index ? "done" : ""}`}
          aria-current={step === index ? "step" : undefined}
          disabled={(index > 0 && !canNavigate) || (index === 0 && step > 0)}
          onClick={() => onChange(index)}
        >
          <span className="step-number">
            {step > index ? <Check size={13} /> : `0${index + 1}`}
          </span>
          <span>{name}</span>
          {index < 2 && <span className="step-line" />}
        </button>
      ))}
    </nav>
  );
}
