import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelHandle, formatPriceList, priceListReply, pricesForInquiry } from './ad-price-list';
import type { PublicAdPrice } from './ad-orders.types';

const PRICES: PublicAdPrice[] = [
  { channelKey: '@space_ua', format: 'post', priceUah: 1500, note: null },
  { channelKey: '@space_ua', format: 'pin_24h', priceUah: 2500, note: 'без видалення' },
  { channelKey: '@recipes_ua', format: 'post', priceUah: 800, note: null },
];

test('formatPriceList groups by channel with Ukrainian format labels', () => {
  const s = formatPriceList(PRICES);
  assert.match(s, /^@space_ua\n• рекламний пост: 1 500 грн\n• пост із закріпом на 24 год: 2 500 грн \(без видалення\)/);
  assert.match(s, /\n\n@recipes_ua\n• рекламний пост: 800 грн$/);
});

test('channelHandle normalizes @, t.me links and case', () => {
  assert.equal(channelHandle('@Space_UA'), 'space_ua');
  assert.equal(channelHandle('https://t.me/space_ua/12'), 'space_ua');
  assert.equal(channelHandle(' space_ua '), 'space_ua');
});

test('pricesForInquiry: the named channel only, otherwise everything', () => {
  assert.equal(pricesForInquiry(PRICES, 't.me/recipes_ua').length, 1);
  assert.equal(pricesForInquiry(PRICES, '@unknown').length, 3);
  assert.equal(pricesForInquiry(PRICES, undefined).length, 3);
});

test('priceListReply contains the price list, the ad label promise and a call to action', () => {
  const r = priceListReply(PRICES.slice(0, 1));
  assert.match(r, /1 500 грн/);
  assert.match(r, /#реклама/);
  assert.match(r, /підготую рахунок/);
});
