import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = 'https://daytoday.ua';
const OUTPUT_DIR = path.join(__dirname, '..', '..', '..', 'data', 'normalized', 'daytoday');
const DELAY_MS = 500;
const REQUEST_TIMEOUT = 10000;
const PARALLEL_DETAIL_REQUESTS = 4;

const MONTHS = [
  { num: 1, slug: 'sichnia', name: 'Січень', days: 31 },
  { num: 2, slug: 'liutoho', name: 'Лютий', days: 29 },
  { num: 3, slug: 'bereznia', name: 'Березень', days: 31 },
  { num: 4, slug: 'kvitnia', name: 'Квітень', days: 30 },
  { num: 5, slug: 'travnia', name: 'Травень', days: 31 },
  { num: 6, slug: 'chervnia', name: 'Червень', days: 30 },
  { num: 7, slug: 'lypnia', name: 'Липень', days: 31 },
  { num: 8, slug: 'serpnia', name: 'Серпень', days: 31 },
  { num: 9, slug: 'veresnia', name: 'Вересень', days: 30 },
  { num: 10, slug: 'zhovtnya', name: 'Жовтень', days: 31 },
  { num: 11, slug: 'lystopada', name: 'Листопад', days: 30 },
  { num: 12, slug: 'hrudnia', name: 'Грудень', days: 31 },
];

let totalDaysProcessed = 0;
const TOTAL_DAYS = 366;

interface EventDetail {
  description: string;
  tags: string[];
  imageUrl: string;
}

interface Event {
  title: string;
  slug: string;
  excerpt: string;
  description: string;
  imageUrl: string;
  tags: string[];
}

interface Birthday {
  year: number;
  name: string;
}

interface DayData {
  day: number;
  month: number;
  date: string;
  events: Event[];
  nameDays: string[];
  birthdays: Birthday[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const response = await axios.get(url, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'uk,en;q=0.9',
      },
    });
    return response.data as string;
  } catch (err: any) {
    console.error(`  [ERROR] Failed to fetch ${url}: ${err.message}`);
    return null;
  }
}

async function fetchEventDetail(slug: string): Promise<EventDetail> {
  const url = `${BASE_URL}/podiya/${slug}/`;
  const html = await fetchPage(url);
  if (!html) return { description: '', tags: [], imageUrl: '' };

  const $ = cheerio.load(html);

  // Article body: .mec-event-content paragraphs
  const paragraphs: string[] = [];
  $('.mec-event-content p').each((_, el) => {
    const text = $(el).text().trim();
    if (text) paragraphs.push(text);
  });
  const fullText = paragraphs.join(' ');
  const description = fullText.substring(0, 500);

  // Tags: .mec-events-meta-group-tags a[rel="tag"]
  const tags: string[] = [];
  $('.mec-events-meta-group-tags a[rel="tag"]').each((_, el) => {
    const tag = $(el).text().trim();
    if (tag) tags.push(tag);
  });

  // Full-size image from detail page header
  const imgEl = $('.mec-events-event-image img').first();
  const imageUrl =
    imgEl.attr('src') ||
    imgEl.attr('data-src') ||
    '';

  return { description, tags, imageUrl };
}

async function scrapeDayPage(
  day: number,
  month: typeof MONTHS[0],
): Promise<DayData> {
  const dayStr = String(day).padStart(2, '0');
  const monthStr = String(month.num).padStart(2, '0');
  const url = `${BASE_URL}/${day}-${month.slug}/`;

  totalDaysProcessed++;
  console.log(
    `Scraping ${month.name} ${day}... (${totalDaysProcessed}/${TOTAL_DAYS}) — ${url}`,
  );

  const html = await fetchPage(url);

  const dayData: DayData = {
    day,
    month: month.num,
    date: `${monthStr}-${dayStr}`,
    events: [],
    nameDays: [],
    birthdays: [],
  };

  if (!html) return dayData;

  const $ = cheerio.load(html);

  // ---- EVENTS ----
  // Each .pt-cv-ifield is one event card (in the main events section, not imenyny/birthday sections)
  // The events section is identified by the first .pt-cv-wrapper on the page (before imenyny section)
  const eventSlugs: Array<{
    slug: string;
    title: string;
    excerpt: string;
    thumbnailUrl: string;
  }> = [];

  // Find the first pt-cv-wrapper which contains the events (not the imenyny/birthday ones)
  // We identify it by checking that it does NOT come after the imenyny h3
  // Simpler approach: collect all .pt-cv-ifield cards, skip those with -imenyny href
  $('.pt-cv-ifield').each((_, card) => {
    const $card = $(card);

    // Title and link from h3 > a
    const titleLink = $card.find('h3 a').first();
    const title = titleLink.text().trim();
    const href = titleLink.attr('href') || '';

    // Skip name day entries (links ending with -imenyny)
    if (href.includes('-imenyny')) return;

    // Skip birthday entries (title starts with a year)
    if (/^\d{4}/.test(title)) return;

    // Extract slug from href like https://daytoday.ua/podiya/some-slug/
    const slugMatch = href.match(/\/podiya\/([^/]+)\/?$/);
    if (!slugMatch) return;
    const slug = slugMatch[1];

    // Thumbnail: from img src on the day page (small thumbnail, will be replaced by detail page img)
    const imgEl = $card.find('img').first();
    const thumbnailUrl =
      imgEl.attr('src') ||
      imgEl.attr('data-src') ||
      '';

    // Excerpt: text from .pt-cv-content minus the "Детальніше" link text
    const excerptEl = $card.find('.pt-cv-content');
    const excerptClone = excerptEl.clone();
    excerptClone.find('.pt-cv-rmwrap').remove();
    const excerpt = excerptClone.text().trim();

    if (title && slug) {
      eventSlugs.push({ slug, title, excerpt, thumbnailUrl });
    }
  });

  // Fetch detail pages in small batches
  const events: Event[] = [];
  for (let i = 0; i < eventSlugs.length; i += PARALLEL_DETAIL_REQUESTS) {
    const batch = eventSlugs.slice(i, i + PARALLEL_DETAIL_REQUESTS);
    const detailResults = await Promise.all(
      batch.map(async (ev) => {
        await delay(DELAY_MS);
        const detail = await fetchEventDetail(ev.slug);
        return {
          title: ev.title,
          slug: ev.slug,
          excerpt: ev.excerpt,
          description: detail.description,
          // Prefer full-size image from detail page, fallback to thumbnail
          imageUrl: detail.imageUrl || ev.thumbnailUrl,
          tags: detail.tags,
        } as Event;
      }),
    );
    events.push(...detailResults);
  }

  dayData.events = events;

  // ---- NAME DAYS ----
  // The imenyny section has h3#imenyny, then .pt-cv-collapsible with .panel-title links
  const imenHdr = $('h3#imenyny');
  if (imenHdr.length) {
    // The section is the wp-block-column containing this h3
    const imenSection = imenHdr.parent();
    imenSection.find('a.panel-title').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (href.includes('-imenyny')) {
        const name = $(el).text().trim();
        if (name) dayData.nameDays.push(name);
      }
    });

    // Fallback: any links with -imenyny in section
    if (dayData.nameDays.length === 0) {
      imenSection.find('a[href*="-imenyny"]').each((_, el) => {
        const name = $(el).text().trim();
        if (name && name !== 'Детальніше') dayData.nameDays.push(name);
      });
    }
  }

  // ---- BIRTHDAYS ----
  // h3#dni-narodzhennya section, panel-title links with text like "1845 – Name"
  const bdayHdr = $('h3#dni-narodzhennya');
  if (bdayHdr.length) {
    const bdaySection = bdayHdr.parent();
    bdaySection.find('a.panel-title').each((_, el) => {
      const text = $(el).text().trim();
      // Pattern: "1845 – Вільгельм Конрад Рентген"
      const match = text.match(/^(\d{4})\s*[–—\-]\s*(.+)$/);
      if (match) {
        dayData.birthdays.push({
          year: parseInt(match[1], 10),
          name: match[2].trim(),
        });
      }
    });

    // Fallback: try all links in the section
    if (dayData.birthdays.length === 0) {
      bdaySection.find('a').each((_, el) => {
        const text = $(el).text().trim();
        const match = text.match(/^(\d{4})\s*[–—\-]\s*(.+)$/);
        if (match) {
          dayData.birthdays.push({
            year: parseInt(match[1], 10),
            name: match[2].trim(),
          });
        }
      });
    }
  }

  return dayData;
}

async function main() {
  // Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log(`Starting daytoday.ua scraper...`);
  console.log(`Output directory: ${OUTPUT_DIR}`);
  console.log(`Total days to scrape: ${TOTAL_DAYS}`);
  console.log('');

  for (const month of MONTHS) {
    console.log(`\n=== Processing ${month.name} (${month.days} days) ===`);

    const monthData = {
      month: month.num,
      monthName: month.name,
      days: [] as DayData[],
    };

    for (let day = 1; day <= month.days; day++) {
      // Delay between day page requests
      if (day > 1) await delay(DELAY_MS);

      try {
        const dayData = await scrapeDayPage(day, month);
        monthData.days.push(dayData);
        console.log(
          `  -> ${dayData.events.length} events, ${dayData.nameDays.length} name days, ${dayData.birthdays.length} birthdays`,
        );
      } catch (err: any) {
        console.error(
          `  [ERROR] Failed to scrape ${month.name} ${day}: ${err.message}`,
        );
        monthData.days.push({
          day,
          month: month.num,
          date: `${String(month.num).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
          events: [],
          nameDays: [],
          birthdays: [],
        });
      }
    }

    // Save month file immediately after completing the month
    const monthNumStr = String(month.num).padStart(2, '0');
    const monthFileName = `${monthNumStr}-${month.slug}.json`;
    const outputPath = path.join(OUTPUT_DIR, monthFileName);
    fs.writeFileSync(outputPath, JSON.stringify(monthData, null, 2), 'utf-8');
    console.log(`\nSaved: ${outputPath}`);
  }

  console.log('\nScraping complete!');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
