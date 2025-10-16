import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';
import webpush from 'web-push';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

// ---------- CORS (lock to your domain later) ----------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-HillPulse-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---------- Config ----------
const PORT = process.env.PORT || 10000;
const INGEST_SECRET = process.env.INGEST_SECRET || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''; // if you want summarization
const PUSHOVER_API_TOKEN = process.env.PUSHOVER_API_TOKEN || '';
const PUSHOVER_USER_KEY = process.env.PUSHOVER_USER_KEY || '';
const CONTACT = process.env.CONTACT || 'mailto:alerts@thecapitolwire.com';
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '';

// ---------- Auth helper ----------
function assertAuthorized(req) {
  if (!INGEST_SECRET) return true;
  const h = req.get('X-HillPulse-Key') || req.get('Authorization') || '';
  return h === INGEST_SECRET || h === `Bearer ${INGEST_SECRET}`;
}

// ---------- Web Push setup ----------
if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  console.warn('VAPID keys missing — web push will be disabled.');
}
webpush.setVapidDetails(CONTACT, VAPID_PUBLIC || 'X', VAPID_PRIVATE || 'Y');

// In-memory store of subscriptions (swap to DB for persistence)
const subscriptions = new Map(); // endpoint -> sub

// ---------- Helpers ----------
async function fetchTweetText(url) {
  if (!url) return '';
  try {
    // Try oEmbed HTML first
    const oEmbedUrl = `https://publish.twitter.com/oembed?omit_script=1&hide_thread=1&url=${encodeURIComponent(url)}`;
    const r1 = await fetch(oEmbedUrl);
    if (r1.ok) {
      const data = await r1.json();
      const html = data.html || '';
      const match = html.match(/<p[^>]*>(.*?)<\/p>/);
      if (match) {
        return match[1]
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .trim();
      }
    }
    // Fallback to syndication JSON
    const syndUrl = `https://cdn.syndication.twimg.com/widgets/tweet?url=${encodeURIComponent(url)}`;
    const r2 = await fetch(syndUrl);
    if (r2.ok) {
      const data2 = await r2.json();
      if (data2.text) return String(data2.text).trim();
    }
  } catch (err) {
    console.error('fetchTweetText error:', err.message);
  }
  return '';
}

async function summarizeWithGemini({ text, author, url }) {
  if (!GEMINI_API_KEY) {
    // if not configured, just return original text truncated
    return `@${author || 'user'}: ${text.slice(0, 140)}${text.length>140?'…':''} Link: ${url}`.trim();
  }
  const endpoint = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const prompt = `6–17 word factual summary for Hill comms. Start with @username:. Append "Link:". Shorthand OK.`;

  const body = {
    contents: [{
      role: "user",
      parts: [{ text: `${prompt}\n\nTweet author: @${author}\nTweet URL: ${url}\nTweet text:\n${text}` }]
    }]
  };

  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.status === 503) throw new Error('Gemini 503');
      if (!res.ok) throw new Error(`Gemini ${res.status}`);
      const data = await res.json();
      const out = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return out.trim();
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, 8000));
    }
  }
}

async function sendPushover({ title = 'The Capitol Wire', message, url }) {
  if (!PUSHOVER_API_TOKEN || !PUSHOVER_USER_KEY) return { ok: false, skipped: true };
  const form = new URLSearchParams();
  form.set('token', PUSHOVER_API_TOKEN);
  form.set('user', PUSHOVER_USER_KEY);
  form.set('title', title);
  form.set('message', message);
  if (url) form.set('url', url);

  const r = await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', body: form });
  const ok = r.ok;
  return { ok, status: r.status };
}

async function broadcastNotification(title, body, url) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return { ok: false, skipped: true };
  const payload = JSON.stringify({ title, body, data: { url } });
  let sent = 0, removed = 0;
  for (const [endpoint, sub] of subscriptions.entries()) {
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (err) {
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        subscriptions.delete(endpoint);
        removed++;
      } else {
        console.error('webpush error', err?.statusCode || err?.message);
      }
    }
  }
  return { ok: true, sent, active: subscriptions.size, removed };
}

// ---------- Routes ----------
app.get('/', (_req, res) => res.send('Capitol Wire unified backend is running'));

app.get('/health', (_req, res) => res.json({ ok: true, subscribers: subscriptions.size }));

// Save a browser subscription (from website)
app.post('/subscribe', (req, res) => {
  if (!assertAuthorized(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ ok: false, error: 'Bad subscription' });
  subscriptions.set(sub.endpoint, sub);
  res.json({ ok: true, count: subscriptions.size });
});

// Send manual broadcast (for testing)
app.post('/broadcast', async (req, res) => {
  if (!assertAuthorized(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const { title = 'The Capitol Wire', body = 'Test', url = 'https://thecapitolwire.com' } = req.body || {};
  const result = await broadcastNotification(title, body, url);
  res.json(result);
});

// Main ingest route (extension/shortcut hits this)
app.post('/ingest', async (req, res) => {
  try {
    if (!assertAuthorized(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const d = req.body?.data || req.body || {};
    const url = d.url || d.tweetUrl || '';
    const author = (d.author || d.username || '').replace(/^@/, '');
    let text = d.text || '';

    if (!text && url) text = await fetchTweetText(url);
    if (!text) return res.status(400).json({ ok: false, error: 'Missing tweet text' });

    // Summarize
    const summary = await summarizeWithGemini({ text, author, url });

    // Send via Pushover (if configured)
    const po = await sendPushover({ message: summary, url });

    // Broadcast via Web Push (if configured)
    const wp = await broadcastNotification('The Capitol Wire', summary, url);

    return res.json({ ok: true, summary, pushover: po, webpush: wp });
  } catch (err) {
    console.error('ingest error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log('Unified backend listening on', PORT));
