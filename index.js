import dotenv from 'dotenv';
dotenv.config();

import { MongoClient } from 'mongodb';
import gplay from 'google-play-scraper';
import fs from 'fs';

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);

// Main process
const processApps = async () => {
  try {
    const currentDate = new Date();
    const currentMonth = currentDate.getMonth() + 1;
    const currentDay = currentDate.getDate();
    const startDay = 24; // Configure start day of the month (e.g., 1 for days 1-3)
    const endDay = 27;   // Configure end day of the month

    if (currentDay < startDay || currentDay > endDay) {
      console.log("Not within the specified days of the month.");
      return;
    }

    await client.connect();
    const db = client.db('android');
    const backupDB = client.db('backup');
    const slugAppIdCollection = db.collection('slugAndappId');
    const appsCollection = db.collection('playstoreapps');
    const backupCollection = backupDB.collection('playstoreappsBackup');
    const logCollection = db.collection('log');

    const apps = await slugAppIdCollection.find({}).toArray();

    const progressFile = 'progress.json';
    let progress;
    if (fs.existsSync(progressFile)) {
      progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
    } else {
      progress = {};
    }

    if (progress.month !== currentMonth) {
      console.log("New month, resetting progress.");
      progress = {
        lastIndex: -1,
        processedCount: 0,
        updatedCount: 0,
        noChangeCount: 0,
        howManyRunsInAMonth: 0,
        runTheScript: true,
        updatedApps: [],
        noChange: [],
        month: currentMonth
      };
    }

    if (!progress.runTheScript || progress.howManyRunsInAMonth >= 33) {
      console.log("Work already has been done");
      return;
    }

    let startIndex = progress.lastIndex + 1;
    let processedCount = progress.processedCount;
    let updatedCount = progress.updatedCount;
    let noChangeCount = progress.noChangeCount;
    let updatedApps = progress.updatedApps;
    let noChange = progress.noChange;

    const maxRuntime = 58 * 60 * 1000; // 58 minutes in ms
    const startTime = Date.now();

    let i = startIndex;
    while (i < apps.length && Date.now() - startTime < maxRuntime) {
      const batchSize = Math.min(2, apps.length - i);
      if (batchSize === 0) break;
      const batch = apps.slice(i, i + batchSize);

      // Fetch appData for the batch in parallel
      const appDataPromises = batch.map(app => gplay.app({ appId: app.appId }).catch(error => ({ error, appId: app.appId })));
      const appDatas = await Promise.all(appDataPromises);

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

        // Validate required fields
        if (!appData.title || !appData.appId) {
          console.warn(`Skipping app ${app.appId}: Missing title or appId`);
          continue;
        }

        const existingApp = await appsCollection.findOne({ appId: app.appId });

        if (!existingApp) {
          console.log(`App ${app.appId} not found in database, skipping insert as per requirement`);
          continue;
        } else if (existingApp.version !== appData.version || appData.version === 'VARY') {
          const updatedApp = {
            version: appData.version || 'Unknown',
            title: appData.title,
            rating: appData.scoreText || '0',
            reviews: appData.ratings || 0,
            summary: appData.summary || '',
            description: appData.description || '',
            icon: appData.icon || '',
            screenshots: appData.screenshots || [],
            updated: new Date(),
          };
          await appsCollection.updateOne({ appId: app.appId }, { $set: updatedApp });
          await backupCollection.updateOne({ appId: app.appId }, { $set: updatedApp });
          console.log(`Updated app: ${app.appId}`);
          updatedCount++;
          updatedApps.push(appData.title);
        } else {
          console.log(`No changes for app: ${app.appId}`);
          noChangeCount++;
          noChange.push(appData.title);
        }

        processedCount++;
      }

      // Take random break between 1 to 3 seconds
      const randomDelay = (1 + Math.random() * 2) * 1000; // in ms
      console.log(`Taking ${randomDelay / 1000} seconds break after processing batch starting at index ${i}...`);
      await new Promise(resolve => setTimeout(resolve, randomDelay));

      i += batchSize;
    }

    // Update progress
    progress.lastIndex = i - 1;
    progress.processedCount = processedCount;
    progress.updatedCount = updatedCount;
    progress.noChangeCount = noChangeCount;
    progress.updatedApps = updatedApps;
    progress.noChange = noChange;

    if (i >= apps.length) {
      const logData = {
        timestamp: new Date(),
        updatedCount,
        noChangeCount,
        updatedApps,
        noChange,
      };
      await logCollection.insertOne(logData);

      progress.runTheScript = false;
      progress.lastIndex = -1;
      progress.processedCount = 0;
      progress.updatedCount = 0;
      progress.noChangeCount = 0;
      progress.updatedApps = [];
      progress.noChange = [];

      console.log('Apps updated successfully');
      console.log(`Updated apps: ${updatedCount}`);
      console.log(`No changes for apps: ${noChangeCount}`);
    }

    // Increment the run count
    progress.howManyRunsInAMonth += 1;

    // Save progress
    fs.writeFileSync(progressFile, JSON.stringify(progress), 'utf8');
  } catch (err) {
    console.error('Error in background processing:', err.message);
  } finally {
    await client.close();
  }
};

processApps();
