// ============================================================
// PHS ENVIRONNEMENT — Agent WhatsApp IA
// Serveur Node.js — Twilio + Claude + PDF
// ============================================================

const express = require('express');
const twilio  = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── CONFIG (mettez vos vraies valeurs dans Railway Variables) ──
const TWILIO_SID    = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM   = process.env.TWILIO_WHATSAPP_FROM; // ex: whatsapp:+212XXXXXXXXX
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PORT          = process.env.PORT || 3000;

const client     = twilio(TWILIO_SID, TWILIO_TOKEN);
const anthropic  = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── MÉMOIRE DES CONVERSATIONS (par numéro WhatsApp) ──────────
const sessions = {};   // { "+212XXXXXX": { history: [], devisCourant: {} } }
const devisDB  = [];   // Stockage simple en mémoire (remplacez par SQLite si besoin)
let devisCtr   = 1;

// ── SYSTEM PROMPT PHS ─────────────────────────────────────────
const SYSTEM = `Tu es l'Agent IA de PHS Environnement, assistant WhatsApp spécialisé en gestion des déchets industriels au Maroc (Kénitra).

IDENTITÉ PHS :
• Agrément N°2022/15 | ISO 9001:2015 AFNOR
• 14 Rue Haroun Errachid, Résidence ARIJ, Mimosas, Kénitra
• Tél : 0537 37 74 17 | 0707 02 04 18 | 0603 45 35 68
• phs.maroc@gmail.com | www.hygiene-environnement.ma
• Slogan : "Ensemble valorisons l'avenir"

SERVICES : Collecte DIB, Déchets Dangereux, Recyclage (plastiques, papier, métaux, DEEE), Destruction confidentielle, BSD/traçabilité.
CLIENTS : Coca-Cola, Driscoll's, Grupo Bimbo, Planasa, Novares, Kromberg & Schubert.
RÉGLEMENTATION : Loi 28-00, Loi 11-03, BSD obligatoire déchets dangereux.

COMPORTEMENT :
- Tu communiques par WhatsApp, sois concis et professionnel
- Réponds en français
- Pour un devis, extrais les infos et réponds avec <<<DEVIS>>> suivi du JSON
- Pour modifier un devis existant, réponds avec <<<MODIFIER>>> suivi du JSON de modification
- Pour générer le PDF, réponds avec <<<PDF>>>
- Pour annuler, réponds avec <<<ANNULER>>>

COMMANDES RECONNUES (si l'utilisateur les tape) :
- "devis", "nouveau devis" → créer un devis
- "modifier", "changer" → modifier le devis en cours
- "pdf", "générer", "envoyer" → générer et envoyer le PDF
- "annuler", "supprimer" → annuler le devis en cours
- "aide", "help" → afficher l'aide

FORMAT JSON DEVIS :
<<<DEVIS>>>
{
  "client": "",
  "contact": "",
  "tel": "",
  "email": "",
  "lignes": [
    { "desc": "", "unite": "tonne", "qte": 1, "pu": 0 }
  ],
  "notes": ""
}

FORMAT JSON MODIFICATION :
<<<MODIFIER>>>
{
  "champ": "valeur modifiée",
  "lignes": [...]  // optionnel, si modification des prestations
}`;

// ── ROUTE PRINCIPALE WEBHOOK TWILIO ──────────────────────────
app.post('/webhook', async (req, res) => {
  const from    = req.body.From;  // ex: "whatsapp:+212600000000"
  const body    = (req.body.Body || '').trim();
  const userNum = from.replace('whatsapp:', '');

  console.log(`📩 [${userNum}] : ${body}`);

  // Initialiser la session
  if (!sessions[userNum]) {
    sessions[userNum] = { history: [], devisCourant: null };
  }
  const session = sessions[userNum];

  let reponse = '';

  try {
    // Commandes directes
    if (/^(aide|help|\?)$/i.test(body)) {
      reponse = formatAide();
    } else if (/^(annuler|supprimer|cancel)$/i.test(body)) {
      session.devisCourant = null;
      reponse = '❌ Devis annulé.\n\nTapez *nouveau devis* pour recommencer.';
    } else if (/^(pdf|générer|envoyer|generer)$/i.test(body) && session.devisCourant) {
      reponse = await handlePDF(userNum, session, from);
    } else {
      // Appel Claude IA
      session.history.push({ role: 'user', content: body });

      const completion = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: SYSTEM,
        messages: session.history
      });

      const aiText = completion.content[0].text;
      session.history.push({ role: 'assistant', content: aiText });

      // Traitement des commandes IA
      if (aiText.includes('<<<DEVIS>>>')) {
        reponse = await handleNouveauDevis(aiText, session, userNum);
      } else if (aiText.includes('<<<MODIFIER>>>')) {
        reponse = handleModification(aiText, session);
      } else if (aiText.includes('<<<PDF>>>')) {
        reponse = await handlePDF(userNum, session, from);
      } else if (aiText.includes('<<<ANNULER>>>')) {
        session.devisCourant = null;
        reponse = '❌ Devis annulé.\n\nTapez *nouveau devis* pour recommencer.';
      } else {
        reponse = aiText;
      }
    }
  } catch (err) {
    console.error('Erreur:', err);
    reponse = '⚠️ Une erreur est survenue. Réessayez ou contactez le support PHS.';
  }

  // Envoyer la réponse WhatsApp
  await envoyerMessage(from, reponse);

  res.status(200).send('<Response></Response>');
});

// ── HANDLERS ──────────────────────────────────────────────────

async function handleNouveauDevis(aiText, session, userNum) {
  try {
    const jsonStr = aiText.split('<<<DEVIS>>>')[1].trim().replace(/```json|```/g, '').trim();
    const data = JSON.parse(jsonStr);

    const num = `PHS-${new Date().getFullYear()}-${String(devisCtr++).padStart(3, '0')}`;
    session.devisCourant = {
      num,
      date: new Date().toLocaleDateString('fr-MA'),
      ...data,
      userNum
    };

    const sub = (data.lignes || []).reduce((s, l) => s + (Number(l.qte) * Number(l.pu)), 0);
    const ttc = sub * 1.2;

    return `✅ *Devis ${num} créé !*\n\n` +
      `👤 *Client :* ${data.client || '—'}\n` +
      `📦 *Prestations :*\n${formatLignes(data.lignes)}\n` +
      `💰 *TOTAL TTC :* ${fmad(ttc)} MAD\n\n` +
      `📋 *Que voulez-vous faire ?*\n` +
      `• Tapez *modifier* pour ajuster\n` +
      `• Tapez *pdf* pour recevoir le devis\n` +
      `• Tapez *annuler* pour recommencer`;
  } catch (e) {
    return '⚠️ Je n\'ai pas pu créer le devis. Donnez-moi plus de détails sur le client et les prestations.';
  }
}

function handleModification(aiText, session) {
  if (!session.devisCourant) {
    return '⚠️ Aucun devis en cours. Commencez par créer un devis.';
  }
  try {
    const jsonStr = aiText.split('<<<MODIFIER>>>')[1].trim().replace(/```json|```/g, '').trim();
    const modifs = JSON.parse(jsonStr);
    Object.assign(session.devisCourant, modifs);

    const sub = (session.devisCourant.lignes || []).reduce((s, l) => s + (Number(l.qte) * Number(l.pu)), 0);
    const ttc = sub * 1.2;

    return `✏️ *Devis ${session.devisCourant.num} mis à jour !*\n\n` +
      `📦 *Prestations :*\n${formatLignes(session.devisCourant.lignes)}\n` +
      `💰 *TOTAL TTC :* ${fmad(ttc)} MAD\n\n` +
      `Tapez *pdf* pour recevoir le devis final.`;
  } catch (e) {
    return '⚠️ Modification impossible. Précisez ce que vous voulez changer.';
  }
}

async function handlePDF(userNum, session, from) {
  if (!session.devisCourant) {
    return '⚠️ Aucun devis en cours. Commencez par créer un devis.';
  }

  try {
    const pdfPath = await genererPDF(session.devisCourant);
    const pdfUrl  = `${process.env.PUBLIC_URL}/pdf/${path.basename(pdfPath)}`;

    // Enregistrer dans la base
    devisDB.push({ ...session.devisCourant, pdfUrl, createdAt: new Date().toISOString() });

    // Envoyer le lien PDF via WhatsApp
    await client.messages.create({
      from: TWILIO_FROM,
      to: from,
      body: `📄 *Votre devis ${session.devisCourant.num} est prêt !*\n\n` +
            `Cliquez ici pour télécharger le PDF :\n${pdfUrl}\n\n` +
            `_PHS Environnement — Agrément N°2022/15_`,
    });

    session.devisCourant = null;
    return null; // Message déjà envoyé directement
  } catch (e) {
    console.error('Erreur PDF:', e);
    return '⚠️ Erreur lors de la génération du PDF. Réessayez.';
  }
}

// ── GÉNÉRATION PDF AVEC PUPPETEER ─────────────────────────────
async function genererPDF(devis) {
  const html = buildHTMLDevis(devis);
  const pdfDir = path.join(__dirname, 'public', 'pdf');
  if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });

  const filename = `devis-${devis.num}-${Date.now()}.pdf`;
  const filepath  = path.join(pdfDir, filename);

  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page    = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.pdf({ path: filepath, format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
  await browser.close();

  return filepath;
}

// ── HTML DU DEVIS ─────────────────────────────────────────────
function buildHTMLDevis(d) {
  const sub = (d.lignes || []).reduce((s, l) => s + (Number(l.qte) * Number(l.pu)), 0);
  const tva = sub * 0.2, ttc = sub * 1.2;
  const rows = (d.lignes || []).filter(l => l.desc || l.pu).map((l, i) => `
    <tr style="background:${i % 2 ? '#f9fdfd' : '#fff'}">
      <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0">${l.desc}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;text-align:center">${l.unite}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;text-align:right">${l.qte}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;text-align:right">${fmad(l.pu)} MAD</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:700;color:#007d88">${fmad(Number(l.qte) * Number(l.pu))} MAD</td>
    </tr>`).join('');

  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&display=swap" rel="stylesheet"/>
  <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'DM Sans',sans-serif;font-size:12px;color:#222}</style>
  </head><body>
  <div style="padding:40px 50px;min-height:297mm">
    <!-- EN-TÊTE -->
    <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #00A8B5;padding-bottom:18px;margin-bottom:22px;flex-wrap:wrap;gap:10px">
      <div>
        <div style="font-size:20px;font-weight:800;color:#00A8B5">PHS Environnement</div>
        <div style="font-size:9px;color:#aaa;letter-spacing:1px;text-transform:uppercase;margin-top:2px">Performance Hygiène & Services</div>
        <div style="font-size:11px;color:#555;margin-top:10px;line-height:1.8">
          14 Rue Haroun Errachid, Rés. ARIJ, Mimosas — Kénitra<br/>
          0537 37 74 17 | 0707 02 04 18 | phs.maroc@gmail.com<br/>
          <strong>Agrément N°2022/15 | ISO 9001:2015 AFNOR</strong>
        </div>
      </div>
      <div style="text-align:right">
        <div style="font-size:9px;color:#aaa;letter-spacing:2px;text-transform:uppercase">DEVIS</div>
        <div style="font-size:24px;font-weight:800">${d.num}</div>
        <div style="font-size:11px;color:#666;margin-top:5px">Date : ${d.date}</div>
        <div style="font-size:11px;color:#666">Validité : 30 jours</div>
      </div>
    </div>

    <!-- CLIENT -->
    <div style="background:#f8fffe;border:1.5px solid #dce8e7;border-radius:9px;padding:12px 16px;margin-bottom:22px">
      <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#00A8B5;font-weight:700;margin-bottom:4px">Destinataire</div>
      <div style="font-size:15px;font-weight:700">${d.client || '—'}</div>
      <div style="font-size:11px;color:#555;margin-top:3px;line-height:1.65">
        ${[d.contact && `Contact : ${d.contact}`, d.email && `Email : ${d.email}`, d.tel && `Tél : ${d.tel}`].filter(Boolean).join('  |  ')}
      </div>
    </div>

    <!-- TABLEAU -->
    <table style="width:100%;border-collapse:collapse;margin-bottom:18px;font-size:11.5px">
      <thead>
        <tr style="background:#0c1a19">
          <th style="padding:9px 10px;color:#fff;font-size:9.5px;font-weight:700;text-transform:uppercase;text-align:left">Description</th>
          <th style="padding:9px 10px;color:#fff;font-size:9.5px;font-weight:700;text-transform:uppercase;text-align:center">Unité</th>
          <th style="padding:9px 10px;color:#fff;font-size:9.5px;font-weight:700;text-transform:uppercase;text-align:right">Qté</th>
          <th style="padding:9px 10px;color:#fff;font-size:9.5px;font-weight:700;text-transform:uppercase;text-align:right">PU HT</th>
          <th style="padding:9px 10px;color:#fff;font-size:9.5px;font-weight:700;text-transform:uppercase;text-align:right">Total HT</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:#aaa;padding:16px">Aucune prestation</td></tr>'}</tbody>
    </table>

    <!-- TOTAUX -->
    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px;margin-bottom:22px">
      <div style="display:flex;gap:16px;font-size:12px;min-width:250px;justify-content:flex-end">
        <span style="color:#777;flex:1;text-align:right">Sous-total HT</span>
        <span style="min-width:100px;text-align:right">${fmad(sub)} MAD</span>
      </div>
      <div style="display:flex;gap:16px;font-size:12px;min-width:250px;justify-content:flex-end">
        <span style="color:#777;flex:1;text-align:right">TVA (20%)</span>
        <span style="min-width:100px;text-align:right">${fmad(tva)} MAD</span>
      </div>
      <div style="display:flex;gap:16px;min-width:250px;justify-content:flex-end;border-top:2px solid #00A8B5;padding-top:7px;margin-top:3px">
        <span style="flex:1;text-align:right;font-weight:800;font-size:13px">TOTAL TTC</span>
        <span style="min-width:100px;text-align:right;font-weight:800;font-size:16px;color:#00A8B5">${fmad(ttc)} MAD</span>
      </div>
    </div>

    ${d.notes ? `<div style="background:#f9f9f9;border-radius:8px;padding:11px 14px;font-size:11px;color:#555;line-height:1.7;margin-bottom:16px"><strong>Notes :</strong><br/>${d.notes}</div>` : ''}

    <div style="background:#f9f9f9;border-radius:8px;padding:11px 14px;font-size:11px;color:#555;line-height:1.7;margin-bottom:16px">
      <strong>Conditions générales :</strong> Paiement 30 jours fin de mois. Prestations conformes à l'agrément N°2022/15 et à la Loi 28-00. BSD fourni pour tout déchet dangereux. Devis valable 30 jours.
    </div>

    <div style="border-top:1px solid #eee;padding-top:12px;text-align:center;font-size:10px;color:#bbb;line-height:1.9;margin-top:auto">
      PHS — Performance Hygiène & Services | Kénitra, Maroc | "Ensemble valorisons l'avenir"<br/>
      www.hygiene-environnement.ma | phs.maroc@gmail.com
    </div>
  </div>
  </body></html>`;
}

// ── SERVEUR FICHIERS STATIQUES (PDFs) ─────────────────────────
app.use('/pdf', express.static(path.join(__dirname, 'public', 'pdf')));

// ── UTILITAIRES ───────────────────────────────────────────────
function fmad(n) {
  return Number(n || 0).toLocaleString('fr-MA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatLignes(lignes = []) {
  return lignes.map(l => `  • ${l.desc} : ${l.qte} ${l.unite} × ${fmad(l.pu)} MAD = *${fmad(Number(l.qte) * Number(l.pu))} MAD*`).join('\n');
}

function formatAide() {
  return `🤖 *PHS Agent IA — Aide*\n\n` +
    `*Créer un devis :*\n_"Devis pour Driscoll's, 5 tonnes plastiques à 800 MAD la tonne"_\n\n` +
    `*Modifier un devis :*\n_"Change le prix à 850 MAD"_\n_"Ajoute le transport 400 MAD forfait"_\n\n` +
    `*Recevoir le PDF :*\nTapez *pdf* ou *générer*\n\n` +
    `*Annuler :*\nTapez *annuler*\n\n` +
    `*Questions :*\n_"Qu'est-ce que la Loi 28-00 ?"_\n_"Quels déchets traitez-vous ?"_\n\n` +
    `📞 Support : 0537 37 74 17`;
}

async function envoyerMessage(to, message) {
  if (!message) return;
  await client.messages.create({ from: TWILIO_FROM, to, body: message });
}

// ── DÉMARRAGE ─────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅ PHS Agent WhatsApp démarré sur le port ${PORT}`));
