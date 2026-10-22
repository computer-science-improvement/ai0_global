/**
 * Spec 066 FR-005: a trimmed copy of the shape of https://prompts.chat/api/prompts (fetched 2026-10-22): two pages of five
 * records in mixed types (TEXT / TASTE / SKILL / IMAGE / VIDEO), the root `{ prompts, total, page, perPage, totalPages }`,
 * nested `author` and `category` (null for one record, a name-less author for another), `tags[].tag.name`, `mediaUrl`
 * null and set, and prompts with line breaks. Texts are cut to a few lines; the shape is the original's.
 */
export const PROMPTSCHAT_URL = 'https://prompts.chat/api/prompts?perPage=5';
export const promptschatPageUrl = (n: number): string => (n === 1 ? PROMPTSCHAT_URL : `${PROMPTSCHAT_URL}&page=${n}`);

const author = (name: string | null, username: string) => ({ id: `u_${username}`, name, username, verified: false });
const category = (name: string, slug: string) => ({ id: `c_${slug}`, name, slug, description: null, icon: null, order: 1, pinned: false, parentId: null });
const tags = (...names: string[]) => names.map((n) => ({ promptId: 'p', tagId: `tag_${n.toLowerCase()}`, tag: { id: `tag_${n.toLowerCase()}`, name: n, slug: n.toLowerCase(), color: '#6366f1' } }));

interface Rec { id: string; title: string; slug: string; type: string; content: string; description: string | null; mediaUrl: string | null; author: unknown; category: unknown; tags: unknown[]; voteCount: number }

const rec = (r: Rec) => ({
  id: r.id, title: r.title, slug: r.slug, description: r.description, content: r.content, type: r.type, mediaUrl: r.mediaUrl,
  viewCount: 0, createdAt: '2026-10-22T07:13:06.537Z', isFeatured: false, requiredMediaType: null, author: r.author, category: r.category,
  tags: r.tags, _count: { votes: r.voteCount, contributors: 0 }, voteCount: r.voteCount,
});

const MEDIA = 'https://prompts-chat-space.example.com/prompt-media';

const PAGE_1 = [
  rec({ id: 'cmv_sarcasm', title: 'Sarcasm', slug: 'sarcasm', type: 'TEXT', description: 'Be a smart ass', mediaUrl: null,
    content: 'I will provide comments. I may offer my own views on those comments.\nRespond with sarcasm: dry, short, never cruel.',
    author: author('Robert Roquet', 'bobroquet'), category: category('Writing', 'writing'), tags: [], voteCount: 3 }),
  rec({ id: 'cmv_a11y', title: 'Web Accessibility taste', slug: 'web-accessibility-taste', type: 'TASTE', description: 'Opinionated preferences for accessible web interfaces', mediaUrl: null,
    content: '# Web Accessibility taste of a frontend engineer\n- Use semantic HTML first\n- Never remove focus outlines', author: author('Fatih Kadir Akın', 'f'),
    category: category('Coding', 'coding'), tags: tags('Accessibility', 'Frontend'), voteCount: 0 }),
  rec({ id: 'cmv_paint', title: 'Room Paint Quantity Estimator', slug: 'room-paint-quantity-estimator', type: 'SKILL', description: 'Works out how much paint to buy', mediaUrl: null,
    content: '---\nname: room-paint-quantity-estimator\ndescription: Works out how much paint to buy.\n---\nAsk for the room sizes, then compute litres per coat.',
    author: author('Fatih Kadir Akın', 'f'), category: category('Agent Skill', 'skill'), tags: tags('DIY', 'Budgeting'), voteCount: 1 }),
  rec({ id: 'cmv_puffin', title: 'Photoreal Atlantic Puffin Colony on a Sea Cliff at Golden Hour', slug: 'photoreal-atlantic-puffin-colony', type: 'IMAGE', description: 'Photoreal telephoto wildlife shot',
    mediaUrl: `${MEDIA}/puffins.jpg`, content: 'A photoreal wildlife photograph of a small colony of Atlantic puffins on a grassy sea cliff at golden hour, 400mm telephoto, shallow depth of field.',
    author: author('Fatih Kadir Akın', 'f'), category: category('Image Generation', 'image-generation'), tags: tags('Photography', 'Realism', 'Travel'), voteCount: 5 }),
  rec({ id: 'cmv_vault', title: 'Prompt Vault Manager', slug: 'prompt-vault-manager', type: 'TEXT', description: 'A strict, versioned, markdown-first vault', mediaUrl: null,
    content: 'You are the Prompt Vault Manager.\n\nYou are the working record of every prompt the user keeps.', author: author(null, 'dillonbowen123'),
    category: category('Agent Skill', 'skill'), tags: tags('Prompt Engineering'), voteCount: 0 }),
];

const PAGE_2 = [
  rec({ id: 'cmv_maki', title: 'Japanese Maki-e Gold Lacquer Panel of Moon-Viewing Rabbits', slug: 'japanese-maki-e-gold-lacquer-panel', type: 'IMAGE', description: 'Japanese maki-e lacquer panel',
    mediaUrl: `${MEDIA}/maki-e.jpg`, content: 'A wide Japanese maki-e lacquer panel showing two white rabbits under a full autumn moon, gold dust on black urushi.',
    author: author('Fatih Kadir Akın', 'f'), category: category('Image Generation', 'image-generation'), tags: tags('Art', 'History'), voteCount: 2 }),
  rec({ id: 'cmv_video', title: 'Company Introduction', slug: 'company-introduction', type: 'VIDEO', description: null, mediaUrl: null,
    content: 'Act as video editor and create a company introduction video from the three clips provided.', author: author('Yukiko Nguyen', 'duyennguyen5593'),
    category: null, tags: [], voteCount: 0 }),
  rec({ id: 'cmv_redis', title: 'Redis Caching taste', slug: 'redis-caching-taste', type: 'TASTE', description: 'Opinionated conventions for using Redis as a cache', mediaUrl: null,
    content: '# Redis Caching taste of a backend engineer\n- Default to cache-aside\n- Every key has a TTL', author: author('Fatih Kadir Akın', 'f'),
    category: category('Coding', 'coding'), tags: tags('Caching', 'Backend'), voteCount: 0 }),
  rec({ id: 'cmv_disk', title: 'Disk Capacity Runway Forecaster', slug: 'disk-capacity-runway-forecaster', type: 'SKILL', description: 'Forecasts when disks will fill up', mediaUrl: null,
    content: '---\nname: disk-capacity-runway-forecaster\n---\nFit a line to the usage samples and report the day the volume is full.', author: author('Fatih Kadir Akın', 'f'),
    category: category('Agent Skill', 'skill'), tags: tags('Monitoring', 'SRE'), voteCount: 0 }),
  rec({ id: 'cmv_linux', title: 'Linux Terminal', slug: 'linux-terminal', type: 'TEXT', description: 'Act as a Linux terminal', mediaUrl: null,
    content: 'I want you to act as a Linux terminal.\nI will type commands and you will reply with what the terminal should show.\n\nMy first command is pwd.',
    author: author('Fatih Kadir Akın', 'f'), category: category('Coding', 'coding'), tags: tags('Linux'), voteCount: 9 }),
];

/** The answer of page `n` (1 or 2). */
export const promptschatPage = (n: number): Record<string, unknown> => ({ prompts: n === 1 ? PAGE_1 : PAGE_2, total: 10, page: n, perPage: 5, totalPages: 2 });

/** Titles of the TEXT and IMAGE records, in page order: what `where: { type: ['TEXT', 'IMAGE'] }` keeps. */
export const PROMPTSCHAT_TEXT_IMAGE_TITLES = [
  'Sarcasm', 'Photoreal Atlantic Puffin Colony on a Sea Cliff at Golden Hour', 'Prompt Vault Manager',
  'Japanese Maki-e Gold Lacquer Panel of Moon-Viewing Rabbits', 'Linux Terminal',
];
