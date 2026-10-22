/**
 * Spec 065: a fetched document kept whole. Offsets index `StoredDoc.text`; a section runs from its heading to the next
 * heading of any level, so the sections tile the text (an optional intro first).
 */
export interface DocImage { src: string; alt: string; at: number }
export interface DocLink { text: string; url: string; at: number }
/** A fenced code block: `start`/`end` cover the fences, `text` is what is inside them. */
export interface DocCodeBlock { lang: string; text: string; start: number; end: number }

export interface DocSection {
  id:          string;
  heading:     string;
  level:       number;
  start:       number;
  end:         number;
  images:      DocImage[];
  links:       DocLink[];
  code_blocks: DocCodeBlock[];
}

export type DocKind = 'html' | 'markdown' | 'text';

/** What a parser hands over before the store gives sections their ids. */
export type RawSection = Omit<DocSection, 'id'>;

export interface StoredDoc {
  id:           string;
  /** The address asked for (a GitHub repo page stays as typed). */
  url:          string;
  /** Where the body came from, when that is not `url` (raw.githubusercontent.com for a GitHub page). */
  fetched_url:  string | null;
  /** The URL after redirects of the page that was read. */
  final_url:    string;
  kind:         DocKind;
  title:        string | null;
  description:  string | null;
  image:        string | null;
  images:       string[];
  published_at: string | null;
  primary_links?: string[];
  text:         string;
  sections:     DocSection[];
  fetched_at:   number;
}
