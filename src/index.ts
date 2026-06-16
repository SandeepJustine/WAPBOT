
import 'dotenv/config';
import express from 'express';
import { connectMongo } from './mongodb';
import { startWhatsApp } from './whatsapp';

const app = express();
const PORT = process.env.PORT || 3001;

app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Health server listening on port ${PORT}`));

(async () => {
  try {
    await connectMongo();
  } catch (err) {
    console.warn('MongoDB unavailable, continuing without it:', (err as Error).message);
  }

  await startWhatsApp();
})();

