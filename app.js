/*
 * app.updated.js
 *
 * GSM2Blogger - Updated to auto-overlay your logo on fetched images
 * - Adds automatic logo download-from-URL (GitHub raw or other) with local fallback
 * - Uses sharp to composite the transparent PNG logo onto article images
 * - Keeps original application workflow intact; failsafe fallbacks ensure posts continue
 *
 * Environment variables (add to your .env on Replit / hosting):
 * OPENAI_API_KEY, CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN, BLOG_ID, GSMARENA_RSS
 * POST_INTERVAL_CRON (optional)
 * MAX_ITEMS_PER_RUN (optional)
 * OPENAI_MODEL (optional)
 * DB_PATH (optional)
 * USER_AGENT (optional)
 *
 * NEW/OPTIONAL env vars for logo handling:
 * LOGO_URL            - direct URL to your logo (raw GitHub URL or CDN). Example: https://raw.githubusercontent.com/user/repo/main/logo.png
 * LOGO_LOCAL_PATH     - local fallback path for logo (default: ./assets/logo.png)
 * LOGO_AUTO_UPDATE    - if 'true', app will try to download LOGO_URL on start (default: true)
 * LOGO_OPACITY        - overlay opacity (0.0 - 1.0) default 0.7
 * LOGO_GRAVITY        - position for logo: 'southeast'|'southwest'|'northwest'|'northeast'|'center' (default 'southeast')
 * LOGO_MAX_WIDTH_PCT  - maximum logo width as percent of base image width (0.0 - 1.0) default 0.25 (25%)
 *
 * Important: Put a transparent PNG at assets/logo.png as local fallback.
 */

import 'dotenv/config';
import Parser from 'rss-parser';
import axios from 'axios';
import Database from 'better-sqlite3';
import { GoogleApis } from 'googleapis';
import OpenAI from 'openai';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const BLOG_ID = process.env.BLOG_ID;

const GSMARENA_RSS = process.env.GSMARENA_RSS;
const POST_INTERVAL_CRON = process.env.POST_INTERVAL_CRON || '0 */3 * * *';
const MAX_ITEMS_PER_RUN = parseInt(process.env.MAX_ITEMS_PER_RUN || '1', 10);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DB_PATH = process.env.DB_PATH || './data/posts.db';
const MODE = (process.env.MODE || 'cron').toLowerCase();
const USER_AGENT = process.env.USER_AGENT || 'GSM2Blogger/1.0';

// Logo-related envs
const LOGO_URL = process.env.LOGO_URL || ''; // direct raw URL (optional)
const LOGO_LOCAL_PATH = process.env.LOGO_LOCAL_PATH || path.join(__dirname, 'assets', 'logo.png');
const LOGO_AUTO_UPDATE = (process.env.LOGO_AUTO_UPDATE || 'true').toLowerCase() === 'true';
const LOGO_OPACITY = parseFloat(process.env.LOGO_OPACITY || '0.7');
const LOGO_GRAVITY = process.env.LOGO_GRAVITY || 'southeast';
const LOGO_MAX_WIDTH_PCT = parseFloat(process.env.LOGO_MAX_WIDTH_PCT || '0.25');

if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY not set in .env');
  process.exit(1);
}
if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !BLOG_ID) {
  console.error('ERROR: Blogger OAuth config missing');
  process.exit(1);
}

const parser = new Parser();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const google = new GoogleApis();
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.prepare(`
  CREATE TABLE IF NOT EXISTS posted (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE,
    link TEXT UNIQUE,
    title TEXT,
    published_at TEXT,
    posted_at TEXT DEFAULT (datetime('now'))
  )
`).run();

function hasBeenPosted(guidOrLink) {
  const row = db.prepare('SELECT 1 FROM posted WHERE guid = ? OR link = ?').get(guidOrLink, guidOrLink);
  return !!row;
}
function markPosted({ guid, link, title, published_at }) {
  const stmt = db.prepare('INSERT OR IGNORE INTO posted (guid, link, title, published_at) VALUES (?, ?, ?, ? )');
  stmt.run(guid, link, title, published_at || null);
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function fetchPage(url) {
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15000
    });
    return res.data;
  } catch (e) {
    return null;
  }
}

function extractFirstImageFromHtml(html) {
  if (!html) return null;
  const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];
  return null;
}

function extractOgImage(html) {
  if (!html) return null;
  const m = html.match(/property=["']og:image["']\s*content=["']([^"']+)["']/i) || html.match(/<meta[^>]*name=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  if (m) return m[1];
  return null;
}

function extractMainArticle(html) {
  if (!html) return null;

  // GSMArena
  let match = html.match(/<div class=\"article-body\">([\s\S]*?)<\/div>/i);
  if (match) return match[1];

  // Engadget
  match = html.match(/<div[^>]*class=[\"']o-article-blocks[\"'][^>]*>([\s\S]*?)<\/div>/i);
  if (match) return match[1];

  return null;
}

// === NEW: Auto-download logo on start (if LOGO_URL provided) ===
async function downloadLogoIfNeeded() {
  try {
    if (!LOGO_URL || !LOGO_AUTO_UPDATE) return;
    log('Attempting to download logo from', LOGO_URL);
    const res = await axios.get(LOGO_URL, { responseType: 'arraybuffer', timeout: 8000, headers: { 'User-Agent': USER_AGENT } });
    if (res.status === 200 && res.data) {
      const dir = path.dirname(LOGO_LOCAL_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(LOGO_LOCAL_PATH, Buffer.from(res.data));
      log('Logo downloaded to', LOGO_LOCAL_PATH);
    }
  } catch (e) {
    log('Logo download failed, using local fallback if present:', e.message || e);
  }
}

async function overlayLogoOnImage(imageUrl) {
  try {
    // fetch base image
    const imageResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000, headers: { 'User-Agent': USER_AGENT } });
    const baseBuffer = Buffer.from(imageResp.data);
    const baseImg = sharp(baseBuffer);
    const meta = await baseImg.metadata();
    const baseW = meta.width || 800;

    // read logo (local fallback)
    if (!fs.existsSync(LOGO_LOCAL_PATH)) {
      log('Logo not found at', LOGO_LOCAL_PATH, '— skipping overlay');
      // return original remote URL so we don't break anything
      return imageUrl;
    }
    let logoBuffer = fs.readFileSync(LOGO_LOCAL_PATH);
    const logoMeta = await sharp(logoBuffer).metadata();

    // Resize logo to a percentage of base image width (preserve aspect)
    const maxLogoW = Math.max(40, Math.floor(baseW * LOGO_MAX_WIDTH_PCT));
    if ((logoMeta.width || 0) > maxLogoW) {
      logoBuffer = await sharp(logoBuffer).resize({ width: maxLogoW }).toBuffer();
    }

    // Compose with opacity and gravity
    const composed = await baseImg
      .composite([{
        input: logoBuffer,
        gravity: LOGO_GRAVITY,
        blend: 'over',
        opacity: isNaN(LOGO_OPACITY) ? 0.7 : Math.max(0, Math.min(1, LOGO_OPACITY))
      }])
      .png()
      .toBuffer();

    // save temp file
    const outDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `img_${Date.now()}.png`);
    fs.writeFileSync(outPath, composed);

    // optional: cleanup older temps (keep last 10)
    try {
      const files = fs.readdirSync(outDir).map(f => ({ f, t: fs.statSync(path.join(outDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      const keep = 10;
      for (let i = keep; i < files.length; i++) {
        try { fs.unlinkSync(path.join(outDir, files[i].f)); } catch(e){}
      }
    } catch(e){}

    return outPath;
  } catch (e) {
    log('overlayLogoOnImage failed:', e.message || e);
    return imageUrl;
  }
}
// ==============================================================

// === OPENAI helpers (unchanged except small tweaks) ===
async function rewriteTitleWithOpenAI(originalTitle) {
  const prompt = `You are a professional SEO headline writer. Rewrite the following news article title into a **highly unique, click-worthy, and SEO-optimized headline (Title)**. The new title must convey the same meaning but must be completely different phrasing.\n  \n  Original Title: "${originalTitle}"\n  \n  Return **ONLY** the new headline text, with no quotation marks or extra text.`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 50
    });
    let newTitle = completion.choices?.[0]?.message?.content || originalTitle;
    newTitle = newTitle.trim().replace(/^["']|["']$/g, '');
    return newTitle.length > 5 ? newTitle : originalTitle;

  } catch (err) {
    log('OpenAI Title rewrite error:', err?.message || err);
    return originalTitle;
  }
}

async function rewriteWithOpenAI({ title, snippet, content }) {
  const prompt = `You are a highly skilled SEO Content Writer. Rewrite the following article into a **unique, high-quality, and comprehensive English news post** for a professional tech blog.\n\nRules for SEO and Originality:\n1.  **Originality First:** Your main goal is to generate content that is **NOT duplicate**. Paraphrase and restructure the input completely.\n2.  **Completeness/Depth:** The post must fully answer the user's intent. **Expand the topic to reach a minimum length of 1200 words** (unless the topic is extremely simple).\n3.  **Structure:** Use a compelling main headline (H1) and relevant, structured subheadings (H2, H3) for readability and SEO.\n4.  **Formatting:** Use standard HTML formatting (p, strong, ul, ol).\n5.  **Clean Output:** **DO NOT** include any links (hyperlinks/<a> tags). **DO NOT** include any introductory or concluding remarks outside the main article body.\n6.  **Language:** Write in professional, clear English only.\n7.  **Output Format:** Return **ONLY** the final HTML content for the article body. DO NOT wrap the output in markdown code blocks (```html).`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: `${prompt}\n\nTitle: ${title}\n\nSnippet: ${snippet || ''}\n\nContent:\n${content || ''}` }],
      max_tokens: 2200
    });
    let text = completion.choices?.[0]?.message?.content || '';
    text = text.replace(/^```(\w+\s*)?\n*/i, '').trim();
    text = text.replace(/\n*```$/i, '').trim();
    text = text.replace(/<a [^>]*>(.*?)<\/a>/gi, '$1');
    text = text.replace(/^(\.|\s|html)+/i, '').trim();
    return text;
  } catch (err) {
    log('OpenAI rewrite error:', err?.message || err);
    throw err;
  }
}

async function generateImageAlt(title, snippet, content) {
  const prompt = `Generate a descriptive image alt text (5-10 words) that explains what the picture shows based on this article:\nTitle: ${title}\nSnippet: ${snippet}\nContent: ${content}\nOnly return alt text.`;
  try {
    const completion = await openai.chat.completions.create({ model: OPENAI_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 40 });
    return (completion.choices?.[0]?.message?.content || title).trim();
  } catch (err) {
    log('Alt error:', err?.message || err);
    return title;
  }
}

async function generateImageTitle(title, snippet, content) {
  const prompt = `Generate a short SEO-friendly title text (3-6 words) for an image in this article:\nTitle: ${title}\nSnippet: ${snippet}\nContent: ${content}\nOnly return title text.`;
  try {
    const completion = await openai.chat.completions.create({ model: OPENAI_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 20 });
    return (completion.choices?.[0]?.message?.content || title).trim();
  } catch (err) {
    log('Title error:', err?.message || err);
    return title;
  }
}

async function generateTags(title, snippet, content) {
  const prompt = `Generate 3-6 SEO-friendly tags for this article. Return as comma-separated keywords only.\nTitle: ${title}\nSnippet: ${snippet}\nContent: ${content}`;
  try {
    const completion = await openai.chat.completions.create({ model: OPENAI_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 40 });
    const tags = (completion.choices?.[0]?.message?.content || '').split(',').map(t => t.trim()).filter(Boolean);
    return tags;
  } catch (err) {
    log('Tags error:', err?.message || err);
    return [];
  }
}

async function createBloggerPost({ title, htmlContent, labels = [] }) {
  try {
    const res = await blogger.posts.insert({
      blogId: BLOG_ID,
      requestBody: {
        title,
        content: htmlContent,
        labels: labels.length ? labels : undefined
      }
    });
    return res.data;
  } catch (err) {
    log('Blogger API error:', err?.message || err?.toString());
    throw err;
  }
}

async function processOnce() {
  try {
    log('Fetching RSS:', GSMARENA_RSS);
    const feed = await parser.parseURL(GSMARENA_RSS);
    if (!feed?.items?.length) {
      log('No items in feed.');
      return;
    }

    const items = feed.items.slice(0, MAX_ITEMS_PER_RUN);
    for (const item of items) {
      const guid = item.guid || item.link || item.id || item.title;
      const link = item.link;
      const originalTitle = item.title || 'Untitled';

      if (hasBeenPosted(guid) || hasBeenPosted(link)) {
        log('Already posted:', originalTitle);
        continue;
      }

      log('Processing new item:', originalTitle);
      const uniqueTitle = await rewriteTitleWithOpenAI(originalTitle);
      log('New unique title generated:', uniqueTitle);

      let snippet = item.contentSnippet || '';
      let fullContent = item['content:encoded'] || item.content || snippet;
      let imageUrl = null;

      if (link) {
        const pageHtml = await fetchPage(link);
        if (pageHtml) {
          const extracted = extractMainArticle(pageHtml);
          if (extracted) fullContent = extracted;
          if (!imageUrl) imageUrl = extractOgImage(pageHtml) || extractFirstImageFromHtml(pageHtml);
        }
      }
      if (!imageUrl) imageUrl = extractFirstImageFromHtml(fullContent);

      let rewrittenHtml = '';
      try {
        rewrittenHtml = await rewriteWithOpenAI({ title: uniqueTitle, snippet, content: fullContent });
      } catch (e) {
        log('OpenAI rewrite failed:', uniqueTitle);
        continue;
      }

      let finalHtml = '';
      if (imageUrl) {
        // New: overlay logo, with graceful fallback to original imageUrl
        const processedImagePath = await overlayLogoOnImage(imageUrl);

        const altText = await generateImageAlt(uniqueTitle, snippet, fullContent);
        const titleText = await generateImageTitle(uniqueTitle, snippet, fullContent);

        // If overlay returned a local path, embed it as base64 to avoid remote hotlinking issues
        if (processedImagePath && fs.existsSync(processedImagePath)) {
          const base64Image = fs.readFileSync(processedImagePath, { encoding: 'base64' });
          const dataUrl = `data:image/png;base64,${base64Image}`;
          finalHtml += `<p><img src="${dataUrl}" alt="${escapeHtml(altText)}" title="${escapeHtml(titleText)}" style="max-width:100%;height:auto" /></p>\n`;
        } else {
          // fallback: use original image URL
          finalHtml += `<p><img src="${imageUrl}" alt="${escapeHtml(altText)}" title="${escapeHtml(titleText)}" style="max-width:100%;height:auto" /></p>\n`;
        }
      }

      finalHtml += rewrittenHtml;

      const tags = await generateTags(uniqueTitle, snippet, fullContent);

      let posted;
      try {
        posted = await createBloggerPost({ title: uniqueTitle, htmlContent: finalHtml, labels: tags });
      } catch (e) {
        log('Failed to post to Blogger for:', uniqueTitle);
        continue;
      }

      log('Posted to Blogger:', posted.url || posted.id || '(no url returned)');
      markPosted({ guid, link, title: originalTitle, published_at: item.pubDate || item.isoDate || null });
      await sleep(2000);

      if (MODE === 'once') {
        log('MODE=once: exiting after one post.');
        return;
      }
    }
  } catch (err) {
    log('processOnce error:', err?.message || err);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/[&<>\"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
}

async function start() {
  log('Starting GSM2Blogger', { MODE, OPENAI_MODEL, GSMARENA_RSS, DB_PATH });
  // attempt to update logo on start (non-blocking but awaited so we prefer new logo)
  await downloadLogoIfNeeded();

  if (MODE === 'once') {
    await processOnce();
    log('Finished single run. Exiting.');
    process.exit(0);
  } else {
    log('Scheduling cron:', POST_INTERVAL_CRON);
    await processOnce();
    cron.schedule(POST_INTERVAL_CRON, processOnce);
    process.stdin.resume();
  }
}

start().catch(e => { log('Fatal error:', e?.message || e); process.exit(1); });
