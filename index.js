import fetch from 'node-fetch';
import fs from 'fs';
import readline from 'readline';
import path from 'path';
import dotenv from 'dotenv';
import { createObjectCsvWriter } from 'csv-writer';

dotenv.config();

let csvWriter;
let csvFilename;
let scanCounter = 0;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// --- Hot reload environment variables ---
function loadEnv() {
  dotenv.config();
  return {
    CARDLADDER_AUTHORIZATION: process.env.CARDLADDER_AUTHORIZATION,
    CARDLADDER_APP_CHECK: process.env.CARDLADDER_APP_CHECK,
    PSA_API_TOKEN: process.env.PSA_API_TOKEN
  };
}

// --- Create /scans folder automatically ---
const scansDir = path.join(process.cwd(), 'scans');
if (!fs.existsSync(scansDir)) {
  fs.mkdirSync(scansDir);
}

// Ask for filename at start
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
      { id: 'certNumber', title: 'Cert Number' },
      { id: 'estimatedValue', title: 'Estimated Value' },
      { id: 'payout', title: 'Payout' },
      { id: 'lastSaleDate', title: 'Last Sale Date' },
      { id: 'confidence', title: 'Confidence' },
      { id: 'grader', title: 'Grader' },
      { id: 'index', title: 'Index' },
      { id: 'indexId', title: 'Index ID' },
      { id: 'description', title: 'Description' },
      { id: 'grade', title: 'Grade' },
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

// --- Parse certs properly ---
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

// --- Process certs ---
async function processCerts(certs) {
  let processed = 0;
  const total = certs.length;
  const startTime = Date.now();

  for (const { grader, certNumber } of certs) {
    processed++;

    const progressBar = buildProgressBar(processed, total);
    const percent = Math.floor((processed / total) * 100);
    process.stdout.write(`\r${progressBar} ${percent}% (${processed}/${total}) Scanning ${grader} Cert: ${certNumber} `);

    try {
      const cardladderResult = await fetchCardladderResult(certNumber, grader);
      const certImages = await fetchPSACertImages(certNumber);

      if (!cardladderResult || !certImages) {
        console.log('\n⚠️ Skipping due to missing data.');
        continue;
      }

      const payout = cardladderResult.estimatedValue ? (cardladderResult.estimatedValue * 0.90).toFixed(2) : '';

      const row = {
        certNumber,
        estimatedValue: cardladderResult.estimatedValue,
        payout,
        lastSaleDate: cardladderResult.lastSaleDate,
        confidence: cardladderResult.confidence,
        grader,
        index: cardladderResult.index,
        indexId: cardladderResult.indexId,
        description: cardladderResult.description,
        grade: cardladderResult.grade,
        population: cardladderResult.population,
        indexPercentChange: cardladderResult.indexPercentChange,
        frontImageUrl: certImages.frontImageUrl,
        backImageUrl: certImages.backImageUrl
      };

      await csvWriter.writeRecords([row]);
      process.stdout.write('\x07'); // 🎵

      scanCounter++;
      if (scanCounter % 10 === 0) {
        console.log('\n🔄 Checking token validity...');
        await checkTokenHealth();
      }

    } catch (error) {
      console.error(`\n❌ Error processing cert #${certNumber}:`, error);
    }
  }

  const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n🎯 Finished scanning ${total} cert(s) in ${elapsedTime} seconds!\n`);
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
  try {
    const { CARDLADDER_AUTHORIZATION, CARDLADDER_APP_CHECK } = loadEnv();

    const searchResponse = await fetch("https://us-central1-cardladder-71d53.cloudfunctions.net/httpCertSearch", {
      method: "POST",
      headers: {
        "accept": "*/*",
        "content-type": "application/json",
        "authorization": CARDLADDER_AUTHORIZATION,
        "x-firebase-appcheck": CARDLADDER_APP_CHECK
      },
      body: JSON.stringify({ data: { cert: certNumber, grader: grader.toLowerCase() } })
    });

    if (searchResponse.status === 401) {
      console.error('\n🚨 Cardladder Authorization expired! Please refresh your tokens.');
      process.exit(1);
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
        "authorization": CARDLADDER_AUTHORIZATION,
        "x-firebase-appcheck": CARDLADDER_APP_CHECK
      },
      body: JSON.stringify({ data: { gemRateId, gradingCompany: grader.toLowerCase(), condition } })
    });

    if (estimateResponse.status === 401) {
      console.error('\n🚨 Cardladder Authorization expired! Please refresh your tokens.');
      process.exit(1);
    }

    const estimateData = await estimateResponse.json();
    return estimateData?.result || null;

  } catch (error) {
    console.error('\n❌ Error fetching Cardladder result:', error);
    return null;
  }
}

// --- Fetch PSA Images ---
async function fetchPSACertImages(certNumber) {
  try {
    const { PSA_API_TOKEN } = loadEnv();

    const url = `https://api.psacard.com/publicapi/cert/GetImagesByCertNumber/${certNumber}`;

    const headers = {
      "Authorization": `Bearer ${PSA_API_TOKEN}`,
      "Content-Type": "application/json"
    };

    const response = await fetch(url, { method: "GET", headers });

    if (response.status === 401) {
      console.error('\n🚨 PSA API Token expired! Please refresh your tokens.');
      process.exit(1);
    }

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
  } catch (error) {
    console.error('\n❌ Error fetching PSA cert images:', error);
    return {
      frontImageUrl: "./No-Image-Placeholder.svg.png",
      backImageUrl: "./No-Image-Placeholder.svg.png"
    };
  }
}

// --- Token health check ---
async function checkTokenHealth() {
  try {
    const { CARDLADDER_AUTHORIZATION, CARDLADDER_APP_CHECK, PSA_API_TOKEN } = loadEnv();

    const dummyCert = "12345678";

    const testResponse = await fetch("https://us-central1-cardladder-71d53.cloudfunctions.net/httpCertSearch", {
      method: "POST",
      headers: {
        "accept": "*/*",
        "content-type": "application/json",
        "authorization": CARDLADDER_AUTHORIZATION,
        "x-firebase-appcheck": CARDLADDER_APP_CHECK
      },
      body: JSON.stringify({ data: { cert: dummyCert, grader: "psa" } })
    });

    if (testResponse.status === 401) {
      console.error('\n🚨 Cardladder Authorization expired.');
      process.exit(1);
    }

    const psaResponse = await fetch(`https://api.psacard.com/publicapi/cert/GetByCertNumber/${dummyCert}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${PSA_API_TOKEN}`,
        "Content-Type": "application/json"
      }
    });

    if (psaResponse.status === 401) {
      console.error('\n🚨 PSA Token expired.');
      process.exit(1);
    }

  } catch (error) {
    console.error('\n❌ Error checking tokens:', error);
    process.exit(1);
  }
}
