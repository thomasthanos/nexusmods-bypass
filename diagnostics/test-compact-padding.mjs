import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto('http://127.0.0.1:55018');
  await page.waitForSelector('[data-growth-analytics]');

  // Solution A: Compact card with vertical centering of values in cards without notes
  await page.addStyleTag({
    content: `
      [data-growth-analytics] .growth-metric,
      [data-growth-store] .growth-metric {
        padding: 8px 6px 7px !important;
        border-radius: 13px !important;
      }
      [data-growth-analytics] .growth-metric-content,
      [data-growth-store] .growth-metric-content {
        height: 100% !important;
        display: flex !important;
        flex-direction: column !important;
      }
      [data-growth-analytics] .growth-label,
      [data-growth-store] .growth-label {
        margin-bottom: 2px !important;
      }
      [data-growth-analytics] .growth-value,
      [data-growth-store] .growth-value {
        margin-top: auto !important;
        margin-bottom: auto !important;
        line-height: 1.1 !important;
      }
      [data-growth-analytics] .growth-note,
      [data-growth-analytics] .growth-trend,
      [data-growth-store] .growth-note {
        margin-top: auto !important;
        line-height: 1.2 !important;
      }
    `
  });

  const analytics = page.locator('[data-growth-analytics]');
  await analytics.screenshot({ path: 'test-compact-analytics.png' });

  const store = page.locator('[data-growth-store]');
  await store.screenshot({ path: 'test-compact-store.png' });

  // Let's also measure heights
  const heights = await page.$$eval('[data-growth-analytics] .growth-metric', els => els.map(e => e.getBoundingClientRect().height));
  console.log('New card heights:', heights);

  await browser.close();
}

main().catch(console.error);
