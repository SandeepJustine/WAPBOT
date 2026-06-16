
import { MongoClient, Collection, Document } from 'mongodb';

let client: MongoClient;

export async function connectMongo(): Promise<void> {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
  client = new MongoClient(uri);
  await client.connect();
  console.log('Connected to MongoDB');
}

export function getCollection<T extends Document>(name: string): Collection<T> {
  const db = client.db(process.env.MONGODB_DB || 'mupharmacy');
  return db.collection<T>(name);
}

export async function closeMongo(): Promise<void> {
  if (client) await client.close();
}
