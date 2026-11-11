// End-to-end check in an emulated iPhone. Runs in GitHub Actions (needs internet for the CDN libraries).
const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');
const out = path.join(__dirname, '..', 'shots');
fs.mkdirSync(out, { recursive: true });
const log = [];
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=' + path.join(__dirname, 'plate.mjpeg')] });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], permissions: ['camera'] });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => log.push('pageerror: ' + e.message));
  const shot = (n) => page.screenshot({ path: path.join(out, n + '.png') });
  const step = async (name, fn) => { try { await fn(); log.push('OK ' + name); } catch (e) { log.push('FAIL ' + name + ': ' + e.message); await shot('fail-' + name).catch(() => {}); } };

  await page.goto('http://localhost:8000/');
  await step('home', async () => { await page.waitForSelector('#home:not([hidden])'); await page.waitForTimeout(800); await shot('01-home'); });
  await step('settings', async () => {
    await page.click('[aria-label="Inställningar"]');
    await page.fill('#setName', 'Peter');
    await shot('02-settings');
    await page.click('#saveSettings');
    await page.waitForSelector('#greeting:not([hidden])');
    await shot('03-home-greeting');
  });
  await step('lift-file', async () => {
    await page.click('.home-btn.lift');
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#dataStatus')]);
    await fc.setFiles(path.join(__dirname, 'demo.xlsx'));
    await page.waitForSelector('#dataStatus .dot.ok', { timeout: 15000 });
    await page.waitForTimeout(1500);
    await shot('04-lift');
  });
  await step('lift-ocr', async () => {
    await page.waitForSelector('#result:not([hidden])', { timeout: 90000 });
    await page.waitForTimeout(600);
    await shot('05-result');
    await page.evaluate(() => document.querySelector('#resBody').scrollTo(0, 2000));
    await shot('05b-result-scrolled');
  });
  await step('lift-search', async () => {
    if (!(await page.isVisible('#result'))) {
      await page.fill('#liftQuery', 'ABC123'); await page.click('#liftSearch button');
      await page.waitForSelector('#result:not([hidden])');
    }
  });
  await step('customer', async () => {
    await page.click('.cust-row'); await page.waitForSelector('#customer:not([hidden])'); await shot('06-customer');
    await page.click('#customer [data-back]'); await page.waitForSelector('#result:not([hidden])');
  });
  await step('order', async () => {
    await page.click('#newOrderBtn').catch(() => {});
    if (!(await page.isVisible('#order'))) await page.evaluate(() => go('order'));
    await page.fill('#kmInput', '84500');
    await page.click('#ordBody .card.svc:nth-of-type(3) .stepper button:last-child');
    await shot('07-order');
    await page.click('#saveOrder');
    await page.waitForSelector('#lift:not([hidden])', { timeout: 5000 });
    await shot('08-after-save');
  });
  await step('orders', async () => {
    await page.click('#lift [aria-label="Ordrar"]'); await page.waitForSelector('#orders:not([hidden])'); await shot('09-orders');
    await page.click('#orders [data-back]');
  });
  await step('queue', async () => {
    await page.evaluate(() => { history.replaceState({ s: 'home', depth: 0 }, '', '#home'); show('home'); });
    await page.click('.home-btn.reception'); await page.waitForSelector('#queue:not([hidden])'); await shot('10-queue-empty');
    // first car by camera
    await page.click('#fab');
    await page.waitForSelector('#job:not([hidden])', { timeout: 90000 });
    await page.click('#jobBody .jobcard:nth-child(3) .jobrow');
    await page.click('#jobBody .jobcard:nth-child(4) .jobrow');
    await page.click('.punct button:last-of-type');
    await page.click('.leave');
    await page.fill('#phoneIn', '701234567');
    await shot('11-job');
    await page.click('#addQueue');
    await page.waitForSelector('#queue:not([hidden])');
    // second car typed, foreign
    await page.click('#fab');
    await page.click('[data-cc="foreign"]');
    await page.fill('#ccInput', 'D');
    await page.fill('#manualPlate', 'HH AB 1234');
    await shot('12-rscan');
    await page.click('#manualForm button[type=submit]');
    await page.waitForSelector('#job:not([hidden])');
    await page.click('#jobBody .jobcard:nth-child(2) .jobrow');
    await page.click('#addQueue');
    await page.waitForSelector('#queue:not([hidden])');
    await shot('13-queue');
  });
  await step('hold-move', async () => {
    const card = page.locator('.qcard').nth(1);
    const b = await card.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down(); await page.waitForTimeout(3300); await page.mouse.up();
    await page.waitForSelector('#moveBanner:not([hidden])');
    await shot('14-move');
    await page.click('[aria-label="Flytta upp"]');
    await page.click('#moveDone');
    await shot('15-moved');
    await page.locator('.qcard').first().click();
    await page.waitForSelector('#modal:not([hidden])');
    await shot('16-menu');
  });
  fs.writeFileSync(path.join(out, 'log.txt'), log.join('\n'));
  console.log(log.join('\n'));
  await browser.close();
})();
