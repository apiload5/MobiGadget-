/**
 * app.js (Updated Version with Auto Logo and Markdown Fix)
 * Hybrid GSMArena/Engadget -> OpenAI -> Blogger autoposter
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
import sharp from 'sharp'; // for image processing

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
const USER_AGENT = process.env.USER_AGENT || 'MobiGadget/1.0';

const LOGO_PATH = path.join(__dirname, 'assets/logo.png');

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
  } catch {
    return null;
  }
}

function extractFirstImageFromHtml(html) {
  const imgMatch = html?.match(/<img[^>]+src=["']([^"']+)["']/i);
  return imgMatch ? imgMatch[1] : null;
}

function extractOgImage(html) {
  const m = html?.match(/property=["']og:image["']\s*content=["']([^"']+)["']/i) || html?.match(/<meta[^>]*name=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function extractMainArticle(html) {
  let match = html?.match(/<div class=\"article-body\">([\s\S]*?)<\/div>/i);
  if (match) return match[1];
  match = html?.match(/<div[^>]*class=["']o-article-blocks["'][^>]*>([\s\S]*?)<\/div>/i);
  return match ? match[1] : null;
}

async function rewriteTitleWithOpenAI(originalTitle) {
  const prompt = `Rewrite the following title into a highly unique, click-worthy, and SEO-optimized headline:\n\n${originalTitle}`;
  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 50
    });
    return completion.choices?.[0]?.message?.content?.trim() || originalTitle;
  } catch {
    return originalTitle;
  }
}

async function rewriteWithOpenAI({ title, snippet, content }) {
  const prompt = `You are a highly skilled SEO Content Writer. Rewrite the following article into a **unique, high-quality, and comprehensive English news post** for a professional tech blog.\n\nRules for SEO and Originality:\n1. Originality First: Create content that is NOT duplicate.\n2. Expand to about 1200 words unless the topic is simple.\n3. Use H1, H2, H3 for headings.\n4. Use clean HTML (p, strong, ul, ol).\n5. DO NOT use hyperlinks.\n6. Output ONLY the HTML content, no markdown or code blocks.`;
  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: `${prompt}\n\nTitle: ${title}\n\nSnippet: ${snippet}\n\nContent:\n${content}` }],
      max_tokens: 2200
    });
    let text = completion.choices?.[0]?.message?.content || '';
    text = text.replace(/```html|```/g, '').trim();
    text = text.replace(/<a [^>]*>(.*?)<\/a>/gi, '$1');
    return text;
  } catch (err) {
    log('OpenAI rewrite error:', err.message);
    throw err;
  }
}

async function addLogoToImage(imageUrl) {
  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(response.data, 'binary');

    const outputBuffer = await sharp(imageBuffer)
      .composite([{ input: LOGO_PATH, gravity: 'southeast', blend: 'over', opacity: 0.7 }])
      .toBuffer();

    const outPath = path.join(__dirname, 'temp', `image_${Date.now()}.png`);
    if (!fs.existsSync(path.dirname(outPath))) fs.mkdirSync(path.dirname(outPath));
    fs.writeFileSync(outPath, outputBuffer);

    return outPath;
  } catch {
    return imageUrl;
  }
}

async function generateTags(title, snippet, content) {
  const prompt = `Generate 3-6 SEO-friendly tags for this article. Return as comma-separated keywords.\nTitle: ${title}\nSnippet: ${snippet}`;
  try {
    const completion = await openai.chat.completions.create({ model: OPENAI_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 40 });
    return completion.choices?.[0]?.message?.content?.split(',').map(t => t.trim()) || [];
  } catch {
    return [];
  }
}

async function createBloggerPost({ title, htmlContent, labels }) {
  const res = await blogger.posts.insert({
    blogId: BLOG_ID,
    requestBody: { title, content: htmlContent, labels }
  });
  return res.data;
}

async function processOnce() {
  try {
    log('Fetching RSS:', GSMARENA_RSS);
    const feed = await parser.parseURL(GSMARENA_RSS);
    if (!feed?.items?.length) return log('No items in feed.');

    const items = feed.items.slice(0, MAX_ITEMS_PER_RUN);
    for (const item of items) {
      const guid = item.guid || item.link || item.title;
      const link = item.link;
      const originalTitle = item.title || 'Untitled';

      if (hasBeenPosted(guid) || hasBeenPosted(link)) {
        log('Already posted:', originalTitle);
        continue;
      }

      const uniqueTitle = await rewriteTitleWithOpenAI(originalTitle);
      log('Unique title:', uniqueTitle);

      let snippet = item.contentSnippet || '';
      let fullContent = item['content:encoded'] || item.content || snippet;
      let imageUrl = null;

      if (link) {
        const pageHtml = await fetchPage(link);
        if (pageHtml) {
          const extracted = extractMainArticle(pageHtml);
          if (extracted) fullContent = extracted;
          imageUrl = extractOgImage(pageHtml) || extractFirstImageFromHtml(pageHtml);
        }
      }

      if (!imageUrl) imageUrl = extractFirstImageFromHtml(fullContent);

      let rewrittenHtml = await rewriteWithOpenAI({ title: uniqueTitle, snippet, content: fullContent });

      let finalHtml = '';
      if (imageUrl) {
        const logoImage = await addLogoToImage(imageUrl);
        finalHtml += `<p><img src="${logoImage}" alt="${uniqueTitle}" style="max-width:100%;height:auto"/></p>`;
      }
      finalHtml += rewrittenHtml;

      const tags = await generateTags(uniqueTitle, snippet, fullContent);
      const posted = await createBloggerPost({ title: uniqueTitle, htmlContent: finalHtml, labels: tags });

      markPosted({ guid, link, title: uniqueTitle, published_at: item.pubDate });
      log('Posted to Blogger:', posted.url || '(no url)');
      await new Promise(r => setTimeout(r, 2000));

      if (MODE === 'once') return;
    }
  } catch (err) {
    log('processOnce error:', err.message);
  }
}

async function start() {
  log('Starting MobiGadget AutoPoster', { MODE, OPENAI_MODEL, GSMARENA_RSS });
  if (MODE === 'once') {
    await processOnce();
    process.exit(0);
  } else {
    await processOnce();
    cron.schedule(POST_INTERVAL_CRON, processOnce);
  }
}

start().catch(e => {
  log('Fatal error:', e.message);
  process.exit(1);
});
