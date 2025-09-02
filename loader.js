import { MongoClient } from "mongodb";
import fs from "fs";
import { execSync } from "child_process";
import dotenv from "dotenv";

dotenv.config();

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);

const run = async () => {
  try {
    await client.connect();
    const db = client.db("data");
    const collection = db.collection("code");

    // fetch code from Mongo
    const doc = await collection.findOne({});
    if (!doc || !doc.processAppsCode) {
      throw new Error("No processAppsCode found in MongoDB");
    }

    // save as temporary file
    const filename = "processApps.runtime.js";
    fs.writeFileSync(filename, doc.processAppsCode, "utf8");

    console.log("✅ Latest script fetched from MongoDB. Running now...");

    // execute the fetched script
    execSync(`node ${filename}`, { stdio: "inherit" });
  } catch (err) {
    console.error("Error fetching/running script:", err.message);
  } finally {
    await client.close();
  }
};

run();
