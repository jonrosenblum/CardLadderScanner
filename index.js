import fetch from 'node-fetch';
import fs from 'fs';
import readline from 'readline';
import path from 'path';
import dotenv from 'dotenv';
import { createObjectCsvWriter } from 'csv-writer';
import { connect } from "puppeteer-real-browser";


dotenv.config();

let csvWriter;
let csvFilename;
let scanCounter = 0;

let { firebaseAppCheck, cardladderAuthToken } = await loginAndExtractTokens();

// --- Custom error for token expiration ---
class TokenExpiredError extends Error {}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// --- Hot reload environment variables ---
function loadEnv() {
  dotenv.config();
  return {
    PSA_API_TOKEN: process.env.PSA_API_TOKEN
  };
}

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

    console.log('✅ Final extracted tokens');

    return tokens;
  } catch (error) {
    console.error('❌ Error:', error);
    return null;
  } finally {
    await browser.close();
  }
}

async function refreshCardladderTokens() {
  let tokens = await loginAndExtractTokens();
  firebaseAppCheck = tokens.firebaseAppCheck;
  cardladderAuthToken = tokens.cardladderAuthToken;
}

// --- Startup prompt ---
rl.question('📄 What would you like to name the CSV file? (leave blank for auto-name) ', (filename) => {
  if (!filename.trim()) {
    const today = new Date().toISOString().split('T')[0];
    csvFilename = path.join('scans', `SCAN_${today}.csv`);
    console.log(`📁 No filename provided. Using ${csvFilename}`);
  } else {
    csvFilename = filename.endsWith('.csv') ? path.join('scans', filename) : path.join('scans', `${filename}.csv`);
  }

  csvWriter = createObjectCsvWriter({
    path: csvFilename,
    header: [
      { id: 'grader', title: 'Grading Company' },
      { id: 'certNumber', title: 'Cert' },
      { id: 'gemRateId', title: 'Gem Rate ID' },
      { id: 'description', title: 'Info' },
      { id: 'grade', title: 'Grade' },
      { id: 'estimatedValue', title: 'CL' },
      { id: 'confidence', title: 'Conf' },
      { id: 'payout', title: 'Payout' },
      { id: 'index', title: 'Index' },
      { id: 'indexId', title: 'Index ID' },
      { id: 'population', title: 'Population' },
      { id: 'indexPercentChange', title: 'Index % Change' },
      { id: 'frontImageUrl', title: 'Front Image URL' },
      { id: 'backImageUrl', title: 'Back Image URL' }
    ],
    append: fs.existsSync(csvFilename)
  });

  console.log(`\n🔎 Ready to start scanning into ${csvFilename}!`);
  rl.setPrompt('📦 Paste certs or scan a cert: ');
  rl.prompt();
});

// --- Handle input ---
rl.on('line', async (input) => {
  const certs = parseCerts(input);

  if (certs.length === 0) {
    console.log('⚠️ No valid certs detected. Try again.');
    rl.prompt();
    return;
  }

  console.log(`📋 Detected ${certs.length} cert(s). Starting scan...\n`);
  await processCerts(certs);
  rl.prompt();
});

// --- Parse certs ---
function parseCerts(input) {
  const cleaned = input.replace(/\s+/g, '');
  const hasGrader = /(PSA|SGC|BGS)/i.test(cleaned);

  const certs = [];

  if (hasGrader) {
    const parts = cleaned.split(/(PSA|SGC|BGS)/i).filter(Boolean);

    for (let i = 0; i < parts.length - 1; i += 2) {
      const grader = parts[i].toUpperCase();
      const certMatch = parts[i + 1].match(/\d{6,}/);
      if (grader && certMatch) {
        certs.push({ grader, certNumber: certMatch[0] });
      }
    }
  } else {
    const certMatch = cleaned.match(/\d{6,}/);
    if (certMatch) {
      certs.push({ grader: "PSA", certNumber: certMatch[0] });
    }
  }

  return certs;
}

// --- Main processing certs ---
async function processCerts(certs) {
  let processed = 0;
  const total = certs.length;
  const startTime = Date.now();

  for (const { grader, certNumber } of certs) {
    processed++;
    const bar = buildProgressBar(processed, total);
    const pct = Math.floor((processed / total) * 100);
    process.stdout.write(`\r${bar} ${pct}% (${processed}/${total}) Scanning ${grader} Cert: ${certNumber} `);

    try {
      await handleCertScan(certNumber, grader);
    } catch (error) {
      console.error(`\n❌ Error for cert ${certNumber}:`, error.message);
      await writeErrorRow(grader, certNumber, error.message);
    }
  }

  const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n🎯 Finished scanning ${total} cert(s) in ${elapsedTime} seconds!\n`);
}

async function writeErrorRow(grader, certNumber, message) {
  await csvWriter.writeRecords([{
    grader,
    certNumber,
    gemRateId: 'error',
    description: message,
    grade: 'error',
    estimatedValue: 'error',
    confidence: 'error',
    payout: 'error',
    index: 'error',
    indexId: 'error',
    population: 'error',
    indexPercentChange: 'error',
    frontImageUrl: 'error',
    backImageUrl: 'error'
  }]);
}

// --- Handle scanning a single cert ---
async function handleCertScan(certNumber, grader) {
  const { gemRateId, cardladderResult } = await fetchCardladderResult(certNumber, grader);
  const certImages = await fetchPSACertImages(certNumber);

  if (!cardladderResult || !certImages) {
    console.log('\n⚠️ Skipping due to missing data.');
    return;
  }

  const payout = cardladderResult.estimatedValue ? (cardladderResult.estimatedValue * 0.90).toFixed(2) : '';

  const row = {
    grader,
    certNumber,
    gemRateId,
    description: cardladderResult.description,
    grade: cardladderResult.grade,
    estimatedValue: cardladderResult.estimatedValue,
    confidence: cardladderResult.confidence,
    payout,
    index: cardladderResult.index,
    indexId: cardladderResult.indexId,
    population: cardladderResult.population,
    indexPercentChange: cardladderResult.indexPercentChange,
    frontImageUrl: certImages.frontImageUrl,
    backImageUrl: certImages.backImageUrl
  };

  await csvWriter.writeRecords([row]);
  process.stdout.write('\x07');
}

// --- Build progress bar ---
function buildProgressBar(current, total) {
  const barLength = 30;
  const filledLength = Math.round((current / total) * barLength);
  const emptyLength = barLength - filledLength;
  return `[${'#'.repeat(filledLength)}${'-'.repeat(emptyLength)}]`;
}

// --- Fetch Cardladder ---
async function fetchCardladderResult(certNumber, grader) {

  const searchResponse = await fetch("https://us-central1-cardladder-71d53.cloudfunctions.net/httpCertSearch", {
    method: "POST",
    headers: {
      "accept": "*/*",
      "content-type": "application/json",
      "authorization": cardladderAuthToken,
      "x-firebase-appcheck": firebaseAppCheck
    },
    body: JSON.stringify({ data: { cert: certNumber, grader: grader.toLowerCase() } })
  });

  if (searchResponse.status === 401) {
    throw new TokenExpiredError();
  }

  const searchData = await searchResponse.json();

  const gemRateId = searchData?.result?.gemRateId;
  const condition = searchData?.result?.condition || "g10";

  if (!gemRateId) {
    console.log('\n⚠️ No gemRateId found.');
    return null;
  }

  const estimateResponse = await fetch("https://us-central1-cardladder-71d53.cloudfunctions.net/httpEstimateValue", {
    method: "POST",
    headers: {
      "accept": "*/*",
      "content-type": "application/json",
      "authorization": cardladderAuthToken,
      "x-firebase-appcheck": firebaseAppCheck
    },
    body: JSON.stringify({ data: { gemRateId, gradingCompany: grader.toLowerCase(), condition } })
  });

  if (estimateResponse.status === 401) {
    console.log(await estimateResponse.json());
    throw new TokenExpiredError();
  }

  const estimateData = await estimateResponse.json();
  return { gemRateId, cardladderResult: estimateData?.result || null };
}

// --- Fetch PSA Images ---
async function fetchPSACertImages(certNumber) {
  const { PSA_API_TOKEN } = loadEnv();

  const url = `https://api.psacard.com/publicapi/cert/GetImagesByCertNumber/${certNumber}`;

  const headers = {
    "Authorization": `Bearer ${PSA_API_TOKEN}`,
    "Content-Type": "application/json"
  };

  const response = await fetch(url, { method: "GET", headers });

  const data = await response.json();

  if (!Array.isArray(data)) {
    console.warn('\n⚠️ PSA response unexpected format.');
    return {
      frontImageUrl: "./No-Image-Placeholder.svg.png",
      backImageUrl: "./No-Image-Placeholder.svg.png"
    };
  }

  let frontImage = data.find(img => img.IsFrontImage === true);
  let backImage = data.find(img => img.IsFrontImage === false);

  return {
    frontImageUrl: frontImage?.ImageURL || "./No-Image-Placeholder.svg.png",
    backImageUrl: backImage?.ImageURL || "./No-Image-Placeholder.svg.png"
  };
}
