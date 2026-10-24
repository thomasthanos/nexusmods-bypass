import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto('http://127.0.0.1:55018');
  await page.waitForSelector('[data-growth-analytics]');

  const cards = await page.$$eval('[data-growth-analytics] .growth-metric', els => {
    return els.map((el, i) => {
      const rect = el.getBoundingClientRect();
      const content = el.querySelector('.growth-metric-content');
      const label = el.querySelector('.growth-label');
      const val = el.querySelector('.growth-value');
      const note = el.querySelector('.growth-note') || el.querySelector('.growth-trend');
      return {
        cardIndex: i,
        cardHeight: rect.height,
        cardPadding: window.getComputedStyle(el).padding,
        labelHeight: label ? label.getBoundingClientRect().height : 0,
        valHeight: val ? val.getBoundingClientRect().height : 0,
        noteVisible: note && window.getComputedStyle(note).display !== 'none',
        noteHeight: note && window.getComputedStyle(note).display !== 'none' ? note.getBoundingClientRect().height : 0
      };
    });
  });

  console.log('Cards measurement:\n', JSON.stringify(cards, null, 2));
  await browser.close();
}

main().catch(console.error);
