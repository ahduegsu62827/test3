import dotenv from 'dotenv';
dotenv.config();

import { MongoClient } from 'mongodb';
import gplay from 'google-play-scraper';
import axios from 'axios';
import fs from 'fs';

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);

// Slug generator
function generateSlug(title) {
  return title
    .split(':')[0]
    .split(',')[0]
    .split(' x ')[0]
    .split(/-(?! )/)[0]
    .replace(/[™®©]/gi, '')
    .replace(/\.io\b/gi, '-io')
    .replace(/[\/|]+/g, '-')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .trim()
    .replace(/^-+|-+$/g, '');
}

// Install display calculation
const calculateDisplayInstalls = (playstoreInstallsStr) => {
  const numStr = playstoreInstallsStr.replace(/,/g, '').replace(/\+/g, '');
  const num = parseInt(numStr, 10);
  if (isNaN(num)) throw new Error('Invalid installs string format.');
  const percent = Math.floor(Math.random() * 11) + 30;
  const result = (percent / 100.0) * num;
  const formatNumber = (value, divider, suffix) => {
    let formatted = (value / divider).toFixed(1);
    if (formatted.endsWith('.0')) formatted = formatted.slice(0, -2);
    return formatted + suffix;
  };
  if (result >= 1e12) return formatNumber(result, 1e12, 'T+');
  if (result >= 1e9) return formatNumber(result, 1e9, 'B+');
  if (result >= 1e6) return formatNumber(result, 1e6, 'M+');
  if (result >= 1e3) return formatNumber(result, 1e3, 'K+');
  return `${Math.floor(result)}+`;
};

// Get APK size from APKPure with retries
async function getApkSizeFromAPKPure(appId) {
  const url = `https://d.apkpure.net/b/XAPK/${appId}?version=latest`;
  const maxRetries = 5;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const response = await axios.head(url, { timeout: 10000 });
      const sizeInBytes = parseInt(response.headers['content-length'] || '0', 10);
      if (!sizeInBytes) return "Unknown";
      const mb = parseFloat((sizeInBytes / (1024 * 1024)).toFixed(2));
      let formattedSize;
      if (mb >= 1000) {
        let gb = (mb / 1000).toFixed(1);
        if (gb.endsWith('.0')) gb = gb.slice(0, -2);
        formattedSize = `${gb}GB`;
      } else {
        formattedSize = `${Math.floor(mb)}MB`;
      }
      return formattedSize;
    } catch (error) {
      let status = null;
      let isTimeout = false;
      if (error.response) {
        status = error.response.status;
      } else if (error.code === 'ECONNABORTED' && error.message.includes('timeout')) {
        isTimeout = true;
      }
      if (status === 404 || status === 403) {
        throw new Error(`Permanent error: status ${status}`);
      } else if (status === 405 || isTimeout) {
        if (attempt > maxRetries) {
          throw new Error(`Failed after ${maxRetries} retries: ${status ? `status ${status}` : 'timeout'}`);
        }
        console.log(`Retrying fetch for ${appId} (attempt ${attempt})...`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2s delay before retry
      } else {
        throw error; // Other errors, throw immediately
      }
    }
  }
}

// Generate random alphanumeric string for username
function generateUsername() {
  const lettersCount = Math.floor(Math.random() * 2) + 4; // 4 or 5
  const numbersCount = Math.floor(Math.random() * 2) + 1; // 1 or 2
  const allLetters = 'abcdefghijklmnopqrstuvwxyz';
  let letters = allLetters.charAt(Math.floor(Math.random() * 26)).toUpperCase();
  for (let i = 1; i < lettersCount; i++) {
    letters += allLetters.charAt(Math.floor(Math.random() * 26));
  }
  let numbers = '';
  for (let i = 0; i < numbersCount; i++) {
    numbers += Math.floor(Math.random() * 10);
  }
  return letters + numbers;
}

// Generate random date between 2024-01-01 and 2025-12-31
function randomDate() {
  const start = new Date('2024-01-01').getTime();
  const end = new Date('2025-12-31').getTime();
  return new Date(start + Math.random() * (end - start));
}

// Fetch and process comments
async function fetchComments(appId) {
  try {
    const response = await gplay.reviews({
      appId: appId,
      sort: gplay.sort.NEWEST,
      num: 30
    });
    const comments = response.data.map(review => ({
      text: review.text,
      username: generateUsername(),
      date: randomDate().toISOString()
    }));
    return comments;
  } catch (error) {
    console.error(`Failed to fetch comments for ${appId}:`, error.message);
    return [];
  }
}

// Main process
const processApps = async () => {
  try {
    await client.connect();
    const db = client.db('android');
    const backupDB = client.db('backup');
    const slugAppIdCollection = db.collection('slugAndappId');
    const appsCollection = db.collection('playstoreapps');
    const backupCollection = backupDB.collection('playstoreappsBackup');
    const logCollection = db.collection('log');

    const apps = await slugAppIdCollection.find({}).toArray();

    const progressFile = 'progress.json';
    let startIndex = 0;
    let processedCount = 0;
    let insertedCount = 0;
    let updatedCount = 0;
    let noChangeCount = 0;
    if (fs.existsSync(progressFile)) {
      const progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
      startIndex = progress.lastIndex + 1;
      processedCount = progress.processedCount || 0;
      insertedCount = progress.insertedCount || 0;
      updatedCount = progress.updatedCount || 0;
      noChangeCount = progress.noChangeCount || 0;
    }

    const updatedApps = [], insertApps = [], noChange = [];

    let i = startIndex;
    while (i < apps.length) {
      const batchSize = Math.min(2, apps.length - i);
      const batch = apps.slice(i, i + batchSize);

      // Fetch appData for the batch in parallel
      const appDataPromises = batch.map(app => gplay.app({ appId: app.appId }).catch(error => ({ error, appId: app.appId })));
      const appDatas = await Promise.all(appDataPromises);

      // Prepare lists for sizes and comments fetches
      const needsUpdate = [];

      for (let j = 0; j < batch.length; j++) {
        const app = batch[j];
        const appData = appDatas[j];

        if (appData.error) {
          if (appData.error.message.includes('App not found (404)')) {
            console.error(`App not found, deleting appId: ${app.appId}`);
            await slugAppIdCollection.deleteOne({ appId: app.appId });
            await backupCollection.deleteOne({ appId: app.appId });
          } else {
            console.error(`Error processing appId ${app.appId}:`, appData.error.message);
          }
          continue;
        }

        const existingApp = await appsCollection.findOne({ appId: app.appId });

        if (!existingApp) {
          needsUpdate.push({ app, appData, isInsert: true });
        } else if (existingApp.version !== appData.version || appData.version === "VARY") {
          needsUpdate.push({ app, appData, isInsert: false });
        } else {
          console.log(`No changes for app: ${app.appId}`);
          noChangeCount++;
          noChange.push(appData.title);
        }

        processedCount++;
      }

      if (needsUpdate.length > 0) {
        // Fetch sizes and comments in parallel for those that need update/insert
        const sizePromises = needsUpdate.map(({ appData }) => getApkSizeFromAPKPure(appData.appId).catch(error => ({ error, appId: appData.appId })));
        const commentsPromises = needsUpdate.map(({ appData }) => fetchComments(appData.appId));

        const sizesResults = await Promise.all(sizePromises);
        const commentsArrays = await Promise.all(commentsPromises);

        for (let k = 0; k < needsUpdate.length; k++) {
          const { app, appData, isInsert } = needsUpdate[k];
          const sizeResult = sizesResults[k];
          const comments = commentsArrays[k];
          let finalAppSize;

          if (sizeResult.error) {
            const errorMsg = sizeResult.error.message;
            if (errorMsg.includes('Permanent error')) {
              // For 404/403
              if (isInsert) {
                console.log(`Skipping insert for ${app.appId} due to permanent size fetch error.`);
                continue;
              } else {
                // For update, keep old size
                finalAppSize = (await appsCollection.findOne({ appId: app.appId })).appSize || "Unknown";
              }
            } else {
              // Failed after retries or other
              if (isInsert) {
                console.log(`Skipping insert for ${app.appId} due to size fetch failure after retries.`);
                continue;
              } else {
                // For update, keep old size
                finalAppSize = (await appsCollection.findOne({ appId: app.appId })).appSize || "Unknown";
              }
            }
          } else {
            finalAppSize = sizeResult;
          }

          if (isInsert) {
            const newApp = {
              slug: generateSlug(appData.title),
              os: appData.androidVersion,
              downloadObb: app.downloadObb,
              isAvailableOnPlayStore: app.isAvailableOnPlayStore,
              appInstall: calculateDisplayInstalls(appData.installs),
              appSize: finalAppSize,
              appId: appData.appId,
              title: appData.title,
              rating: appData.scoreText,
              version: appData.version,
              free: appData.free,
              platform: "android",
              downloadURL: "download",
              reviews: appData.ratings,
              developer: appData.developer,
              developerURL: generateSlug(appData.developer),
              summary: appData.summary,
              recentChanges: appData.recentChanges,
              category: appData.genre,
              categoryURL: appData.genreId.toLowerCase().replace(/_/g, "-"),
              description: appData.description,
              icon: appData.icon,
              screenshots: appData.screenshots,
              url: appData.url,
              updated: new Date(),
              comments: comments
            };
            await appsCollection.insertOne(newApp);
            await backupCollection.insertOne(newApp);
            console.log(`Inserted new app: ${app.appId}`);
            insertedCount++;
            insertApps.push(appData.title);
          } else {
            const updatedApp = {
              version: appData.version,
              title: appData.title,
              rating: appData.scoreText,
              reviews: appData.ratings,
              summary: appData.summary,
              description: appData.description,
              icon: appData.icon,
              screenshots: appData.screenshots,
              appSize: finalAppSize,
              updated: new Date(),
              comments: comments
            };
            await appsCollection.updateOne({ appId: app.appId }, { $set: updatedApp });
            await backupCollection.updateOne({ appId: app.appId }, { $set: updatedApp });
            console.log(`Updated app: ${app.appId}`);
            updatedCount++;
            updatedApps.push(appData.title);
          }
        }
      }

      // Take 2 seconds break after processing the batch
      console.log(`Taking 2 seconds break after processing batch starting at index ${i}...`);
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Update progress
      fs.writeFileSync(progressFile, JSON.stringify({
        lastIndex: i + batchSize - 1,
        processedCount,
        insertedCount,
        updatedCount,
        noChangeCount
      }), 'utf8');

      i += batchSize;
    }

    // Clear progress file after full completion
    if (fs.existsSync(progressFile)) {
      fs.unlinkSync(progressFile);
    }

    const logData = {
      timestamp: new Date(),
      insertedCount,
      updatedCount,
      noChangeCount,
      updatedApps,
      insertApps,
      noChange,
    };
    await logCollection.insertOne(logData);

    console.log('Apps updated successfully');
    console.log(`Inserted new apps: ${insertedCount}`);
    console.log(`Updated apps: ${updatedCount}`);
    console.log(`No changes for apps: ${noChangeCount}`);
  } catch (err) {
    console.error('Error in background processing:', err.message);
  } finally {
    await client.close();
  }
};

processApps();
