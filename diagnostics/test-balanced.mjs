import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto('http://127.0.0.1:55018');
  await page.waitForSelector('[data-growth-analytics]');

  // Test Solution:
  // 1. Sleeker card padding: 8px 5px
  // 2. .growth-metric-content has flex: 1, height: 100%, display: flex, flex-direction: column
  // 3. .growth-value has margin-top: auto; margin-bottom: auto;
  // 4. .growth-note / .growth-trend sits at the bottom with margin-top: auto;
  await page.addStyleTag({
    content: `
      [data-growth-analytics] .growth-metric,
      [data-growth-store] .growth-metric {
        padding: 8px 5px !important;
      }
      [data-growth-analytics] .growth-metric-content,
      [data-growth-store] .growth-metric-content {
        height: 100% !important;
        display: flex !important;
        flex-direction: column !important;
        justify-content: space-between !important;
      }
      [data-growth-analytics] .growth-value,
      [data-growth-store] .growth-value {
        margin-top: auto !important;
        margin-bottom: auto !important;
      }
      [data-growth-analytics] .growth-note,
      [data-growth-analytics] .growth-trend,
      [data-growth-store] .growth-note {
        margin-top: auto !important;
      }
    `
  });

  const analytics = page.locator('[data-growth-analytics]');
  await analytics.screenshot({ path: 'test-balanced-analytics.png' });

  const store = page.locator('[data-growth-store]');
  await store.screenshot({ path: 'test-balanced-store.png' });

  await browser.close();
  console.log('Balanced screenshots saved');
}

main().catch(console.error);
