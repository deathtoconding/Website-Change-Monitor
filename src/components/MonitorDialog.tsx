import { useEffect, useState } from "react";
import { ArrowUpRight, Globe2, Info, X } from "lucide-react";
import type { FormEvent } from "react";
import type { Frequency, Monitor } from "../lib/types";
import { getSuggestedName, validateMonitorUrl } from "../lib/monitoring";

export interface MonitorFormValues {
  name: string;
  url: string;
  frequency: Frequency;
  selector: string;
}

interface MonitorDialogProps {
  initialMonitor?: Monitor | null;
  onClose: () => void;
  onSave: (values: MonitorFormValues) => void | Promise<void>;
}

export function MonitorDialog({
  initialMonitor,
  onClose,
  onSave,
}: MonitorDialogProps) {
  const [name, setName] = useState(initialMonitor?.name ?? "");
  const [url, setUrl] = useState(initialMonitor?.url ?? "");
  const [frequency, setFrequency] = useState<Frequency>(
    initialMonitor?.frequency ?? "six-hourly",
  );
  const [selector, setSelector] = useState(initialMonitor?.selector ?? "");
  const [error, setError] = useState("");
  const [touchedUrl, setTouchedUrl] = useState(false);
  const [saving, setSaving] = useState(false);
  const isEditing = Boolean(initialMonitor);
  const urlError = touchedUrl && url.trim() ? validateMonitorUrl(url) : null;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setTouchedUrl(true);
    const validationError = validateMonitorUrl(url);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (selector.trim().length > 160) {
      setError("CSS selectors must be 160 characters or fewer.");
      return;
    }
    setError("");
    setSaving(true);
    try {
      await onSave({
        name: name.trim() || getSuggestedName(url),
        url: new URL(url.trim()).toString(),
        frequency,
        selector: selector.trim(),
      });
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The monitor could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="monitor-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="monitor-dialog-title"
      >
        <div className="modal-heading">
          <div className="modal-heading-icon">
            <Globe2 size={18} />
          </div>
          <div>
            <h2 id="monitor-dialog-title">
              {isEditing ? "Edit monitor" : "Add a monitor"}
            </h2>
            <p>
              {isEditing
                ? "Update how this page is watched."
                : "Choose a page and how often you want us to look."}
            </p>
          </div>
          <button
            className="icon-button modal-close"
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <form onSubmit={submit} noValidate>
          <label className="field-label" htmlFor="monitor-url">
            Page URL <span className="required-mark">*</span>
          </label>
          <div
            className={`input-with-icon ${urlError || error ? "input-error" : ""}`}
          >
            <Globe2 size={16} />
            <input
              id="monitor-url"
              autoFocus
              type="url"
              value={url}
              placeholder="https://example.com/pricing"
              onChange={(event) => {
                setUrl(event.target.value);
                setError("");
              }}
              onBlur={() => setTouchedUrl(true)}
              aria-invalid={Boolean(urlError || error)}
              aria-describedby="monitor-url-help monitor-url-error"
            />
          </div>
          <div id="monitor-url-help" className="field-hint">
            Public pages on HTTP or HTTPS. No login required.
          </div>
          {(urlError || error) && (
            <div id="monitor-url-error" className="field-error">
              {error || urlError}
            </div>
          )}

          <label className="field-label" htmlFor="monitor-name">
            Monitor name
          </label>
          <input
            id="monitor-name"
            className="form-input"
            value={name}
            placeholder="e.g. Competitor pricing"
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="field-hint">
            Give this page a name that makes sense to you.
          </div>

          <div className="form-grid">
            <div>
              <label className="field-label" htmlFor="monitor-frequency">
                Check frequency
              </label>
              <select
                id="monitor-frequency"
                className="form-input form-select"
                value={frequency}
                onChange={(event) =>
                  setFrequency(event.target.value as Frequency)
                }
              >
                <option value="hourly">Every hour</option>
                <option value="six-hourly">Every 6 hours</option>
                <option value="daily">Daily</option>
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="monitor-selector">
                CSS selector <span className="optional-label">Optional</span>
              </label>
              <input
                id="monitor-selector"
                className="form-input"
                value={selector}
                placeholder="main, .pricing"
                maxLength={160}
                onChange={(event) => setSelector(event.target.value)}
              />
            </div>
          </div>
          <div className="preview-notice">
            <Info size={15} />
            <span>
              <strong>Safe by design:</strong> only public HTTP(S) pages are
              allowed. We compare extracted text and never execute page scripts.
            </span>
          </div>
          <div className="modal-footer">
            <button
              className="button button-quiet"
              type="button"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              className="button button-primary"
              type="submit"
              disabled={saving}
            >
              {saving ? "Saving…" : isEditing ? "Save changes" : "Add monitor"}{" "}
              {!saving && <ArrowUpRight size={15} />}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
