// PHS ENVIRONNEMENT — Agent WhatsApp IA v2
// Sans Puppeteer — Compatible Railway

const express  = require('express');
const twilio   = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const fs   = require('fs');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM  = process.env.TWILIO_WHATSAPP_FROM;
const ANTH_KEY     = process.env.ANTHROPIC_API_KEY;
const PUBLIC_URL   = process.env.PUBLIC_URL || '';
const PORT         = process.env.PORT || 3000;

const twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
const anthropic    = new Anthropic({ apiKey: ANTH_KEY });

const sessions = {};
let devisCtr = 1;

const SYSTEM = `Tu es l'Agent IA de PHS Environnement, assistant WhatsApp spécialisé en gestion des déchets industriels au Maroc (Kénitra).
Agrément N°2022/15 | ISO 9001:2015 | 0537 37 74 17 | phs.maroc@gmail.com
Services: Collecte DIB, DD, Recyclage, Destruction confidentielle, BSD.
Clients: Coca-Cola, Driscoll's, Grupo Bimbo, Planasa, Novares.
Réglementation: Loi 28-00, Loi 11-03, BSD obligatoire DD.

Réponds en français, de façon concise (WhatsApp).
Si demande de devis → <<<DEVIS>>> + JSON
Si modification → <<<MODIFIER>>> + JSON
Si génération → <<<PDF>>>
Si annulation → <<<ANNULER>>>

FORMAT DEVIS:
<<<DEVIS>>>
{"client":"","contact":"","tel":"","email":"","lignes":[{"desc":"","unite":"tonne","qte":1,"pu":0}],"notes":""}`;

app.post('/webhook', async (req, res) => {
  const from    = req.body.From || '';
  const body    = (req.body.Body || '').trim();
  const userNum = from.replace('whatsapp:', '');
  console.log(`[${userNum}] ${body}`);

  if (!sessions[userNum]) sessions[userNum] = { history: [], devis: null };
  const sess = sessions[userNum];
  let reply = '';

  try {
    if (/^(aide|help|\?)$/i.test(body)) {
      reply = aide();
    } else if (/^annuler$/i.test(body)) {
      sess.devis = null;
      reply = '❌ Devis annulé. Tapez *nouveau devis* pour recommencer.';
    } else if (/^(pdf|générer|generer|envoyer)$/i.test(body)) {
      reply = sess.devis ? await envoyerDevis(from, sess) : '⚠️ Aucun devis en cours.';
    } else {
      sess.history.push({ role: 'user', content: body });
      const res2 = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: SYSTEM,
        messages: sess.history
      });
      const ai = res2.content[0].text;
      sess.history.push({ role: 'assistant', content: ai });

      if (ai.includes('<<<DEVIS>>>'))    reply = creerDevis(ai, sess);
      else if (ai.includes('<<<MODIFIER>>>')) reply = modifierDevis(ai, sess);
      else if (ai.includes('<<<PDF>>>'))  reply = sess.devis ? await envoyerDevis(from, sess) : '⚠️ Aucun devis en cours.';
      else if (ai.includes('<<<ANNULER>>>')) { sess.devis = null; reply = '❌ Devis annulé.'; }
      else reply = ai;
    }
  } catch (e) {
    console.error(e.message);
    reply = '⚠️ Erreur temporaire. Réessayez.';
  }

  if (reply) {
    await twilioClient.messages.create({ from: TWILIO_FROM, to: from, body: reply }).catch(e => console.error('Twilio:', e.message));
  }
  res.status(200).send('<Response></Response>');
});

function creerDevis(ai, sess) {
  try {
    const json = JSON.parse(ai.split('<<<DEVIS>>>')[1].trim().replace(/```json|```/g, '').trim());
    const num  = `PHS-${new Date().getFullYear()}-${String(devisCtr++).padStart(3,'0')}`;
    sess.devis = { num, date: new Date().toLocaleDateString('fr-MA'), ...json };
    const ttc  = (json.lignes||[]).reduce((s,l) => s + Number(l.qte)*Number(l.pu), 0) * 1.2;
    return `✅ *Devis ${num} créé !*\n\n👤 *Client :* ${json.client||'—'}\n📦 *Prestations :*\n${lignesText(json.lignes)}\n\n💰 *TOTAL TTC :* ${fmt(ttc)} MAD\n\n• Tapez *modifier* pour ajuster\n• Tapez *pdf* pour recevoir le devis`;
  } catch(e) { return '⚠️ Précisez le client, la prestation, la quantité et le prix.'; }
}

function modifierDevis(ai, sess) {
  if (!sess.devis) return '⚠️ Aucun devis en cours.';
  try {
    const json = JSON.parse(ai.split('<<<MODIFIER>>>')[1].trim().replace(/```json|```/g,'').trim());
    Object.assign(sess.devis, json);
    const ttc = (sess.devis.lignes||[]).reduce((s,l) => s + Number(l.qte)*Number(l.pu), 0) * 1.2;
    return `✏️ *Devis ${sess.devis.num} mis à jour !*\n\n${lignesText(sess.devis.lignes)}\n\n💰 *TOTAL TTC :* ${fmt(ttc)} MAD\n\nTapez *pdf* pour recevoir le devis.`;
  } catch(e) { return '⚠️ Précisez ce que vous souhaitez modifier.'; }
}

async function envoyerDevis(from, sess) {
  const d = sess.devis;
  try {
    const dir  = path.join(__dirname, 'public', 'devis');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = `devis-${d.num}-${Date.now()}.html`;
    fs.writeFileSync(path.join(dir, file), buildHTML(d));
    const url  = `${PUBLIC_URL}/devis/${file}`;
    await twilioClient.messages.create({ from: TWILIO_FROM, to: from,
      body: `📄 *Votre devis ${d.num} est prêt !*\n\n${url}\n\n_(Ouvrez dans Chrome → Menu → Imprimer → Enregistrer en PDF)_\n\n_PHS Environnement — Agrément N°2022/15_`
    });
    sess.devis = null;
    return null;
  } catch(e) { console.error(e.message); return '⚠️ Erreur génération. Réessayez.'; }
}

function buildHTML(d) {
  const sub = (d.lignes||[]).reduce((s,l) => s + Number(l.qte)*Number(l.pu), 0);
  const rows = (d.lignes||[]).filter(l=>l.desc).map((l,i) =>
    `<tr style="background:${i%2?'#f9fdfd':'#fff'}">
      <td style="padding:9px 11px;border-bottom:1px solid #f0f0f0">${l.desc}</td>
      <td style="padding:9px 11px;border-bottom:1px solid #f0f0f0;text-align:center">${l.unite}</td>
      <td style="padding:9px 11px;border-bottom:1px solid #f0f0f0;text-align:right">${l.qte}</td>
      <td style="padding:9px 11px;border-bottom:1px solid #f0f0f0;text-align:right">${fmt(l.pu)} MAD</td>
      <td style="padding:9px 11px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:700;color:#007d88">${fmt(Number(l.qte)*Number(l.pu))} MAD</td>
    </tr>`).join('');
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Devis ${d.num} — PHS</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',sans-serif;font-size:13px;background:#f4f7f6;padding:20px}
.doc{background:#fff;max-width:780px;margin:0 auto;padding:44px 50px;border-radius:4px;box-shadow:0 4px 24px rgba(0,0,0,.1)}
@media print{body{background:#fff;padding:0}.doc{box-shadow:none;padding:30px}.no-print{display:none}}
.pbtn{display:block;margin:0 auto 20px;padding:11px 28px;background:#00A8B5;color:#fff;border:none;border-radius:9px;font-size:14px;font-weight:600;cursor:pointer}
</style></head><body>
<button class="pbtn no-print" onclick="window.print()">🖨️ Imprimer / Enregistrer PDF</button>
<div class="doc">
<div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #00A8B5;padding-bottom:18px;margin-bottom:22px;flex-wrap:wrap;gap:12px">
  <div>
    <div style="font-size:21px;font-weight:800;color:#00A8B5">PHS Environnement</div>
    <div style="font-size:9px;color:#aaa;letter-spacing:1px;text-transform:uppercase;margin-top:2px">Performance Hygiène & Services</div>
    <div style="font-size:11px;color:#555;margin-top:10px;line-height:1.8">14 Rue Haroun Errachid, Rés. ARIJ, Mimosas — Kénitra<br/>0537 37 74 17 | 0707 02 04 18 | phs.maroc@gmail.com<br/><strong>Agrément N°2022/15 | ISO 9001:2015 AFNOR</strong></div>
  </div>
  <div style="text-align:right">
    <div style="font-size:9px;color:#aaa;letter-spacing:2px;text-transform:uppercase">DEVIS</div>
    <div style="font-size:26px;font-weight:800">${d.num}</div>
    <div style="font-size:11px;color:#666;margin-top:5px">Date : ${d.date}</div>
    <div style="font-size:11px;color:#666">Validité : 30 jours</div>
  </div>
</div>
<div style="background:#f8fffe;border:1.5px solid #dce8e7;border-radius:9px;padding:13px 17px;margin-bottom:24px">
  <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#00A8B5;font-weight:700;margin-bottom:5px">Destinataire</div>
  <div style="font-size:15px;font-weight:700">${d.client||'—'}</div>
  <div style="font-size:11px;color:#555;margin-top:4px;line-height:1.65">${[d.contact&&`Contact : ${d.contact}`,d.email&&`Email : ${d.email}`,d.tel&&`Tél : ${d.tel}`].filter(Boolean).join('  |  ')}</div>
</div>
<table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:12px">
<thead><tr style="background:#0c1a19">
  <th style="padding:9px 11px;color:#fff;font-size:9.5px;text-transform:uppercase;text-align:left">Description</th>
  <th style="padding:9px 11px;color:#fff;font-size:9.5px;text-transform:uppercase;text-align:center">Unité</th>
  <th style="padding:9px 11px;color:#fff;font-size:9.5px;text-transform:uppercase;text-align:right">Qté</th>
  <th style="padding:9px 11px;color:#fff;font-size:9.5px;text-transform:uppercase;text-align:right">PU HT</th>
  <th style="padding:9px 11px;color:#fff;font-size:9.5px;text-transform:uppercase;text-align:right">Total HT</th>
</tr></thead>
<tbody>${rows}</tbody></table>
<div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px;margin-bottom:24px">
  <div style="display:flex;gap:16px;font-size:12.5px;min-width:260px;justify-content:flex-end"><span style="color:#777;flex:1;text-align:right">Sous-total HT</span><span style="min-width:105px;text-align:right">${fmt(sub)} MAD</span></div>
  <div style="display:flex;gap:16px;font-size:12.5px;min-width:260px;justify-content:flex-end"><span style="color:#777;flex:1;text-align:right">TVA (20%)</span><span style="min-width:105px;text-align:right">${fmt(sub*.2)} MAD</span></div>
  <div style="display:flex;gap:16px;min-width:260px;justify-content:flex-end;border-top:2px solid #00A8B5;padding-top:8px;margin-top:3px">
    <span style="flex:1;text-align:right;font-weight:800;font-size:14px">TOTAL TTC</span>
    <span style="min-width:105px;text-align:right;font-weight:800;font-size:16px;color:#00A8B5">${fmt(sub*1.2)} MAD</span>
  </div>
</div>
${d.notes?`<div style="background:#f9f9f9;border-radius:8px;padding:12px 15px;font-size:11px;color:#555;line-height:1.7;margin-bottom:16px"><strong>Notes :</strong><br/>${d.notes}</div>`:''}
<div style="background:#f9f9f9;border-radius:8px;padding:12px 15px;font-size:11px;color:#555;line-height:1.7;margin-bottom:16px"><strong>Conditions :</strong> Paiement 30 jours fin de mois. Conforme agrément N°2022/15 et Loi 28-00. BSD fourni pour DD. Devis valable 30 jours.</div>
<div style="border-top:1px solid #eee;padding-top:13px;text-align:center;font-size:10px;color:#bbb;line-height:1.9">PHS — Performance Hygiène & Services | Kénitra, Maroc<br/><em>"Ensemble valorisons l'avenir"</em></div>
</div></body></html>`;
}

app.use('/devis', express.static(path.join(__dirname, 'public', 'devis')));
app.get('/', (req, res) => res.send('✅ PHS Agent WhatsApp — En ligne'));

function fmt(n) { return Number(n||0).toLocaleString('fr-MA',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function lignesText(l=[]) { return l.map(x => `  • ${x.desc} : ${x.qte} ${x.unite} × ${fmt(x.pu)} MAD = *${fmt(Number(x.qte)*Number(x.pu))} MAD*`).join('\n'); }
function aide() {
  return `🤖 *PHS Agent IA — Aide*\n\n*Créer un devis :*\n_"Devis pour Driscoll's, 5t plastiques à 800 MAD"_\n\n*Modifier :*\n_"Change le prix à 850 MAD"_\n\n*Recevoir le devis :*\nTapez *pdf*\n\n*Annuler :*\nTapez *annuler*\n\n📞 0537 37 74 17`;
}

app.listen(PORT, () => console.log(`✅ PHS Agent WhatsApp démarré sur le port ${PORT}`));
