import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const baseUrl = process.env.BASE_URL || 'http://localhost:5188';
const outDir = path.resolve(process.cwd(), 'report-assets');
fs.mkdirSync(outDir, { recursive: true });

const shots = [
  { name: '01-home.png', url: `${baseUrl}/`, waitMs: 1200 }
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

for (const s of shots) {
  await page.goto(s.url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(s.waitMs ?? 500);
  await page.screenshot({ path: path.join(outDir, s.name), fullPage: true });
  // eslint-disable-next-line no-console
  console.log(`wrote ${s.name}`);
}

await browser.close();

