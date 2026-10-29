// Spec 076 FR-009 (A13): "Upload the page" for a site the server cannot open. The owner saves the page in a browser
// (Save Page As, "Webpage, HTML only") and gives it here under the address it came from, as a file or as pasted text.
// A file is read as bytes and decoded in the charset the page declares (lib/page-charset.ts), so a windows-1251 page
// keeps its letters. With a dataset chosen the upload re-syncs that dataset at once; without one the page is kept for 7
// days and the chat's `import_list` takes it. Styles: agents/agent-settings.css (ast-).

import { useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Modal } from '../Modal';
import { SegmentedTabs } from '../SegmentedTabs';
import { Field } from '../ui/primitives';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/Toast';
import { useDatasets } from '../../api/data';
import { isResync, useUploadPage, type UploadedPage } from '../../api/sources';
import { contentTypeOf, decodePageBytes } from '../../lib/page-charset';
import { contentProblem, fileSizeText, isHttpUrl, UPLOAD_FILE_MAX_BYTES, urlProblem } from '../../lib/source-probe';

type Mode = 'file' | 'paste';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The address the page was saved from, when the dialog opens from a source row. */
  initialUrl?: string;
  /** A dataset to re-sync with the page (the Data page's list import). */
  initialDataset?: string;
}

interface Picked { name: string; bytes: number; text: string; charset: string }

const ACCEPT = '.html,.htm,.xhtml,.txt,.md,.markdown,text/html,text/plain,text/markdown';

export function UploadPageDialog({ open, onClose, initialUrl = '', initialDataset = '' }: Props) {
  const datasets = useDatasets();
  const upload = useUploadPage();
  const navigate = useNavigate();
  const [url, setUrl] = useState(initialUrl);
  const [mode, setMode] = useState<Mode>('file');
  const [picked, setPicked] = useState<Picked | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [dataset, setDataset] = useState(initialDataset);
  const [kept, setKept] = useState<UploadedPage | null>(null);
  const reading = useRef(0);

  const text = mode === 'file' ? picked?.text ?? '' : pasted;
  const pasteProblem = mode === 'paste' ? contentProblem({ text: pasted }) : null;
  const problem = mode === 'file' ? fileProblem : pasteProblem;
  const addressProblem = urlProblem(url);
  const canSend = isHttpUrl(url) && text.trim().length > 0 && !problem && !upload.isPending;

  const pick = async (file: File | undefined) => {
    const token = ++reading.current;
    setPicked(null);
    setFileProblem(null);
    if (!file) return;
    if (file.size > UPLOAD_FILE_MAX_BYTES) { setFileProblem(contentProblem({ fileBytes: file.size, text: '' })); return; }
    try {
      const { text: decoded, charset } = decodePageBytes(new Uint8Array(await file.arrayBuffer()));
      if (token !== reading.current) return;
      const tooBig = contentProblem({ text: decoded });
      if (tooBig) setFileProblem(tooBig);
      else setPicked({ name: file.name, bytes: file.size, text: decoded, charset });
    } catch {
      if (token === reading.current) setFileProblem('The file could not be read. Choose it again.');
    }
  };

  const send = () => {
    const content_type = contentTypeOf(mode === 'file' ? picked?.name ?? null : null, text);
    upload.mutate(
      { url: url.trim(), content: text, content_type, ...(dataset ? { dataset } : {}) },
      {
        onSuccess: (r) => {
          if (isResync(r)) {
            toast.success(
              `${r.dataset}: ${r.inserted} new, ${r.updated} changed${r.invalid ? `, ${r.invalid} invalid` : ''}${r.note ? `. ${r.note}` : ''}`,
              { action: { label: 'Open dataset', onClick: () => void navigate({ to: '/app/data/$key', params: { key: r.dataset }, search: {} }) } },
            );
            onClose();
          } else {
            setKept(r);
          }
        },
      },
    );
  };

  const close = () => { reading.current++; onClose(); };

  if (kept) {
    return (
      <Modal open={open} onClose={close} title="Page uploaded" subtitle={kept.url} icon="database" size="md">
        <div className="ast-up-result">
          <div className="callout-success" role="status">
            The server keeps this page for 7 days. Import it into a dataset from the chat.
          </div>
          <div className="inset ast-facts is-roomy">
            {kept.title && (
              <div className="ast-fact is-wide"><span className="text-overline">Title</span><div className="ast-fact-value">{kept.title}</div></div>
            )}
            <div className="ast-fact"><span className="text-overline">Sections</span><div className="ast-fact-value mono">{kept.sections}</div></div>
            <div className="ast-fact"><span className="text-overline">Characters</span><div className="ast-fact-value mono">{kept.chars.toLocaleString('en-GB')}</div></div>
            <div className="ast-fact is-wide"><span className="text-overline">Page id</span><div className="ast-fact-value mono">{kept.doc_id}</div></div>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" onClick={close}>Close</button>
          <Link
            to="/app/chat"
            search={{ q: `Import the uploaded page ${kept.doc_id} (${kept.url}) with import_list` }}
            className="btn-primary"
            onClick={close}
          >
            <Icon name="chat" size={14} /> Continue in chat
          </Link>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={close} title="Upload a saved page" subtitle="For a site the server cannot open" icon="database" size="md">
      <Field label="Page address" hint="the address the page was saved from">
        <input className="input-field mono ast-fill" value={url} placeholder="https://example.com/page" inputMode="url" autoComplete="off"
          aria-label="Page address" aria-invalid={!!addressProblem} onChange={(e) => setUrl(e.target.value)} />
        {addressProblem && <div className="text-micro ast-error">{addressProblem}</div>}
      </Field>

      <Field label="The page">
        <SegmentedTabs<Mode> value={mode} onChange={setMode} ariaLabel="How to give the page"
          options={[{ key: 'file', label: 'A saved file' }, { key: 'paste', label: 'Pasted text' }]} />
      </Field>

      {mode === 'file' ? (
        <Field label="File" hint="HTML, text or markdown, up to 5 MB">
          <input type="file" accept={ACCEPT} className="input-field ast-fill" aria-label="Saved page file"
            onChange={(e) => void pick(e.target.files?.[0])} />
          {picked && (
            <div className="text-micro mono ast-dim ast-under">
              {picked.name} · {fileSizeText(picked.bytes)} · read as {picked.charset}
            </div>
          )}
          <div className="text-micro ast-dim ast-under">In the browser: File, Save Page As, format "Webpage, HTML only".</div>
        </Field>
      ) : (
        <Field label="Text" hint="the page's HTML, or its text">
          <textarea className="input-field ast-fill ast-paste" value={pasted} spellCheck={false} aria-label="Pasted page text"
            placeholder="Paste the page here" onChange={(e) => setPasted(e.target.value)} />
        </Field>
      )}
      {problem && <div className="callout-danger" role="alert" style={{ marginBottom: 16 }}>{problem}</div>}

      <Field label="Re-sync a dataset" hint="optional">
        <select className="input-field ast-fill" value={dataset} aria-label="Dataset to re-sync" onChange={(e) => setDataset(e.target.value)}>
          <option value="">None: keep the page for the chat</option>
          {(datasets.data ?? []).filter((d) => d.status !== 'archived').map((d) => <option key={d.key} value={d.key}>{d.title} ({d.key})</option>)}
        </select>
        <div className="text-micro ast-dim ast-under">
          A dataset that was imported from this address is re-synced from the page at once. Without one the page waits in the chat for 7 days.
        </div>
      </Field>

      <div className="modal-foot">
        <button type="button" className="btn-ghost" onClick={close}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!canSend} onClick={send}>
          <Icon name="arrow-up" size={14} /> {upload.isPending ? 'Uploading…' : dataset ? 'Upload and re-sync' : 'Upload'}
        </button>
      </div>
    </Modal>
  );
}
