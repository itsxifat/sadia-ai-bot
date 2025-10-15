// lib/mongo.js
import { MongoClient, ServerApiVersion } from "mongodb";
import dns from "node:dns";
dns.setDefaultResultOrder?.("ipv4first");

let _client = null;
let _db = null;

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "sadia";

export async function mongoConnect() {
  if (_db) return _db;
  if (!uri) throw new Error("Missing MONGODB_URI in env");

  _client = _client || new MongoClient(uri, {
    maxPoolSize: 10,
    serverApi: { version: ServerApiVersion.v1 },
    connectTimeoutMS: 8000,
    serverSelectionTimeoutMS: 8000,
  });

  if (!_client.topology?.isConnected?.()) await _client.connect();
  _db = _client.db(dbName);

  const colName = process.env.MONGODB_COL || "messenger_users";
  const col = _db.collection(colName);
  await col.createIndex({ psid: 1 }, { unique: true });
  await col.createIndex({ verified: 1, updatedAt: -1 });
  await col.createIndex({ vip: 1, updatedAt: -1 });

  return _db;
}

export async function usersCol() {
  const db = await mongoConnect();
  return db.collection(process.env.MONGODB_COL || "messenger_users");
}
