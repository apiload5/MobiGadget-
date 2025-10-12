/**
 * MobiGadget Auto Blogger
 * Features:
 * ✅ Auto fetch from GSMArena RSS
 * ✅ SEO rewrite (unique + keyword rich)
 * ✅ Adds SEO-optimized meta description and keywords (NEW)
 * ✅ Adds SEO-optimized alt and title tags to image (NEW)
 * ✅ Replaces GSMArena logo with your logo (assets/logo.png)
 * ✅ Works on Replit + GitHub Actions
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
import Jimp from 'jimp';

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
const LOGO_PATH = path.join(__dirname, 'assets', 'logo.png');

// ========== BASIC CHECKS ==========
if (!OPENAI_API_KEY) {
  console.error('❌ ERROR: OPENAI_API_KEY missing in .env');
  process.exit(1);
}
if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !BLOG_ID) {
  console.error('❌ ERROR: Blogger OAuth info missing');
  process.exit(1);
}

// ========== SETUP ==========
const parser = new Parser();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const google = new GoogleApis();
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });

// Database init
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

function hasBeenPosted(id) {
  const row = db.prepare('SELECT 1 FROM posted WHERE guid = ? OR link = ?').get(id, id);
  return !!row;
}
function markPosted({ guid, link, title, published_at }) {
  const stmt = db.prepare('INSERT OR IGNORE INTO posted (guid, link, title, published_at) VALUES (?, ?, ?, ?)');
  stmt.run(guid, link, title, published_at || null);
}
function log(...msg) {
  console.log(new Date().toISOString(), ...msg);
}

// ========== IMAGE OVERLAY FUNCTION ==========
async function overlayLogoOnImage(imageUrl) {
  try {
    const image = await Jimp.read(imageUrl);
    const logo = await Jimp.read(LOGO_PATH);

    const logoWidth = image.bitmap.width * 0.25;
    logo.resize(logoWidth, Jimp.AUTO);

    const x = image.bitmap.width - logo.bitmap.width - 20;
    const y = image.bitmap.height - logo.bitmap.height - 20;

    image.composite(logo, x, y, { mode: Jimp.BLEND_SOURCE_OVER, opacitySource: 0.85 });
    image.scale(1.05);

    const base64 = await image.getBase64Async(Jimp.MIME_JPEG);
    return base64;
  } catch (err) {
    log('⚠️ Logo overlay failed:', err.message);
    return imageUrl;
  }
}

// ========== AI HELPER FOR ALT TEXT (TOKEN OPTIMIZED) ==========
async function generateImageAlt(title, content) {
  const prompt = `Based on the following article title and content snippet, generate one short, highly descriptive, and keyword-rich alt text (max 12 words) for the main image. Only return the alt text itself, no extra words or quotes.

Title: ${title}
Content Snippet: ${content.slice(0, 500).replace(/<[^>]+>/g, '')}`;

  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 20
    });
    let altText = res.choices?.[0]?.message?.content || title;
    // Clean up response
    altText = altText.replace(/['"]/g, '').trim();
    return altText.length > 5 ? altText : title;
  } catch (e) {
    log('OpenAI Alt Text error:', e.message);
    return title;
  }
}

// ========== AI HELPER FOR META TAGS (TOKEN OPTIMIZED) ==========
async function generateMeta({ title, snippet, content }) {
  // Token bachanay ke liye content ko 500 chars tak limit karo.
  const contentForAI = snippet || content.slice(0, 500).replace(/<[^>]+>/g, '');
  const prompt = `Based on the following title and content, generate two things for SEO:
1. An SEO-optimized meta description (max 160 characters).
2. A comma-separated list of 5-7 most relevant keywords.

Output only a JSON object like this: {"description": "...", "keywords": "..."}`;

  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 150,
      response_format: { "type": "json_object" }
    });
    
    let result = JSON.parse(res.choices?.[0]?.message?.content || '{}');
    const desc = result.description?.replace(/["']/g, '').trim() || contentForAI.slice(0, 150);
    const keywords = result.keywords || title.split(' ').slice(0, 8).join(', ');

    return `<meta name="description" content="${desc.replace(/["']/g, '')}">\n<meta name="keywords" content="${keywords}">`;

  } catch (e) {
    log('OpenAI Meta error (using fallback):', e.message);
    const fallbackDesc = contentForAI.slice(0, 160).replace(/<[^>]+>/g, '');
    const fallbackKeywords = title.split(' ').slice(0, 8).join(', ');
    return `<meta name="description" content="${fallbackDesc.replace(/["']/g, '')}">\n<meta name="keywords" content="${fallbackKeywords}">`;
  }
}

async function rewriteWithOpenAI({ title, snippet, content }) {
  const prompt = `Rewrite this news article into a 100% unique, SEO-optimized English version for a tech blog.
- Add relevant subheadings (H2, H3)
- Use clear HTML (<p>, <strong>, <ul>)
- Include keywords naturally
- No links
- No markdown, only HTML body.

Title: ${title}
Snippet: ${snippet}
Content: ${content}`;
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000
    });
    let html = res.choices?.[0]?.message?.content || '';
    html = html.replace(/```html|```/g, '').trim();
    html = html.replace(/<a [^>]*>(.*?)<\/a>/gi, '$1');
    
    return html;
  } catch (e) {
    log('OpenAI rewrite error:', e.message);
    return content;
  }
}

// ========== MAIN POSTING (BUG-FIXED & TOKEN-OPTIMIZED) ==========
async function processOnce() {
  try {
    const feed = await parser.parseURL(GSMARENA_RSS);
    if (!feed?.items?.length) return log('No feed items found.');

    // 🐛 BUG FIX: Pehle items ko filter karo jo post nahi hue hain, phir slice karo.
    const itemsToProcess = feed.items.filter(item => {
      const guid = item.guid || item.link;
      return !hasBeenPosted(guid);
    }).slice(0, MAX_ITEMS_PER_RUN);
    
    if (itemsToProcess.length === 0) return log('No new items to post.');

    for (const item of itemsToProcess) {
      const guid = item.guid || item.link;
      const title = item.title;
      const snippet = item.contentSnippet || '';
      let content = item['content:encoded'] || item.content || snippet;
      let imageUrl = (content.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1];
      content = content.replace(/<img[^>]*>/gi, '');
      
      if (!imageUrl) {
        log(`⚠️ Skipping: No image found for ${title}`);
        continue;
      }

      // ✨ TOKEN OPTIMIZATION: Meta tags aur Alt text ko original content se generate karo.
      // ✍️ AI ko sirf zaruri chizein bhejo taake token bachein.
      const meta = await generateMeta({ title, snippet, content });
      const imageAlt = await generateImageAlt(title, snippet || content); // Alt text ke liye rewritten content ki zarurat nahi.
      
      // 🖼 Apply logo overlay
      const brandedImageUrl = await overlayLogoOnImage(imageUrl);

      // ✍️ Rewrite article (Yeh step abhi bhi zayada token lega, lekin yeh zaroori hai).
      const rewritten = await rewriteWithOpenAI({ title, snippet, content });
      
      const finalHtml = `
${meta}
<h1>${title}</h1>
<p><img src="${brandedImageUrl}" alt="${imageAlt}" title="${imageAlt}" style="max-width:100%;height:auto"/></p>
${rewritten}`;

      const res = await blogger.posts.insert({
        blogId: BLOG_ID,
        requestBody: { title, content: finalHtml }
      });

      log('✅ Posted:', res.data.url);
      markPosted({ guid, link: item.link, title, published_at: item.pubDate });
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err) {
    log('processOnce error:', err.message);
  }
}

// ========== START ==========
async function start() {
  log('🚀 Starting MobiGadget AutoPoster...');
  if (MODE === 'once') {
    await processOnce();
    process.exit(0);
  } else {
    await processOnce();
    cron.schedule(POST_INTERVAL_CRON, processOnce);
    log(`⏰ Cron scheduled: Running every ${POST_INTERVAL_CRON}`);
  }
}

start().catch(e => log('Fatal error:', e.message));
