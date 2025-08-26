import dotenv from 'dotenv';
dotenv.config();

import { MongoClient } from 'mongodb';
import gplay from 'google-play-scraper';
import fs from 'fs';

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);

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
    let progress = {
      lastIndex: 0,
      processedCount: 0,
      updatedCount: 0,
      noChangeCount: 0,
      runscript: true,
      runCountInMonth: 0
    };

    if (fs.existsSync(progressFile)) {
      progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
    }

    // 🚨 Check conditions before running
    if (!progress.runscript || progress.runCountInMonth >= 33) {
      console.log("Script not allowed to run (runscript=false or limit reached).");
      return;
    }

    let { lastIndex, processedCount, updatedCount, noChangeCount, runCountInMonth } = progress;

    const updatedApps = [], noChange = [];

    const startTime = Date.now();
    const runDuration = 58 * 60 * 1000; // 58 minutes in ms

    let i = lastIndex;
    while (i < apps.length && (Date.now() - startTime) < runDuration) {
      const batchSize = Math.min(2, apps.length - i);
      const batch = apps.slice(i, i + batchSize);

      const appDataPromises = batch.map(app =>
        gplay.app({ appId: app.appId }).catch(error => ({ error, appId: app.appId }))
      );
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

        if (!appData.title || !appData.appId) {
          console.warn(`Skipping app ${app.appId}: Missing title or appId`);
          continue;
        }

        const existingApp = await appsCollection.findOne({ appId: app.appId });

        if (!existingApp) {
          console.log(`App ${app.appId} not found in database, skipping insert`);
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

      // 🌟 Random break 1–3 sec
      const randomDelay = (Math.random() * 2 + 1) * 1000;
      console.log(`Taking ${randomDelay / 1000}s break...`);
      await new Promise(resolve => setTimeout(resolve, randomDelay));

      // Update progress after batch
      fs.writeFileSync(progressFile, JSON.stringify({
        lastIndex: i + batchSize - 1,
        processedCount,
        updatedCount,
        noChangeCount,
        runscript: true,
        runCountInMonth
      }), 'utf8');

      i += batchSize;
    }

    // ✅ At the end of 58 minutes, update JSON + increment runCountInMonth
    fs.writeFileSync(progressFile, JSON.stringify({
      lastIndex: i,
      processedCount,
      updatedCount,
      noChangeCount,
      runscript: true,
      runCountInMonth: runCountInMonth + 1
    }), 'utf8');

    const logData = {
      timestamp: new Date(),
      updatedCount,
      noChangeCount,
      updatedApps,
      noChange,
    };
    await logCollection.insertOne(logData);

    console.log('Apps updated successfully');
  } catch (err) {
    console.error('Error in background processing:', err.message);
  } finally {
    await client.close();
  }
};

processApps();
