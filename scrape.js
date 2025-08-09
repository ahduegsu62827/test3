const puppeteer = require('puppeteer');

async function scrapeApkpureData(url) {
  let browser;
  try {
    // Launch headless browser
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36']
    });
    const page = await browser.newPage();

    // Set additional headers
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': 'https://apkpure.com/'
    });

    // Navigate to the URL
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Extract appId from URL
    const appId = url.match(/\/([^/]+)\/download$/)?.[1] || 'Not found';

    // Extract app size
    const appSize = await page.evaluate(() => {
      const sizeElement = document.querySelector('ul.dev-partnership-head-info li div.head');
      return sizeElement ? sizeElement.textContent.trim() : 'Not found';
    });

    // Extract app version
    const appVersion = await page.evaluate(() => {
      const sizeElement = document.querySelector('span.version-name');
      return sizeElement ? sizeElement.textContent.trim() : 'Not found';
    });

    // Extract required Android version
    const requiresAndroid = await page.evaluate(() => {
      const elements = document.querySelectorAll('div.more-information-container ul li div.info div.value.double-lines');
      for (const element of elements) {
        const label = element.parentElement.querySelector('div.label.one-line')?.textContent.trim();
        if (label === 'Requires Android') {
          const fullText = element.textContent.trim();
          // Extract only the version number (e.g., "9.0+" from "Android 9.0+ (P, API 28)")
          const match = fullText.match(/(\d+\.\d+\+)/);
          return match ? match[1] : 'Not found';
        }
      }
      return 'Not found';
    });

    // Return scraped data
    return {
      appId: appId,  
      appSize: appSize,
      requires_android: requiresAndroid,
      appVersion: appVersion,
    };

  } catch (error) {
    console.error(`Error scraping ${url}: ${error.message}`);
    return null;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Test the function with the example link
(async () => {
  const url = 'https://apkpure.com/tiktok-musically-2024/com.zhiliaoapp.musically/download';
  const result = await scrapeApkpureData(url);

  if (result) {
    console.log(`App ID: ${result.appId}`);
    console.log(`App Size: ${result.appSize}`);
    console.log(`Requires Android: ${result.requires_android}`);
    console.log(`App Version: ${result.appVersion}`);
  } else {
    console.log('Failed to scrape data.');
  }
})();
