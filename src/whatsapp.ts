import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import path from 'path';
import { smartSearch, MultiSearchResult } from './search';
import { extractMedicineName } from './openai';
import { getCollection } from './mongodb';

const logger = pino({ level: process.env.LOG_LEVEL || 'debug' });
const AUTH_DIR = path.join(process.cwd(), 'auth_info');

const HELP_TEXT = `*MuPharmacy Bot Commands*
!drug <name>  – Search drug info
!price <name> – Get drug price
!stock <name> – Check drug availability
!help         – Show this message`;

// ─── Noise Filter ────────────────────────────────────────────────────────────
// Patterns that indicate the message is NOT a medicine query
const IGNORE_PATTERNS: RegExp[] = [
  /\bthis is (just |only )?a demo\b/i,
  /\bdon'?t (reply|respond)\b/i,
  /\bplease (ignore|don'?t reply|don'?t respond)\b/i,
  /\bjust (testing|a test|checking)\b/i,
  /\bignore (this|me)\b/i,
  /\btest(ing)? (message|only|bot|this)\b/i,
  /\bnot (a )?((medicine|drug|pharmacy) )?(query|question|request)\b/i,
  /\b(good (morning|afternoon|evening|night)|hello|hi|hey|howdy|greetings)\b/i,
  /^(ok|okay|thanks|thank you|noted|got it|sure|yes|no|👍|🙏|😊|🥺)$/i,
];

function shouldIgnoreMessage(text: string): boolean {
  return IGNORE_PATTERNS.some(pattern => pattern.test(text));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function humanDelay(minMs = 5000, maxMs = 15000): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(resolve => setTimeout(resolve, delay));
}

function simpleExtract(text: string): string {
  return text
    .toLowerCase()
    .replace(
      /\b(i am looking for|i am searching for|i need|i want|do you have|looking for|search for|find me|can you find|please|help me find|where can i get|do you sell|is there|anyone|any|with|got|have|selling|sells|stock|available|availability)\b/g,
      '',
    )
    .replace(/[?!.,]/g, '')
    .trim();
}

const SITE_LINK = '\n\n_Find More Info at Mu Pharmacy_\nhttps://mupharmacy.mw/';

// ─── Format Results ───────────────────────────────────────────────────────────
function formatResults(medicines: MultiSearchResult['results'][0]['medicines'], cmd: string): string {
  if (cmd === 'price') {
    return medicines
      .slice(0, 5)
      .map(m => `*${m.name}*: ${m.price} ${m.currency || 'MWK'}\nSold by: ${m.wholesalerName || 'N/A'}`)
      .join('\n\n');
  }

  if (cmd === 'stock') {
    return medicines
      .slice(0, 5)
      .map(
        m =>
          `*${m.name}*: ${m.stock > 0 ? `${m.stock} units in stock` : 'Out of stock'}\nSold by: ${m.wholesalerName || 'N/A'}`,
      )
      .join('\n\n');
  }

  return medicines
    .slice(0, 3)
    .map(m => {
      const wholesalerLine = m.wholesalerName
        ? `\nSold by: *${m.wholesalerName}*${m.wholesalerCity ? `, ${m.wholesalerCity}` : ''}${m.wholesalerPhone ? `\nContact: ${m.wholesalerPhone}` : ''}`
        : '';
      return `*${m.name}*\nPrice: ${m.price} ${m.currency || 'MWK'} | Stock: ${m.stock}${m.description ? `\n${m.description}` : ''}${wholesalerLine}`;
    })
    .join('\n\n');
}

// ─── Main Handler ─────────────────────────────────────────────────────────────
async function handleMessage(
  sock: ReturnType<typeof makeWASocket>,
  jid: string,
  text: string,
  isGroup: boolean,
) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Always ignore noise/demo/test messages
  if (shouldIgnoreMessage(trimmed)) {
    console.log('Ignored noise message:', trimmed.slice(0, 60));
    return;
  }

  if (lower === '!help') {
    await sock.sendMessage(jid, { text: HELP_TEXT });
    return;
  }

  const cmdMatch = lower.match(/^!(drug|price|stock)\s+(.+)/);
  let cmd = 'drug';
  let rawQuery: string | null = null;

  if (cmdMatch) {
    cmd = cmdMatch[1];
    rawQuery = cmdMatch[2].trim();
  } else if (trimmed.startsWith('!')) {
    return; // Unknown command
  } else {
    // Natural language path
    rawQuery = await extractMedicineName(trimmed);

    if (!rawQuery) {
      rawQuery = simpleExtract(trimmed);
      if (!rawQuery) return;
    }

    if (isGroup && rawQuery === lower.replace(/[?!.,]/g, '').trim()) return;
  }

  // Human-like delay + typing indicator
  await sock.sendPresenceUpdate('composing', jid);
  await humanDelay(5000, 15000);

  // Smart search handles both single and multi-item queries
  const searchResult = await smartSearch(rawQuery);

  await sock.sendPresenceUpdate('paused', jid);

  if (searchResult.totalFound === 0) {
    await sock.sendMessage(jid, {
      text: `No results found for "*${rawQuery}*".`,
    });
    return;
  }

  // Build reply — one section per queried item
  const sections: string[] = [];

  for (const result of searchResult.results) {
    if (!result.found) {
      sections.push(`*${result.query}*: ❌ Not found`);
      continue;
    }
    const formatted = formatResults(result.medicines, cmd);
    // Only add header if it was a multi-item search
    if (searchResult.results.length > 1) {
      sections.push(`🔍 *${result.query}*\n${formatted}`);
    } else {
      sections.push(formatted);
    }
  }

  // Summary line for multi-item searches
  let reply = sections.join('\n\n─────────────\n\n');
  if (searchResult.results.length > 1) {
    reply = `Found *${searchResult.totalFound}/${searchResult.results.length}* items:\n\n${reply}`;
  }

  reply += SITE_LINK;

  await sock.sendMessage(jid, { text: reply });

  // Log to MongoDB
  try {
    const logs = getCollection('message_logs');
    await logs.insertOne({
      jid,
      text: trimmed,
      query: rawQuery,
      cmd,
      resultsCount: searchResult.totalFound,
      createdAt: new Date(),
      isGroup,
    });
  } catch { /* ignore */ }
}

// ─── WhatsApp Bootstrap ───────────────────────────────────────────────────────
export async function startWhatsApp(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    browser: ['MuPharmacy Bot', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrcode.generate(qr, { small: true });
      console.log('Scan the QR code above with WhatsApp (Linked Devices)');
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`Connection closed (${statusCode}), reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) startWhatsApp();
    } else if (connection === 'open') {
      console.log('WhatsApp connected');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (!jid) continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      if (!text) continue;

      const isGroup = jid.endsWith('@g.us');

      try {
        await handleMessage(sock, jid, text, isGroup);
      } catch (err) {
        console.error('handleMessage error:', err);
      }
    }
  });
}