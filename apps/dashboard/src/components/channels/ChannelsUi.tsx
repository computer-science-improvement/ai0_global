// Small parts shared by the channel pages (spec 078 C1): a search field, loading rows, an error callout, a loading note,
// the channel glyph and the panel caption. The styles are in channels.css.

import { useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '../Icon';
import { Icon as UiIcon } from '../ui/Icon';
import { EmptyState } from '../ui/primitives';
import { describeError } from '../ui/Toast';
import { channelInitial } from '../../lib/channel-view';
import './channels.css';

/** An input with a magnifier on the left and, once there is text, a clear button on the right. */
export function SearchField({ value, onChange, placeholder, label, disabled, onClear, style }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  /** Accessible name of the input. */
  label: string;
  disabled?: boolean;
  /** Called by the clear button; defaults to `onChange('')`. */
  onClear?: () => void;
  style?: CSSProperties;
}) {
  return (
    <div className={`ch-search${value ? ' has-clear' : ''}`} style={style}>
      <span className="ch-search-glyph" aria-hidden><Icon name="discovery" size={15} /></span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        disabled={disabled}
        className="input-field"
      />
      {value && !disabled && (
        <button
          type="button"
          className="ch-search-clear"
          title="Clear search"
          aria-label="Clear search"
          onClick={onClear ?? (() => onChange(''))}
        >
          <UiIcon name="x" size={13} />
        </button>
      )}
    </div>
  );
}

/** Grey rows in the rhythm of a list row, for the first load. Put them inside a flush panel. */
export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="ch-skel" aria-hidden>
          <span className="ch-skel-glyph" />
          <span className="ch-skel-lines">
            <span className="ch-skel-bar" style={{ width: `${46 - (i % 3) * 8}%` }} />
            <span className="ch-skel-bar is-short" style={{ width: '24%' }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** A failed load: the red callout with what failed and why. */
export function ErrorCallout({ title, error, message, style }: { title: string; error?: unknown; message?: string; style?: CSSProperties }) {
  // The request error reads as the server's own sentence (describeError), never as a raw JSON body.
  const text = message ?? (error != null ? describeError(error) : undefined);
  return (
    <div className="callout-danger" role="alert" style={{ marginBottom: 16, ...style }}>
      <span className="ch-callout-glyph"><UiIcon name="warning" size={18} /></span>
      <div style={{ minWidth: 0 }}>
        <div className="text-body-sm ch-callout-title">{title}</div>
        {text && <div className="text-micro ch-callout-msg">{text}</div>}
      </div>
    </div>
  );
}

/** "Loading history…" inside a panel (the medallion is the refresh glyph, so it reads apart from an empty state). */
export function LoadingNote({ note }: { note: string }) {
  return <EmptyState icon="refresh" title={note} />;
}

/** The quiet caption in a panel head ("last 30", "full history"). */
export function SectionCaption({ children }: { children: ReactNode }) {
  return <span className="ch-cap">{children}</span>;
}

/**
 * A channel's initial on the neutral glyph tile: 32 / 36px in rows, `xl` (64px) in the entity header. With a `src` the photo
 * covers the initial; if the photo fails to load the initial shows.
 */
export function ChannelGlyph({ name, size = 'md', title, src }: {
  name: string | null | undefined;
  size?: 'sm' | 'md' | 'xl';
  title?: string;
  src?: string | null;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <div
      className={`hub-glyph is-neutral ch-glyph${size === 'sm' ? ' is-sm' : size === 'xl' ? ' is-xl' : ''}`}
      title={title}
      aria-hidden
    >
      {channelInitial(name)}
      {src && !broken && <img className="ch-glyph-img" src={src} alt="" loading="lazy" onError={() => setBroken(true)} />}
    </div>
  );
}
