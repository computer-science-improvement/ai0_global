/**
 * Spec 065 FR-002: a GitHub page address read as the file it stands for. A repository page is its README (the default
 * branch is not known without an API call, so `main` is tried, then `master`); a `blob` page is that file, raw.
 */
const RAW_HOST = 'raw.githubusercontent.com';

/** First path segments of github.com that are not owners. */
const NOT_OWNERS = new Set([
  'about', 'apps', 'codespaces', 'collections', 'contact', 'customer-stories', 'enterprise', 'events', 'explore', 'features', 'issues',
  'login', 'marketplace', 'new', 'notifications', 'orgs', 'organizations', 'pricing', 'pulls', 'search', 'security', 'settings',
  'sponsors', 'team', 'topics', 'trending',
]);

const isGithub = (host: string) => host === 'github.com' || host === 'www.github.com';

/**
 * Raw addresses to try, in order, for a GitHub repository / file page; null for any other address. Only the repository
 * page (with an optional `/tree/<branch>`) and `blob` / `raw` file pages are mapped.
 */
export function githubRawCandidates(url: string): string[] | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !isGithub(u.hostname.toLowerCase())) return null;
  const seg = u.pathname.split('/').filter(Boolean);
  if (seg.length < 2 || NOT_OWNERS.has(seg[0].toLowerCase())) return null;
  const [owner, rawRepo] = seg;
  const repo = rawRepo.replace(/\.git$/i, '');
  if (!repo) return null;
  const raw = (branch: string, path: string) => `https://${RAW_HOST}/${owner}/${repo}/${branch}/${path}`;
  if (seg.length === 2) return [raw('main', 'README.md'), raw('master', 'README.md')];
  if (seg.length === 4 && seg[2] === 'tree') {
    return [...new Set([raw(seg[3], 'README.md'), raw('main', 'README.md'), raw('master', 'README.md')])];
  }
  if ((seg[2] === 'blob' || seg[2] === 'raw') && seg.length >= 5) return [raw(seg[3], seg.slice(4).join('/'))];
  return null;
}

/** A markdown file by its address: raw GitHub content, or any path ending .md / .markdown / .mdx. */
export function isMarkdownPath(url: string): boolean {
  try { return /\.(?:md|markdown|mdx)$/i.test(new URL(url).pathname); } catch { return false; }
}

export const isRawGithub = (url: string): boolean => {
  try { return new URL(url).hostname.toLowerCase() === RAW_HOST; } catch { return false; }
};
