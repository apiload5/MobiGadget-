/**
 * app.js
 *
 * Lightweight GSMArena/Engadget → OpenAI → Blogger autoposter
 * Optimized for low token usage (~1400 tokens/post)
 * Includes meta tags, image alt/title, and Google Discover schema
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === ENV ===
const {
  OPENAI_API_KEY,
  CLIENT_ID,
  CLIENT_SECRET,
  REFRESH_TOKEN,
  BLOG_ID,
  GSMARENA_RSS,
  POST_INTERVAL_CRON = '0 */3 * * *',
  MAX_ITEMS_PER_RUN = '1',
  OPENAI_MODEL = 'gpt-4o-mini',
  DB_PATH = './data/posts.db',
  MODE = 'cron',
  USER_AGENT = 'MobiGadget/1.1',
  CUSTOM_LOGO_PATH = './assets/logo.png',
  MAX_IMAGE_WIDTH = '800'
} = process.env;

// === VALIDATION ===
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !BLOG_ID)
  throw new Error('Missing Blogger OAuth credentials');

const parser = new Parser();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const google = new GoogleApis();
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });

// === DATABASE ===
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(DB_PATH);
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

function hasBeenPosted(g) {
  return !!db.prepare('SELECT 1 FROM posted WHERE guid=? OR link=?').get(g, g);
}
function markPosted(d) {
  db.prepare(
    'INSERT OR IGNORE INTO posted (guid, link, title, published_at) VALUES (?,?,?,?)'
  ).run(d.guid, d.link, d.title, d.published_at || null);
}
function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

// === HELPERS ===
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeHtml = (t) =>
  !t
    ? ''
    : t.replace(/[&<>"']/g, (m) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#039;',
        }[m])
      );

// === FETCH & EXTRACT ===
async function fetchPage(url) {
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15000,
    });
    return res.data;
  } catch {
    return null;
  }
}
const extract = {
  firstImage: (h) =>
    (h.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1] || null,
  ogImage: (h) =>
    (h.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
      h.match(/<meta[^>]*name=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
      [])[1] || null,
  article: (h) =>
    (h.match(/<div class="article-body">([\s\S]*?)<\/div>/i) ||
      h.match(
        /<div[^>]*class=['"]o-article-blocks['"][^>]*>([\s\S]*?)<\/div>/i
      ) ||
      [])[1] || null,
};

// === OPENAI HELPERS ===
async function rewriteWithOpenAI({ title, snippet, content, newsDetails = {} }) {
  const prompt = `
You are a professional tech news writer.
Rewrite this article briefly and naturally so it looks **original and human-written**, not AI or copied.

🟢 Rules:
- Keep facts accurate and tone professional.
- Focus on clarity, ~500–650 words.
- Use <p>, <h2>, <strong> tags only. No links.
- Use active voice and simple English.
- Title in <h1>.
- Output only HTML body (no markdown).

📰 Info:
Title: ${title}
${snippet ? `Snippet: ${snippet}` : ''}
${newsDetails.category ? `Category: ${newsDetails.category}` : ''}
${newsDetails.description ? `Description: ${newsDetails.description}` : ''}

Original Article:
${content}
`;
  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1300,
    temperature: 0.6,
  });
  return res.choices?.[0]?.message?.content?.replace(/^```html|```$/g, '').trim() || '';
}

async function generateImageMeta(title, snippet) {
  const prompt = `Write one short image alt text (5–8 words) matching this tech article:\n${title}\n${snippet}\nOnly return alt text.`;
  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 30,
    temperature: 0.5,
  });
  return res.choices?.[0]?.message?.content?.trim() || title;
}

async function generateMetaSEO(title, snippet) {
  const prompt = `Write a short (under 150 characters) SEO description and 3 comma-separated tags for this article.\nTitle: ${title}\nSnippet: ${snippet}\nFormat:\nDescription: ...\nTags: ...`;
  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 60,
    temperature: 0.5,
  });
  const text = res.choices?.[0]?.message?.content || '';
  const desc = (text.match(/Description:\s*(.*)/i) || [])[1] || snippet.slice(0, 150);
  const tags = ((text.match(/Tags:\s*(.*)/i) || [])[1] || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return { desc, tags };
}

// === BLOGGER UPLOAD ===
async function uploadImageToBlogger(imgPath, title) {
  try {
    const data = fs.readFileSync(imgPath).toString('base64');
    const fileName = `logo-${Date.now()}.png`;
    const res = await blogger.media.insert({
      blogId: BLOG_ID,
      media: { mimeType: 'image/png', data },
      requestBody: { title: `Logo for ${title}`, fileName },
    });
    return res.data.url;
  } catch (e) {
    log('Image upload error', e.message);
    return null;
  }
}

async function createBloggerPost({ title, htmlContent, labels = [] }) {
  const res = await blogger.posts.insert({
    blogId: BLOG_ID,
    requestBody: { title, content: htmlContent, labels: labels.length ? labels : undefined },
  });
  return res.data;
}

// === MAIN PROCESS ===
async function processOnce() {
  log('Fetching RSS:', GSMARENA_RSS);
  const feed = await parser.parseURL(GSMARENA_RSS);
  if (!feed?.items?.length) return log('No feed items.');
  const items = feed.items.slice(0, parseInt(MAX_ITEMS_PER_RUN, 10));

  for (const item of items) {
    const guid = item.guid || item.link || item.id || item.title;
    const link = item.link;
    const title = item.title || 'Untitled';
    if (hasBeenPosted(guid) || hasBeenPosted(link)) {
      log('Already posted:', title);
      continue;
    }

    log('Processing:', title);
    let snippet = item.contentSnippet || '';
    let content = item['content:encoded'] || item.content || snippet;
    let html = await fetchPage(link);
    let main = html ? extract.article(html) : null;
    if (main) content = main;
    const imageUrl = (html && (extract.ogImage(html) || extract.firstImage(html))) || extract.firstImage(content);
    const { desc: metaDesc, tags } = await generateMetaSEO(title, snippet);
    const rewritten = await rewriteWithOpenAI({ title, snippet, content });

    let finalHtml = '';
    if (imageUrl) {
      const alt = await generateImageMeta(title, snippet);
      const logo = fs.existsSync(CUSTOM_LOGO_PATH)
        ? await uploadImageToBlogger(CUSTOM_LOGO_PATH, title)
        : null;
      const imgSrc = logo || imageUrl;
      finalHtml += `<div style="text-align:center;margin:20px 0;">
        <img src="${imgSrc}" alt="${escapeHtml(alt)}" title="${escapeHtml(title)}"
             style="max-width:${MAX_IMAGE_WIDTH}px;width:100%;height:auto;border-radius:8px;">
      </div>\n`;
    }

    // JSON-LD Schema (Google Discover)
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      headline: title,
      description: metaDesc,
      author: { '@type': 'Organization', name: 'Ticno Developer' },
      publisher: {
        '@type': 'Organization',
        name: 'Ticno Developer',
        logo: { '@type': 'ImageObject', url: 'https://your-logo-url.png' },
      },
      datePublished: new Date().toISOString(),
    };
    const schemaHtml = `<script type="application/ld+json">${JSON.stringify(schema)}</script>\n`;
    const metaHtml = `<meta name="description" content="${escapeHtml(metaDesc)}">\n<meta name="keywords" content="${tags.join(', ')}">\n`;

    finalHtml = schemaHtml + metaHtml + finalHtml + rewritten;

    try {
      const post = await createBloggerPost({ title, htmlContent: finalHtml, labels: tags });
      log('✅ Posted:', post.url || post.id);
      markPosted({ guid, link, title, published_at: item.pubDate || item.isoDate });
      await sleep(2000);
      if (MODE === 'once') return;
    } catch (e) {
      log('❌ Post error:', e.message);
    }
  }
}

// === START ===
(async () => {
  log('Starting GSM2Blogger Lite', {
    MODEL: OPENAI_MODEL,
    MODE,
    MAX_ITEMS_PER_RUN,
    CUSTOM_LOGO_PATH,
  });
  if (fs.existsSync(CUSTOM_LOGO_PATH)) log('Custom logo found.');
  else log('⚠️ Custom logo missing.');
  if (MODE === 'once') await processOnce();
  else {
    await processOnce();
    cron.schedule(POST_INTERVAL_CRON, processOnce);
    process.stdin.resume();
  }
})();
