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

// In-memory subscriptions (endpoint -> sub)
const subscriptions = new Map();

app.get('/health', (_req, res)=> res.json({ ok:true, subscribers: subscriptions.size }));

app.post('/subscribe', (req, res)=>{
  if(!assertAuthorized(req)) return res.status(401).json({ ok:false, error:'Unauthorized' });
  const sub = req.body;
  if(!sub?.endpoint) return res.status(400).json({ ok:false, error:'Invalid subscription' });
  subscriptions.set(sub.endpoint, sub);
  res.json({ ok:true, count: subscriptions.size });
});

app.post('/purge-subs', (req, res)=>{
  if(!assertAuthorized(req)) return res.status(401).json({ ok:false, error:'Unauthorized' });
  const n = subscriptions.size;
  subscriptions.clear();
  res.json({ ok:true, removed: n });
});

app.post('/broadcast', async (req, res)=>{
  if(!assertAuthorized(req)) return res.status(401).json({ ok:false, error:'Unauthorized' });
  const { title = 'The Capitol Wire', body = 'New alert', url='https://thecapitolwire.com' } = req.body || {};
  const payload = JSON.stringify({ title, body, data: { url } });
  let sent = 0, removed = 0, failures = [];
  for(const [endpoint, sub] of subscriptions.entries()){
    try{
      await webpush.sendNotification(sub, payload);
      sent++;
    }catch(err){
      const code = err?.statusCode;
      // Clean up any bad/expired/forbidden subs
      if([400,401,403,404,410].includes(code)){
        subscriptions.delete(endpoint);
        removed++;
      }else{
        console.error('webpush error', code || err?.message);
      }
      failures.push(code || err?.message);
    }
  }
  res.json({ ok:true, sent, active: subscriptions.size, removed, failures });
});

app.listen(PORT, ()=> console.log('Capitol Wire backend patched listening on', PORT));
