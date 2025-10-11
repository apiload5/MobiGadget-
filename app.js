/**
 * app.js
 * * MobiGadget - GSMArena RSS to Blogger Auto Poster (PERFECTED FINAL FIX)
 * * Features:
 * ✅ Fixed: Duplicate Posting Logic (More Robust Checks)
 * ✅ Fixed: Complete Logo Concealment (Larger Concealer Layer)
 * ✅ Fixed: Image Style for Better Thumbnail Display
 * ✅ Advanced SEO Optimization (Alt/Title Text, Meta Tags)
 */

import 'dotenv/config';
import Parser from 'rss-parser';
import axios from 'axios';
import Database from 'better-sqlite3';
import { google } from 'googleapis';
import OpenAI from 'openai';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ========== CONFIG FROM .ENV ==========
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
const MAX_IMAGE_HTML_WIDTH = process.env.MAX_IMAGE_HTML_WIDTH || '1000';

// In-memory cache for current run to prevent processing the same item twice
const PROCESSED_CACHE = new Set();

// ========== BASIC CHECKS ==========
if (!OPENAI_API_KEY || !CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !BLOG_ID) {
  console.error('❌ ERROR: Environment variables missing.');
  process.exit(1);
}
if (!fs.existsSync(LOGO_PATH)) {
  console.warn(`⚠️ Warning: Custom logo not found at ${LOGO_PATH}. Watermarking will fail.`);
}

// ========== SETUP ==========
const parser = new Parser();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });

// Database init
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(DB_PATH);

// Database Schema
db.prepare(`
  CREATE TABLE IF NOT EXISTS posted (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE,
    link TEXT UNIQUE,
    title TEXT,
    title_slug TEXT UNIQUE,
    published_at TEXT,
    posted_at TEXT DEFAULT (datetime('now'))
  )
`).run();

// FUNCTION: Generate title slug for duplicate checking
function generateSlug(title) {
  return title.toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 100);
}

// MODIFIED: Stronger Duplicate Check
function hasBeenPosted(guid, link, title) {
  const titleSlug = generateSlug(title);
  
  // 1. Check in-memory cache for current run (MOST IMPORTANT to prevent continuous duplicates)
  if (PROCESSED_CACHE.has(guid)) {
    return true;
  }

  // 2. Check Database for previous posts
  const exactMatch = db.prepare(`
    SELECT 1 FROM posted WHERE guid = ? OR link = ? OR title_slug = ?
  `).get(guid, link, titleSlug);
  
  return !!exactMatch;
}

// MODIFIED: markPosted (Title Slug bhi save karein)
function markPosted({ guid, link, title, published_at }) {
  const titleSlug = generateSlug(title);
  
  // Add to in-memory cache
  PROCESSED_CACHE.add(guid);

  // Insert into DB
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO posted 
    (guid, link, title, title_slug, published_at) 
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(guid, link, title, titleSlug, published_at || null);
}

function log(...msg) {
  console.log(new Date().toISOString(), ...msg);
}

// FUNCTION: Upload image to Blogger (Base64 fallback)
async function uploadImageToBlogger(imageBuffer, title) {
  try {
    const base64Image = imageBuffer.toString('base64');
    const timestamp = Date.now();
    const filename = `mobigadget-${timestamp}.jpg`;
    
    // Blogger API requires Base64 without headers/wrappers
    const media = await blogger.media.insert({
      blogId: BLOG_ID,
      requestBody: { title: `MobiGadget - ${title}`, fileName: filename },
      media: { mimeType: 'image/jpeg', data: base64Image }
    });
    
    log('✅ Image uploaded to Blogger successfully');
    return media.data.url;
  } catch (err) {
    log('❌ Image upload failed, using Base64 fallback (may cause thumbnail issues):', err.message);
    // Fallback: Use Base64 data URL
    const base64Data = imageBuffer.toString('base64');
    return `data:image/jpeg;base64,${base64Data}`;
  }
}

// FIX: Conceal Logo, Enlarge, and Watermark (Improved Concealer)
async function concealLogoAndResize(originalImageUrl, customLogoPath) {
  const TARGET_WIDTH = 1200; 
  const CONCEAL_HEIGHT = 120; // Slightly larger height
  const CONCEAL_WIDTH = 350; // Larger width to ensure cover
  
  try {
    const imageResponse = await axios.get(originalImageUrl, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': USER_AGENT },
      timeout: 30000
    });
    
    let originalImage = sharp(imageResponse.data);
    
    // Resize/Enlarge to TARGET_WIDTH 
    const resizedImageBuffer = await originalImage
      .resize(TARGET_WIDTH, null, { fit: 'inside' })
      .toBuffer();
      
    let processedImage = sharp(resizedImageBuffer);
    const resizedMetadata = await processedImage.metadata();
    
    // 3. Create a white rectangle buffer (Concealer)
    const whiteConcealerBuffer = await sharp({
      create: {
        width: CONCEAL_WIDTH,
        height: CONCEAL_HEIGHT,
        channels: 3,
        background: { r: 255, g: 255, b: 255, alpha: 1 } // Solid White/Opaque
      }
    }).jpeg().toBuffer();
    
    // 4. Download and Resize custom logo
    const logoBuffer = fs.readFileSync(customLogoPath);
    const logoWidth = Math.floor(resizedMetadata.width * 0.1); 
    const logoHeight = Math.floor(logoWidth * 0.8);
    
    const resizedLogo = await sharp(logoBuffer)
      .resize(logoWidth, logoHeight, { fit: 'contain' })
      .png()
      .toBuffer();
    
    // 5. Composite: First Conceal, then Apply Your Logo
    const finalImageBuffer = await processedImage
      .composite([
        { // 5a: Concealer (Erase original logo area)
          input: whiteConcealerBuffer,
          top: resizedMetadata.height - CONCEAL_HEIGHT, 
          left: resizedMetadata.width - CONCEAL_WIDTH, 
          blend: 'over'
        },
        { // 5b: Your Logo (Watermark) - 15px margin
          input: resizedLogo,
          top: resizedMetadata.height - logoHeight - 15, 
          left: resizedMetadata.width - logoWidth - 15,
          blend: 'over'
        }
      ])
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
    
    log('✅ Logo concealed, image resized, and watermarked successfully.');
    return finalImageBuffer;
    
  } catch (err) {
    log('❌ Image processing/download failed:', err.message);
    return null;
  }
}

// MODIFIED AI HELPER FOR META TAGS
async function generateMeta({ title, snippet, content }) {
  // ... (rest of the generateMeta function is the same, highly SEO optimized)
  const contentForAI = snippet || content.slice(0, 500).replace(/<[^>]+>/g, '');
  const prompt = `Based on the following title and content, generate two things for SEO:
1. An SEO-optimized meta description (max 155 characters). This should be a compelling, click-worthy search engine snippet.
2. A comma-separated list of 5-7 highly relevant, long-tail keywords suitable for blog tags.

Output only a JSON object like this: {"description": "...", "keywords": "..."}`;

  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 150,
      response_format: { "type": "json_object" }
    });
    
    let result = JSON.parse(res.choices?.[0]?.message?.content || '{}');
    const desc = (result.description || contentForAI.slice(0, 150)).replace(/["']/g, '').trim();
    const keywords = result.keywords || title.split(' ').slice(0, 8).join(', ');

    return {
      metaHtml: `<meta name="description" content="${desc.slice(0, 155).replace(/["']/g, '')}">\n<meta name="keywords" content="${keywords}">`,
      labels: keywords.split(',').map(k => k.trim()).filter(Boolean)
    };

  } catch (e) {
    // ... (fallback logic)
    const fallbackDesc = contentForAI.slice(0, 155).replace(/<[^>]+>/g, '');
    const fallbackKeywords = title.split(' ').slice(0, 8).join(', ');
    return {
      metaHtml: `<meta name="description" content="${fallbackDesc}">\n<meta name="keywords" content="${fallbackKeywords}">`,
      labels: fallbackKeywords.split(',').map(k => k.trim()).filter(Boolean)
    };
  }
}

// MODIFIED AI HELPER FOR ALT/TITLE TEXT
async function generateImageAltAndTitle(title, content) {
  // ... (rest of the generateImageAltAndTitle function is the same)
  const prompt = `Based on the article title and content snippet, generate two items for the main image:
1. Alt Text: A short (max 10 words) descriptive alt text for accessibility and SEO.
2. Title Text: A short (max 5 words) keyword-rich title for SEO.

Output only a JSON object like this: {"alt": "...", "title": "..."}`;

  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 40,
      response_format: { "type": "json_object" }
    });
    let result = JSON.parse(res.choices?.[0]?.message?.content || '{}');
    
    const altText = (result.alt || `Detailed image of ${title}`).replace(/['"]/g, '').trim();
    const titleText = (result.title || `Latest ${title} overview`).replace(/['"]/g, '').trim();
    
    return { altText, titleText };
  } catch (e) {
    log('OpenAI Alt/Title error (using fallback):', e.message);
    return { altText: `Detailed image of ${title}`, titleText: `Latest ${title} news` };
  }
}

// MODIFIED AI REWRITE (NO IMAGE RULE)
async function rewriteWithOpenAI({ title, snippet, content }) {
  const prompt = `Rewrite this news article into a 100% unique, comprehensive, and SEO-optimized English version for a professional tech blog.
Rules for Output:
1. **Originality First:** Paraphrase and restructure completely.
2. **CRITICAL RULE: DO NOT include any <img> tags, picture, charts, or figures in the output HTML. The image is added separately.**
3. **Structure:** Use a strong main headline (H1) and structured subheadings (H2, H3).
4. **Formatting:** Use clear HTML (<p>, <strong>, <ul>, <ol>).
5. **Clean Output:** DO NOT include any hyperlinks (<a> tags).
6. **Output Format:** Return ONLY the final HTML content for the article body.

Title: ${title}
Snippet: ${snippet}
Content: ${content}`;
  try {
    const res = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2200
    });
    let html = res.choices?.[0]?.message?.content || '';
    html = html.replace(/```html|```/g, '').trim();
    html = html.replace(/<a [^>]*>(.*?)<\/a>/gi, '$1');
    html = html.replace(/<img[^>]*>|<figure[^>]*>[\s\S]*?<\/figure>/gi, ''); // Final safety check

    return html;
  } catch (e) {
    log('OpenAI rewrite error:', e.message);
    return `<p>Failed to rewrite content for ${title}.</p><p>${content}</p>`;
  }
}

// ========== MAIN POSTING (UPDATED) ==========
async function processOnce() {
  try {
    const feed = await parser.parseURL(GSMARENA_RSS);
    if (!feed?.items?.length) return log('No feed items found.');

    // Only process the new items, filter against DB and in-memory cache
    const itemsToProcess = feed.items.filter(item => {
      const guid = item.guid || item.link;
      const title = item.title;
      return !hasBeenPosted(guid, item.link, title);
    }).slice(0, MAX_ITEMS_PER_RUN);
    
    if (itemsToProcess.length === 0) return log('No new items to post.');

    for (const item of itemsToProcess) {
      const guid = item.guid || item.link;
      const link = item.link;
      const title = item.title;
      
      log(`🔍 Processing: "${title}"`);

      // Mark the item immediately in in-memory cache to prevent further processing in this run
      PROCESSED_CACHE.add(guid);

      // ... (Rest of item processing)

      const snippet = item.contentSnippet || '';
      let content = item['content:encoded'] || item.content || snippet;
      let imageUrl = (content.match(/<img[^>]+src=["']([^"']+)["']/i) || [])[1];
      
      if (!imageUrl) {
        log(`⚠️ Skipping: No image URL found for ${title}`);
        continue;
      }

      // Apply logo concealment and enlargement
      const watermarkedImageBuffer = await concealLogoAndResize(imageUrl, LOGO_PATH);
      let uploadedImageUrl = imageUrl;
      
      if (watermarkedImageBuffer) {
        uploadedImageUrl = await uploadImageToBlogger(watermarkedImageBuffer, title);
      } else {
        log('⚠️ Watermarking failed, using original RSS image URL.');
      }
      
      // Rewrite article
      const rewritten = await rewriteWithOpenAI({ title, snippet, content });
      
      // Generate SEO components
      const { metaHtml, labels } = await generateMeta({ title, snippet, content: rewritten });
      const { altText, titleText } = await generateImageAltAndTitle(title, rewritten);

      // Final HTML Structure (FIXED Image Styles for better thumbnail recognition)
      const finalHtml = `
${metaHtml}
<div style="text-align: center; margin-bottom: 20px;">
  <img src="${uploadedImageUrl}" 
       alt="${altText}" 
       title="${titleText}" 
       style="max-width: ${MAX_IMAGE_HTML_WIDTH}px; width: 100%; height: auto; border-radius: 8px; display: block; margin: 0 auto;" />
  <p style="font-style: italic; color: #666; margin-top: 8px; font-size: 14px;">Image: ${altText}</p>
</div>
${rewritten}`;

      const res = await blogger.posts.insert({
        blogId: BLOG_ID,
        requestBody: { 
            title, 
            content: finalHtml,
            labels: labels.length ? labels : undefined 
        }
      });

      log('✅ Posted:', res.data.url);
      log('🏷️ Tags used:', labels.join(', '));
      markPosted({ guid, link, title, published_at: item.pubDate }); // Final DB mark
      
      if (MODE === 'once') return; // Exit immediately in 'once' mode
      await new Promise(r => setTimeout(r, 2000)); // Delay between posts
    }
  } catch (err) {
    log('processOnce error:', err.message);
  }
}

// ========== START ==========
async function start() {
  log(`🚀 Starting MobiGadget AutoPoster in ${MODE} mode...`);
  
  if (MODE === 'once') {
    await processOnce();
    process.exit(0);
  } else {
    await processOnce();
    cron.schedule(POST_INTERVAL_CRON, processOnce);
    log(`⏰ Cron scheduled: Running at ${POST_INTERVAL_CRON}`);
  }
}

start().catch(e => log('Fatal error:', e.message));
