import * as cheerio from 'cheerio';

/**
 * Load HTML into Cheerio and scrape by selectors.
 * @param {string} html - Raw HTML string
 * @param {object} selectors - Map of names to CSS selectors, e.g. { items: '.item', title: 'h2' }
 * @returns {object} Scraped data: { items: [...], ... } where each item has keys from selectors (except 'items')
 */
export function scrapeBySelectors(html, selectors) {
  const $ = cheerio.load(html);
  const { items: itemsSelector, ...fieldSelectors } = selectors;

  if (!itemsSelector) {
    const single = {};
    for (const [key, selector] of Object.entries(fieldSelectors)) {
      const el = $(selector).first();
      single[key] = key === 'link' || key === 'href' ? el.attr('href')?.trim() : el.text().trim();
    }
    return single;
  }

  const items = [];
  $(itemsSelector).each((_, el) => {
    const item = {};
    const $el = $(el);
    for (const [key, selector] of Object.entries(fieldSelectors)) {
      const target = selector === '' || selector == null ? $el : $el.find(selector).first();
      const isLink = key === 'link' || key === 'href';
      item[key] = isLink ? target.attr('href')?.trim() : target.text().trim();
    }
    items.push(item);
  });

  return { items };
}
