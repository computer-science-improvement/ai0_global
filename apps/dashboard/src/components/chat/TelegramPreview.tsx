// How a draft will look in the Telegram channel: one bubble per Telegram call
// the backend renderer makes (photo + caption, album, video, text with a link
// preview, inline URL buttons, poll / quiz). A quiz can be tried in place —
// the correct option and the explanation appear after a tap, as in Telegram.
// Spec 033: a rich message (headings, lists, tables, formulas …) renders its
// blocks; the HTML fallback it carries is one tap away under the bubble.

import { useMemo, useState } from 'react';
import { Icon } from '../ui/Icon';
import { sanitizeTelegramHtml } from '../../lib/tg-html';
import type { TgMessage, TgUrlButton } from '../../api/types';
import { RichBlocksView } from './RichMessageView';

const safeSrc = (u: string) => /^https?:\/\//i.test(u) || u.startsWith('/');

export function TelegramPreview({ messages, channelTitle, channelKey, time }: {
  messages: TgMessage[]; channelTitle: string | null; channelKey: string; time: string;
}) {
  const name = channelTitle || channelKey;
  return (
    <div className="tg-chat" aria-label="Telegram preview">
      <div className="tg-head">
        <span className="tg-avatar" aria-hidden>{name.replace(/^@/, '').slice(0, 1).toUpperCase()}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
          <div style={{ fontSize: 11, color: 'var(--color-tg-meta)' }}>channel · preview</div>
        </div>
      </div>
      {messages.map((m, i) => <TgMessageView key={i} m={m} time={time} />)}
    </div>
  );
}

function TgMessageView({ m, time }: { m: TgMessage; time: string }) {
  switch (m.method) {
    case 'sendPoll':
      return <PollBubble m={m} time={time} />;
    case 'sendRichMessage':
      return (
        <div>
          <div className="tg-bubble">
            <div className="tg-rich">
              <RichBlocksView blocks={m.blocks} media={(src, kind) => <Media src={src} kind={kind} />} />
            </div>
            <Meta time={time} />
          </div>
          <Buttons rows={m.buttons} />
          <details className="tg-rich-fallback">
            <summary>Fallback if the channel rejects rich messages</summary>
            <TgMessageView m={m.fallback} time={time} />
          </details>
        </div>
      );
    case 'sendMediaGroup':
      return (
        <div className="tg-bubble">
          <div className="tg-album">{m.photos.map((p, i) => <Media key={i} src={p} kind="photo" />)}</div>
          <Caption html={m.caption} />
          <Meta time={time} />
        </div>
      );
    case 'sendMessage': {
      const link = m.preview && (
        <div className="tg-preview-link">
          <div style={{ color: 'var(--color-tg-link)', fontWeight: 600 }}>{host(m.preview.url)}</div>
          <a href={m.preview.url} target="_blank" rel="noopener noreferrer nofollow" style={{ wordBreak: 'break-all' }}>{m.preview.url}</a>
        </div>
      );
      return (
        <div>
          <div className="tg-bubble">
            {m.preview?.showAboveText && link}
            <Caption html={m.text} />
            {!m.preview?.showAboveText && link}
            <Meta time={time} />
          </div>
          <Buttons rows={m.buttons} />
        </div>
      );
    }
    case 'sendPhoto':
    case 'sendVideo': {
      const media = <Media src={m.method === 'sendPhoto' ? m.photo : m.video} kind={m.method === 'sendPhoto' ? 'photo' : 'video'} />;
      return (
        <div>
          <div className="tg-bubble">
            {m.captionAboveMedia ? <><Caption html={m.caption} />{media}</> : <>{media}<Caption html={m.caption} /></>}
            <Meta time={time} />
          </div>
          <Buttons rows={m.buttons} />
        </div>
      );
    }
  }
}

function Caption({ html }: { html: string }) {
  const clean = useMemo(() => (html ? sanitizeTelegramHtml(html) : ''), [html]);
  if (!clean) return null;
  return <div className="tg-text" dangerouslySetInnerHTML={{ __html: clean }} />;
}

function Meta({ time }: { time: string }) {
  return <div className="tg-meta"><Icon name="eye" size={11} /> — · {time}</div>;
}

function Media({ src, kind }: { src: string; kind: 'photo' | 'video' }) {
  const [broken, setBroken] = useState(false);
  if (!safeSrc(src) || broken) {
    return (
      <div className="tg-media-missing">
        <Icon name="image-off" size={16} />
        <span>{broken ? `${kind} did not load: ${src}` : `${kind}: ${src}`}</span>
      </div>
    );
  }
  return kind === 'photo'
    ? <img className="tg-media" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
    : <video className="tg-media" src={src} controls muted playsInline preload="metadata" onError={() => setBroken(true)} />;
}

function Buttons({ rows }: { rows: TgUrlButton[][] }) {
  if (!rows.length) return null;
  return (
    <div className="tg-buttons" style={{ marginTop: 4 }}>
      {rows.map((row, i) => (
        <div key={i} className="tg-buttons-row">
          {row.map((b, j) => (
            <a key={j} className="tg-button" href={b.url} target="_blank" rel="noopener noreferrer nofollow" title={b.url}>
              {b.text}<Icon name="external" size={10} className="tg-button-ico" />
            </a>
          ))}
        </div>
      ))}
    </div>
  );
}

function PollBubble({ m, time }: { m: Extract<TgMessage, { method: 'sendPoll' }>; time: string }) {
  const [chosen, setChosen] = useState<number | null>(null);
  const kind = `${m.anonymous ? 'Anonymous ' : 'Public '}${m.quiz ? 'Quiz' : 'Poll'}`;
  const state = (i: number) => {
    if (chosen == null) return undefined;
    if (!m.quiz) return i === chosen ? 'chosen' : undefined;
    if (i === m.correctIndex) return 'right';
    return i === chosen ? 'wrong' : undefined;
  };
  return (
    <div className="tg-bubble">
      <div className="tg-poll">
        <div className="tg-poll-q">{m.question}</div>
        <div className="tg-poll-kind">{kind}</div>
        {m.options.map((o, i) => {
          const s = state(i);
          return (
            <button key={i} type="button" className="tg-option" data-state={s} disabled={chosen != null} onClick={() => setChosen(i)}>
              <span className="tg-option-dot">{s === 'right' || s === 'chosen' ? <Icon name="check" size={11} strokeWidth={3} /> : s === 'wrong' ? <Icon name="x" size={11} strokeWidth={3} /> : null}</span>
              <span>{o}</span>
            </button>
          );
        })}
        {chosen != null && m.quiz && m.explanation && (
          <div className="tg-explain"><Icon name="hint" size={14} /><span>{m.explanation}</span></div>
        )}
        <div className="tg-poll-foot">
          {chosen == null
            ? <span>{m.quiz ? 'Tap an option to check the answer' : 'Tap an option to vote'}</span>
            : <button type="button" onClick={() => setChosen(null)}>Retract vote</button>}
          <span>{time}</span>
        </div>
      </div>
    </div>
  );
}

function host(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
}
