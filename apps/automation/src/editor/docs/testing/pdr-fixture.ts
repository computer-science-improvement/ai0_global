/**
 * Spec 070 FR-001: a synthetic page in the shape of the road rules on zakon.rada.gov.ua (the real page is one 270 KB
 * section; this one is a few KB). The wording is made up — what matches the original is the structure that `split_on`
 * has to cope with:
 *   - a preamble of numbered resolution items («1. Затвердити…») that is not a clause;
 *   - section titles on a line of their own («1. ЗАГАЛЬНІ ПОЛОЖЕННЯ», «14. ОБГІН»), no clause key;
 *   - clauses «1.1.», «1.6.», «1.10.», «8.7.3.», «14.6.» with editorial notes in braces: `{Пункт … в редакції …}`;
 *   - a clause (1.10) that is a list of terms;
 *   - a sign line without a trailing dot («1.1 «Небезпечний поворот»») that stays inside the clause above it;
 *   - a section of signs whose items repeat the keys of the clauses («1.1.»);
 *   - two footer sections (h2) that must not join the last clause.
 */
export const PDR_URL = 'https://zakon.rada.gov.ua/laws/show/1306-2001-%D0%BF/print';

export const PDR_HTML = `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><title>Про Правила дорожнього руху (синтетичний приклад)</title></head>
<body><div id="law">
<p>КАБІНЕТ МІНІСТРІВ УКРАЇНИ ПОСТАНОВА</p>
<p>1. Затвердити Правила дорожнього руху, що додаються.</p>
<p>2. Установити, що ці Правила набирають чинності з дня опублікування.</p>
<p>Правила дорожнього руху</p>
<p>1. ЗАГАЛЬНІ ПОЛОЖЕННЯ</p>
<p>1.1. Ці Правила встановлюють єдиний порядок дорожнього руху на всій території держави.</p>
<p>{Пункт 1.1 в редакції Постанови КМ N 111 від 01.02.2010}</p>
<p>1.2. Правила поширюються на всіх учасників дорожнього руху.</p>
<p>1.6. Учасники дорожнього руху зобов'язані:</p>
<p>{Пункт 1.6 в редакції Постанови КМ N 222 від 02.03.2015}</p>
<p>а) знати і виконувати вимоги Правил;</p>
<p>б) не створювати небезпеки та перешкод для руху.</p>
<p>1.10. У цих Правилах терміни вживаються в такому значенні:</p>
<p>{Пункт 1.10 доповнено абзацом згідно з Постановою КМ N 333 від 03.04.2018}</p>
<ul>
<li>- автомагістраль — дорога з розділювальною смугою, позначена відповідним знаком;</li>
<li>- водій — особа, яка керує транспортним засобом;</li>
<li>- перехрестя — місце перетину доріг на одному рівні.</li>
</ul>
<p>8. РЕГУЛЮВАННЯ ДОРОЖНЬОГО РУХУ</p>
<p>8.7.3. Червоний сигнал світлофора забороняє рух.</p>
<p>1.1 «Небезпечний поворот» — знак попереджає про закруглення дороги.</p>
<p>14. ОБГІН</p>
<p>14.1. Перед початком обгону водій повинен переконатися, що смуга зустрічного руху вільна.</p>
<p>14.6. Обгін заборонено:</p>
<p>{Пункт 14.6 в редакції Постанови КМ N 444 від 05.06.2020}</p>
<p>а) на регульованих перехрестях;</p>
<p>б) на пішохідних переходах;</p>
<p>в) на залізничних переїздах.</p>
<p>33. ДОРОЖНІ ЗНАКИ</p>
<p>1.1. Небезпечний поворот. Встановлюють перед закругленням дороги.</p>
</div>
<h2>Документи та файли</h2>
<p>Завантажити текст документа (синтетичний приклад)</p>
<h2>Публікації документа</h2>
<p>Офіційний вісник України, 2001, N 41 (синтетичний приклад)</p>
</body></html>`;

/** The owner's mapping for the road rules (runbook § 29). */
export const PDR_SPLIT_ON = '^([0-9]{1,2}[.][0-9]{1,2}(?:[.][0-9]{1,2})?)[.]';
export const PDR_SECTION_LINE = '^[0-9]{1,2}[.] [^.]{3,60}$';
export const PDR_MAPPING = {
  clause: 'split_key',
  title: 'heading',
  text: 'text_without:^\\{',
  category: `context_line:${PDR_SECTION_LINE}`,
  source_url: 'url_anchor:п.',
  license: 'const:public domain',
};
