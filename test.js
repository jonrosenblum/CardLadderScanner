import { connect } from "puppeteer-real-browser";

async function extractTokens(page) {
  return new Promise((resolve) => {
    const tokens = {};

    page.on('requestfinished', async request => {
      try {
        const url = request.url();
        const method = request.method();

        // Skip preflight OPTIONS requests
        if (method === 'OPTIONS') {
          return;
        }

        const headers = request.headers();

        // Look for Firebase AppCheck token
        if (url.includes('identitytoolkit.googleapis.com/v1/accounts:signInWithPassword')) {
          const firebaseAppCheck = headers['x-firebase-appcheck'];
          if (firebaseAppCheck && !tokens.firebaseAppCheck) {
            tokens.firebaseAppCheck = firebaseAppCheck;
            console.log('✅ Found Firebase AppCheck token.');
          }
        }

        // Look for CardLadder Authorization token
        if (url.includes('search-zzvl7ri3bq-uc.a.run.app/search')) {
          const cardladderAuthToken = headers['authorization'];
          if (cardladderAuthToken && !tokens.cardladderAuthToken) {
            tokens.cardladderAuthToken = cardladderAuthToken;
            console.log('✅ Found CardLadder Auth token.');
          }
        }

        // If both tokens found, resolve
        if (tokens.firebaseAppCheck && tokens.cardladderAuthToken) {
          resolve(tokens);
        }

      } catch (err) {
        console.warn('⚠️ Failed to extract token from request:', err.message);
      }
    });
  });
}

async function loginAndExtractTokens() {
  const { browser, page } = await connect({
    headless: true,
    args: [],
    customConfig: {},
    turnstile: true,
    connectOption: {},
    disableXvfb: false,
    ignoreAllFlags: false
  });

  await page.setViewport({
    width: 1366,
    height: 768,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  });

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function performLogin() {
    await page.screenshot({ path: 'login.png' });
    console.log('Waiting for email field...');
    await page.waitForSelector('#email', { timeout: 10000 });

    await delay(1000);
    await page.type('#email', 'jon.m.rosenblum@gmail.com');

    await delay(1000);
    await page.type('#password', 'Jnrsnblm12!');

    await delay(1000);
    await page.click('button.btn.primary.block');
    console.log('Clicked login button.');

    await delay(10000);

    const currentUrl = page.url();
    if (currentUrl.includes('login')) {
      console.log('Login failed, reloading...');
      await page.reload({ waitUntil: 'networkidle2' });
      await performLogin();
    } else {
      console.log('Login successful! Current URL:', currentUrl);
    }
  }

  try {
    console.log('Navigating to login page...');
    await page.goto('https://app.cardladder.com/login', { waitUntil: 'networkidle2' });

    const tokensPromise = extractTokens(page);
    await performLogin();
    const tokens = await tokensPromise;

    console.log('✅ Final extracted tokens:');
    console.log('CardLadder Authorization Token:', tokens.cardladderAuthToken);
    console.log('Firebase AppCheck Token:', tokens.firebaseAppCheck);

    return tokens;
  } catch (error) {
    console.error('❌ Error:', error);
    return null;
  } finally {
    await browser.close();
  }
}

const tokens = await loginAndExtractTokens();
console.log(tokens);
