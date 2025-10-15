// lib/mongo.js
import { MongoClient } from "mongodb";

let _client = null;
let _db = null;

export async function mongoConnect() {
  if (_db) return _db;
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "sadia";
  if (!uri) throw new Error("Missing MONGODB_URI");

  _client = _client || new MongoClient(uri, { maxPoolSize: 10 });
  if (!_client.topology?.isConnected?.()) {
    await _client.connect();
  }
  _db = _client.db(dbName);

  // Ensure collection + indexes
  const colName = process.env.MONGODB_COL || "messenger_users";
  const col = _db.collection(colName);
  await col.createIndex({ psid: 1 }, { unique: true });
  await col.createIndex({ followClaim: 1, updatedAt: -1 });

  return _db;
}

export async function usersCol() {
  const db = await mongoConnect();
  return db.collection(process.env.MONGODB_COL || "messenger_users");
}
