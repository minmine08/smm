// Livraison dynamique SellAuth -> Bulk Medya (Vercel serverless function)
//
// URL à mettre dans SellAuth (une par produit / variant) :
//   https://TON-PROJET.vercel.app/api/delivery?secret=TON_SECRET&s=ig_followers&qty=1000
//
//   s      = quel service (voir SERVICES ci-dessous)
//   qty    = quantité livrée pour UN achat de ce variant (ex: variant "1000 followers" -> qty=1000)
//            si le client achète 2 fois ce variant (quantity=2), on envoie qty x 2
//   secret = ton mot de passe (variable DELIVERY_SECRET), pour que personne d'autre ne puisse commander
//   debug=1 = ne commande RIEN, affiche seulement ce que SellAuth envoie (pour tester)
//
// Variables d'environnement Vercel :
//   BULKMEDYA_KEY    (obligatoire) ta clé API Bulk Medya
//   DELIVERY_SECRET  (obligatoire) un mot de passe long et aléatoire
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN (recommandé) pour éviter les doubles commandes

const BM_URL = 'https://bulkmedya.org/api/v2';

const SERVICES = {
  ig_followers:      { id: 67, name: 'Instagram Followers' },
  ig_likes:          { id: 2010,  name: 'Instagram Likes' },
  ig_comments:       { id: 1166,  name: 'Instagram Comments' },
  tt_followers:      { id: 13170, name: 'TikTok Followers' },
  tt_likes:          { id: 13078, name: 'TikTok Likes' },
  tt_comments:       { id: 13485, name: 'TikTok Comments' },
  fb_followers:      { id: 14931, name: 'Facebook Followers' },
  fb_likes:          { id: 7917,  name: 'Facebook Likes' },
  fb_comments:       { id: 16666, name: 'Facebook Comments', custom: true },
  yt_followers:      { id: 6986, name: 'YouTube Subscribers' },
  yt_likes:          { id: 17676, name: 'YouTube Likes' },
  yt_comments:       { id: 6815,  name: 'YouTube Comments', custom: true },
  tw_followers:      { id: 5921,  name: 'Twitter Followers' },
  tw_likes:          { id: 419,   name: 'Twitter Likes' },
  tw_comments:       { id: 6918,  name: 'Twitter Comments' },
  twitch_followers:  { id: 11123, name: 'Twitch Followers' },
};
// custom: true = le service demande une liste de commentaires écrits par le client
// (le client doit remplir un champ "Comments" sur SellAuth, un commentaire par ligne)

// ---------- Outils ----------

// Met toutes les valeurs de ce que SellAuth envoie "à plat" : {"custom_fields.Link": "https://..."}
function flatten(obj, prefix = '', out = {}) {
  if (obj === null || obj === undefined) return out;
  if (typeof obj !== 'object') { out[prefix] = obj; return out; }
  // Format {name: "Link", value: "https://..."} -> out["Link"] = "https://..."
  const label = obj.name ?? obj.label ?? obj.key;
  if (typeof label === 'string' && obj.value !== undefined && typeof obj.value !== 'object') {
    out[label] = obj.value;
  }
  for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

function findValue(flat, regex, exclude) {
  const hit = Object.entries(flat).find(([k, v]) =>
    regex.test(k) && !(exclude && exclude.test(k)) && typeof v === 'string' && v.trim() !== '');
  return hit ? hit[1].trim() : null;
}

function findLink(flat) {
  const entries = Object.entries(flat).filter(([k, v]) =>
    /link|url|profile|username|handle|page|post|video|channel/i.test(k) &&
    !/webhook|callback|product|image|avatar|store|shop|invoice/i.test(k) &&
    typeof v === 'string' && v.trim() !== '');
  // On préfère les champs remplis par le client (custom_fields) à tout autre champ qui ressemble à un lien
  const fromCustom = entries.filter(([k]) => /custom_fields/i.test(k));
  const pool = fromCustom.length ? fromCustom : entries;
  const http = pool.find(([, v]) => /^https?:\/\//i.test(v.trim()));
  return (http || pool[0] || [null, null])[1]?.trim() || null;
}

function findPurchasedQuantity(flat) {
  const hit = Object.entries(flat).find(([k, v]) =>
    /(^|\.)(quantity|qty)$/i.test(k) && Number(v) >= 1);
  return hit ? Math.floor(Number(hit[1])) : 1;
}

function findInvoice(flat) {
  // SellAuth envoie un appel par article : on identifie la commande par l'ID de l'article (anti-doublon précis)
  if (flat['item.id'] !== undefined && flat['item.id'] !== null) return `item${flat['item.id']}`;
  return findValue(flat, /(^|\.)invoice(_id|\.id|Id)?$/i) ||
         findValue(flat, /(^|\.)(invoice_id|order_id|orderId)$/i) ||
         (flat.id !== undefined ? String(flat.id) : null);
}

async function bm(params) {
  const r = await fetch(BM_URL, {
    method: 'POST',
    body: new URLSearchParams({ key: process.env.BULKMEDYA_KEY, ...params }),
  });
  return r.json();
}

// Anti-doublon via Upstash Redis (facultatif mais fortement conseillé)
const redisOn = () => process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN;
async function redis(...cmd) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
    body: JSON.stringify(cmd),
  });
  return (await r.json()).result;
}

// ---------- Handler ----------

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  const q = req.query || {};

  if (!process.env.DELIVERY_SECRET || q.secret !== process.env.DELIVERY_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  const body = typeof req.body === 'string' ? safeJson(req.body) : (req.body || {});
  const flat = flatten({ ...body, ...Object.fromEntries(Object.entries(q).filter(([k]) => !['secret', 's', 'qty', 'debug'].includes(k))) });

  // Mode test : montre ce que SellAuth envoie, ne commande rien
  if (q.debug === '1') {
    console.log('DEBUG payload', JSON.stringify(body));
    return res.status(200).send(
      'DEBUG MODE - aucune commande passée\n\n' +
      `Méthode : ${req.method}\n` +
      `Lien détecté : ${findLink(flat)}\n` +
      `Quantité achetée détectée : ${findPurchasedQuantity(flat)}\n` +
      `Invoice détectée : ${findInvoice(flat)}\n\n` +
      'Données reçues :\n' + JSON.stringify(body, null, 2)
    );
  }

  const svc = SERVICES[q.s];
  const unit = parseInt(q.qty, 10);
  if (!svc || !unit || unit < 1) return res.status(400).send('Invalid product setup');

  const link = findLink(flat);
  if (!link) return res.status(400).send('Missing link');

  const invoice = findInvoice(flat);
  const dedupeKey = invoice ? `bm:${invoice}:${q.s}:${unit}` : null;

  try {
    if (dedupeKey && redisOn()) {
      // SET NX : si la clé existe déjà, cette commande a déjà été traitée
      const ok = await redis('SET', dedupeKey, 'pending', 'NX', 'EX', 60 * 60 * 24 * 30);
      if (ok !== 'OK') {
        const prev = await redis('GET', dedupeKey);
        if (prev && prev !== 'pending') return res.status(200).send(prev);
        return res.status(409).send('Order already in progress');
      }
    }

    const quantity = unit * findPurchasedQuantity(flat);
    const params = { action: 'add', service: svc.id, link };

    if (svc.custom) {
      const comments = findValue(flat, /comment/i, /quantity|count/i);
      if (!comments) { if (dedupeKey && redisOn()) await redis('DEL', dedupeKey); return res.status(400).send('Missing comments'); }
      params.comments = comments;
    } else {
      params.quantity = quantity;
    }

    const out = await bm(params);
    if (!out || !out.order) {
      console.error('Bulk Medya error', JSON.stringify(out), 'service', svc.id);
      if (dedupeKey && redisOn()) await redis('DEL', dedupeKey);
      return res.status(500).send('Delivery failed, please contact support.');
    }

    const msg =
      `${svc.name} - order placed ✅\n` +
      `Order ID: ${out.order}\n` +
      `Link: ${link}\n` +
      (svc.custom ? '' : `Quantity: ${quantity}\n`) +
      'Delivery starts shortly.';
    if (dedupeKey && redisOn()) await redis('SET', dedupeKey, msg, 'EX', 60 * 60 * 24 * 30);
    return res.status(200).send(msg);
  } catch (e) {
    console.error(e);
    if (dedupeKey && redisOn()) { try { await redis('DEL', dedupeKey); } catch (_) {} }
    return res.status(500).send('Delivery failed, please contact support.');
  }
};

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
