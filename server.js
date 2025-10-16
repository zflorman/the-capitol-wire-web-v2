import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';
import webpush from 'web-push';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));
app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-HillPulse-Key');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  if(req.method==='OPTIONS') return res.sendStatus(200);
  next();
});

// ---- Config ----
const PORT = process.env.PORT || 10000;
const INGEST_SECRET = process.env.INGEST_SECRET || '';
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '';
const CONTACT = process.env.CONTACT || 'mailto:alerts@thecapitolwire.com';

function assertAuthorized(req){
  if(!INGEST_SECRET) return true;
  const h = req.get('X-HillPulse-Key') || req.get('Authorization') || '';
  return h === INGEST_SECRET || h === `Bearer ${INGEST_SECRET}`;
}

// ---- Web Push ----
webpush.setVapidDetails(CONTACT, VAPID_PUBLIC || 'X', VAPID_PRIVATE || 'Y');

// In-memory subscriptions (array to keep order; Set endpoints to avoid dupes)
const subscriptions = [];
const endpointSet = new Set();

function addSub(sub){
  if(!sub?.endpoint) return false;
  if(endpointSet.has(sub.endpoint)) return true;
  subscriptions.push(sub);
  endpointSet.add(sub.endpoint);
  return true;
}
function removeSubByEndpoint(endpoint){
  const idx = subscriptions.findIndex(s => s.endpoint === endpoint);
  if(idx >= 0){ subscriptions.splice(idx,1); }
  endpointSet.delete(endpoint);
}

app.get('/health', (_req, res)=> res.json({ ok:true, subscribers: subscriptions.length }));

app.post('/subscribe', (req, res)=>{
  if(!assertAuthorized(req)) return res.status(401).json({ ok:false, error:'Unauthorized' });
  const sub = req.body;
  if(!sub?.endpoint) return res.status(400).json({ ok:false, error:'Invalid subscription' });
  addSub(sub);
  res.json({ ok:true, count: subscriptions.length });
});

app.post('/purge-subs', (req, res)=>{
  if(!assertAuthorized(req)) return res.status(401).json({ ok:false, error:'Unauthorized' });
  subscriptions.length = 0;
  endpointSet.clear();
  res.json({ ok:true, removed: true });
});

// Inspect stored subs (last 5 endpoints only)
app.get('/list-subs', (req, res)=>{
  if(!assertAuthorized(req)) return res.status(401).json({ ok:false, error:'Unauthorized' });
  const list = subscriptions.slice(-5).map(s => ({
    endpoint: s.endpoint.slice(0, 64) + '...',
    hasKeys: !!s.keys,
    p256dhLen: s?.keys?.p256dh ? s.keys.p256dh.length : null,
    authLen: s?.keys?.auth ? s.keys.auth.length : null
  }));
  res.json({ ok:true, total: subscriptions.length, sample: list });
});

// Send to everyone
app.post('/broadcast', async (req, res)=>{
  if(!assertAuthorized(req)) return res.status(401).json({ ok:false, error:'Unauthorized' });
  const { title = 'The Capitol Wire', body = 'New alert', url='https://thecapitolwire.com' } = req.body || {};
  const payload = JSON.stringify({ title, body, data: { url } });
  let sent = 0, removed = 0, failures = [];
  for(const sub of [...subscriptions]){
    try{
      await webpush.sendNotification(sub, payload);
      sent++;
    }catch(err){
      const code = err?.statusCode;
      // Only remove definitively dead subs
      if([404,410].includes(code)){
        removeSubByEndpoint(sub.endpoint);
        removed++;
      }else{
        failures.push(code || err?.message);
        console.error('webpush error', code || err?.message);
      }
    }
  }
  res.json({ ok:true, sent, active: subscriptions.length, removed, failures });
});

// Send only to the most recent subscription
app.post('/broadcast-latest', async (req, res)=>{
  if(!assertAuthorized(req)) return res.status(401).json({ ok:false, error:'Unauthorized' });
  if(subscriptions.length === 0) return res.json({ ok:true, sent:0, reason:'no subscribers' });
  const sub = subscriptions[subscriptions.length - 1];
  const { title = 'The Capitol Wire', body = 'New alert', url='https://thecapitolwire.com' } = req.body || {};
  const payload = JSON.stringify({ title, body, data: { url } });
  try{
    await webpush.sendNotification(sub, payload);
    return res.json({ ok:true, sent:1 });
  }catch(err){
    const code = err?.statusCode || err?.message;
    return res.json({ ok:false, error: code });
  }
});

app.listen(PORT, ()=> console.log('Capitol Wire backend patch v2 listening on', PORT));
