/**
 * MobiGadget Auto Blogger (External API Integration Version - SECRET FIX)
 * Features:
 * ✅ Uses External API URL loaded from .env for security.
 * ✅ Adds user's logo (mobiseko) on top of the externally edited image.
 * ✅ Uses Blogger's native API for image upload (100% Thumbnail Fix, No Imgur).
 * ✅ Complete SEO (Rewrite, Alt/Title text, Tags).
 * ✅ Duplicate post checking.
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

// --- ENV VARIABLES ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const BLOG_ID = process.env.BLOG_ID;
// ✅ API URL LOADED FROM .ENV
const EXTERNAL_EDIT_API = process.env.EXTERNAL_EDIT_API; 

const GSMARENA_RSS = process.env.GSMARENA_RSS;
const POST_INTERVAL_CRON = process.env.POST_INTERVAL_CRON || '0 */3 * * *';
const MAX_ITEMS_PER_RUN = parseInt(process.env.MAX_ITEMS_PER_RUN || '1', 10);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DB_PATH = process.env.DB_PATH || './data/posts.db';
const MODE = (process.env.MODE || 'cron').toLowerCase();
const USER_AGENT = process.env.USER_AGENT || 'MobiGadget/3.0';

// --- LOGO PATH CHECK & BASIC CHECKS ---
const LOGO_PATH = path.join(__dirname, 'assets', 'logo.png');
if (!fs.existsSync(LOGO_PATH)) {
    console.error(`❌ ERROR: Logo file not found. Please ensure 'logo.png' exists in the 'assets' folder.`);
    process.exit(1);
}
if (!OPENAI_API_KEY || !CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !BLOG_ID || !EXTERNAL_EDIT_API) {
    console.error('❌ ERROR: Essential environment variables (including EXTERNAL_EDIT_API) are missing.');
    process.exit(1);
}

const parser = new Parser();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const google = new GoogleApis();
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client }); 

// Database setup unchanged
const DB_PATH = process.env.DB_PATH || './data/posts.db';
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.prepare(`
  CREATE TABLE IF NOT EXISTS posted (
    id INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE, link TEXT UNIQUE,
    title TEXT, published_at TEXT, posted_at TEXT DEFAULT (datetime('now'))
  )
`).run();

// --- HELPER FUNCTIONS (Unchanged) ---

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
}
function hasBeenPosted(guidOrLink) {
  const row = db.prepare('SELECT 1 FROM posted WHERE guid = ? OR link = ?').get(guidOrLink, guidOrLink);
  return !!row;
}
function markPosted({ guid, link, title, published_at }) {
  const stmt = db.prepare('INSERT OR IGNORE INTO posted (guid, link, title, published_at) VALUES (?, ?, ?, ? )');
  stmt.run(guid, link, title, published_at || null);
}
async function fetchPage(url) {
  try {
    const res = await axios.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 15000 });
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
  let match = html.match(/<div class=\"article-body\">([\s\S]*?)<\/div>/i);
  if (match) return match[1];
  match = html.match(/<div[^>]*class=[\"']o-article-blocks[\"'][^>]*>([\s\S]*?)<\/div>/i);
  if (match) return match[1];
  return null;
}
async function createBloggerPost({ title, htmlContent, labels = [] }) {
  try {
    const res = await blogger.posts.insert({
      blogId: BLOG_ID, requestBody: { title, content: htmlContent, labels: labels.length ? labels : undefined }
    });
    return res.data;
  } catch (err) {
    log('Blogger API error:', err?.message || err?.toString());
    throw err;
  }
}


// --- IMAGE PROCESSING LOGIC (Uses EXTERNAL_EDIT_API) ---

async function getEditedImageFromExternalAPI(imageUrl) {
    log(`Sending image to external API for editing: ${imageUrl}`);
    try {
        const res = await axios.post(EXTERNAL_EDIT_API, 
            { image_url: imageUrl }, 
            { 
                responseType: 'arraybuffer',
                headers: { 'Content-Type': 'application/json' }
            }
        );

        if (res.headers['content-type'] && res.headers['content-type'].startsWith('image/')) {
            log('✅ Edited image received from external API.');
            return res.data; 
        } else {
            log('❌ External API did not return an image. Content-Type:', res.headers['content-type']);
            log('❌ Response Text Sample:', res.data.toString('utf8').substring(0, 200));
            return null;
        }

    } catch (err) {
        log('❌ External API communication failed:', err.message);
        try {
            const originalRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            log('⚠️ Falling back to original image due to API failure.');
            return originalRes.data;
        } catch (e) {
            log('❌ Original image fetch failed too.');
            return null;
        }
    }
}

async function brandEditedImageBuffer(imageBuffer) {
  try {
    const image = await Jimp.read(imageBuffer);
    const logo = await Jimp.read(LOGO_PATH);
    
    const logoWidth = image.bitmap.width * 0.25;
    logo.resize(logoWidth, Jimp.AUTO);
    const overlayX = image.bitmap.width - logo.bitmap.width - 20;
    const overlayY = image.bitmap.height - logo.bitmap.height - 20;
    
    image.composite(logo, overlayX, overlayY, { mode: Jimp.BLEND_SOURCE_OVER, opacitySource: 0.85 });
    
    return await image.getBufferAsync(Jimp.MIME_JPEG);
  } catch (err) {
    log('⚠️ Logo branding failed:', err.message);
    return null;
  }
}

async function uploadToBlogger(imageBuffer, altText) {
    try {
        const response = await axios.post(
            `https://www.googleapis.com/upload/blogger/v3/blogs/${BLOG_ID}/images`,
            imageBuffer,
            {
                headers: {
                    'Content-Type': 'image/jpeg',
                    'Authorization': `Bearer ${(await oauth2Client.getAccessToken()).token}`, 
                    'X-Upload-Content-Type': 'image/jpeg'
                },
                params: {
                    uploadType: 'media',
                    alt: altText || 'MobiGadget Image'
                }
            }
        );
        log('✅ Final image uploaded to Blogger:', response.data.url);
        return response.data.url;
    } catch (err) {
        log('❌ Blogger Image Upload API error:', err.response ? err.response.data : err.message);
        return null;
    }
}


// --- AI FUNCTIONS (FINAL IMPROVED PROMPTS - Unchanged) ---

async function rewriteWithOpenAI({ title, snippet, content }) {
  const prompt = `You are a highly skilled SEO Content Writer. Rewrite the following article into a **unique, high-quality, and comprehensive English news post** for a professional tech blog.
Rules for SEO and Originality:
1.  **Originality First:** Your main goal is to generate content that is **NOT duplicate**. Paraphrase and restructure the input completely.
2.  **Completeness/Depth:** The post must fully answer the user's intent. **Expand the topic logically and naturally** by adding background, context, and future implications. The final article should be detailed and richer than the original, but **do not artificially inflate the word count**. Ensure all facts are derived from the original content.
3.  **Structure:** Use a compelling main headline (H1) and relevant, structured subheadings (H2, H3) for readability and SEO.
4.  **Formatting:** Use standard HTML formatting (p, strong, ul, ol).
5.  **Clean Output:** **DO NOT** include any links (hyperlinks/<a> tags). **DO NOT** include any introductory or concluding remarks outside the main article body.
6.  **Language:** Write in professional, clear English only.
7.  **Output Format:** Return **ONLY** the final HTML content for the article body.`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: `${prompt}\n\nTitle: ${title}\n\nSnippet: ${snippet || ''}\n\nContent:\n${content || ''}` }],
      max_tokens: 2200
    });
    let text = completion.choices?.[0]?.message?.content || '';

    text = text.replace(/\.\.\.\s*html/gi, '');
    text = text.replace(/<a [^>]*>(.*?)<\/a>/gi, '$1');

    return text;
  } catch (err) {
    log('OpenAI rewrite error:', err?.message || err);
    throw err;
  }
}

async function generateImageAlt(title, snippet, content) {
  const prompt = `Create a highly descriptive and SEO-friendly ALT TEXT (5-10 words) for the main image of this article. Focus on describing the product and its most visible features to aid visual accessibility and image search ranking.
Article Title: ${title}
Return ONLY the alt text, no explanations.`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 25
    });
    let altText = completion.choices?.[0]?.message?.content || '';
    
    altText = altText.replace(/^alt text:?/i, '').trim();
    altText = altText.replace(/^["']|["']$/g, '');
    
    return altText || `Detailed view of ${title}`;
  } catch (err) {
    log('Alt error:', err?.message || err);
    return `Close up shot of ${title}`;
  }
}

async function generateImageTitle(title, snippet, content) {
  const prompt = `Generate a short SEO-friendly TITLE text (3-5 words) for the image in this article. Use the most important, high-search-volume keywords that summarize the news.
Context: ${title}
Return ONLY the title text, no explanations.`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 15
    });
    let titleText = completion.choices?.[0]?.message?.content || '';
    
    titleText = titleText.replace(/^title:?/i, '').trim();
    titleText = titleText.replace(/^["']|["']$/g, '');
    
    return titleText || 'latest smartphone technology';
  } catch (err) {
    log('Title error:', err?.message || err);
    return 'mobile tech innovation';
  }
}

async function generateTags(title, snippet, content) {
  const prompt = `You are an SEO expert. Generate 3-6 highly relevant, high-search-volume keywords that would be used as blog tags/labels for this tech news article.
Rules:
1. Keywords must be in English and separated by commas.
2. Focus on specific device names, brands, and main features.
3. Return ONLY the comma-separated list of keywords.

Article Title: ${title}
Snippet: ${snippet}
Content: ${content}`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 40
    });
    const tags = (completion.choices?.[0]?.message?.content || '')
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);
    return tags;
  } catch (err) {
    log('Tags error:', err?.message || err);
    return [];
  }
}


// --- MAIN PROCESS (UPDATED TO USE EXTERNAL API) ---

async function processOnce() {
  try {
    log('Fetching RSS:', GSMARENA_RSS);
    const feed = await parser.parseURL(GSMARENA_RSS);
    if (!feed?.items?.length) return log('No items in feed.');

    const items = feed.items.slice(0, MAX_ITEMS_PER_RUN);
    for (const item of items) {
      const guid = item.guid || item.link;
      const link = item.link;
      const title = item.title || 'Untitled';

      if (hasBeenPosted(guid) || hasBeenPosted(link)) {
        log('Already posted:', title);
        continue;
      }
      log('Processing new item:', title);

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
      if (!imageUrl) {
        log(`⚠️ Skipping: No image found for ${title}`);
        continue;
      }
      
      // 1. AI and SEO generation
      const altText = await generateImageAlt(title, snippet, fullContent);
      const titleText = await generateImageTitle(title, snippet, fullContent);
      const tags = await generateTags(title, snippet, fullContent);
      
      // 2. GET EDITED IMAGE FROM EXTERNAL API
      const editedImageBuffer = await getEditedImageFromExternalAPI(imageUrl);
      if (!editedImageBuffer) continue;
      
      // 3. ADD USER LOGO TO EDITED IMAGE
      const brandedImageBuffer = await brandEditedImageBuffer(editedImageBuffer);
      if (!brandedImageBuffer) continue;

      // 4. UPLOAD TO BLOGGER
      const finalImageUrl = await uploadToBlogger(brandedImageBuffer, altText);
      if (!finalImageUrl) continue;

      // 5. Content rewriting
      const rewrittenHtml = await rewriteWithOpenAI({ title, snippet, content: fullContent });

      // Construct final HTML with the Google-hosted URL
      let finalHtml = `<p><img src="${finalImageUrl}" alt="${escapeHtml(altText)}" title="${escapeHtml(titleText)}" style="max-width:100%;height:auto" /></p>\n`;
      finalHtml += rewrittenHtml;

      const posted = await createBloggerPost({ title, htmlContent: finalHtml, labels: tags });
      log('✅ Posted to Blogger:', posted.url);
      markPosted({ guid, link, title, published_at: item.pubDate });
      await sleep(2000);

      if (MODE === 'once') return;
    }
  } catch (err) {
    log('❌ processOnce error:', err?.message || err);
  }
}

// --- START ---

async function start() {
    log('🚀 Starting MobiGadget Auto Blogger (External API Version)...');
    if (MODE === 'once') {
        await processOnce();
        log('Finished single run. Exiting.');
        process.exit(0);
    } else {
        log('Scheduling cron:', POST_INTERVAL_CRON);
        await processOnce();
        cron.schedule(POST_INTERVAL_CRON, processOnce);
    }
}

start().catch(e => { log('❌ Fatal error:', e?.message || e); process.exit(1); });
