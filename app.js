/**
 * app.js - FINAL STABLE VERSION (Source Credit REMOVED)
 * * Features:
 * ✅ STABLE: Uses title_slug, guid, and link for robust duplicate checking (like the old stable version).
 * ✅ SEO-FOCUSED: New efficient AI prompt for 350-450 word, factual content.
 * ✅ CLEAN: Removed sharp, logo, and all local image manipulation.
 * ✅ FIX: Source Credit Line is COMPLETELY REMOVED from the post content.
 * ✅ IMAGE: Unsplash fetching and Blogger upload for best possible thumbnail generation.
 */

import 'dotenv/config';
import Parser from 'rss-parser';
import axios from 'axios';
import Database from 'better-sqlite3';
import { google } from 'googleapis';
import OpenAI from 'openai';
import cron from 'node-cron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ========== CONFIGURATION FROM .ENV ==========
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const BLOG_ID = process.env.BLOG_ID;
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY; 

const GSMARENA_RSS = process.env.GSMARENA_RSS || 'https://www.gsmarena.com/rss.php3';
const POST_INTERVAL_CRON = process.env.POST_INTERVAL_CRON || '0 */3 * * *';
const MAX_ITEMS_PER_RUN = parseInt(process.env.MAX_ITEMS_PER_RUN || '1', 10);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DB_PATH = process.env.DB_PATH || './data/posts.db';
const MODE = (process.env.MODE || 'cron').toLowerCase();
const USER_AGENT = process.env.USER_AGENT || 'Mobiseko/1.0'; 
const MAX_IMAGE_HTML_WIDTH = process.env.MAX_IMAGE_HTML_WIDTH || '1000';
const MAX_TOKENS = 3500; 

const BLOG_CATEGORIES = process.env.BLOG_CATEGORIES || 'New Announcements, Flagship Reviews, Android Updates, Wearables and Audio, Price Deals, Telecom News';
const CATEGORY_LIST = BLOG_CATEGORIES.split(',').map(c => c.trim()).filter(c => c.length > 0);
const BLOG_BRAND_NAME = 'Mobiseko'; 

const PROCESSED_CACHE = new Set();

// ========== BASIC CHECKS & SETUP ==========
if (!OPENAI_API_KEY || !CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !BLOG_ID || !UNSPLASH_ACCESS_KEY) {
  console.error('❌ ERROR: Essential API keys or tokens are missing in .env');
  process.exit(1);
}

const parser = new Parser();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(DB_PATH);

// Database structure updated to include title_slug for robust duplicate check
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

function log(...msg) {
  console.log(new Date().toISOString(), ...msg);
}

function generateSlug(title) {
  return title.toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 100);
}

// Function uses title_slug, guid, and link for robust checking
function hasBeenPosted(guid, link, title) {
  const titleSlug = generateSlug(title);
  if (PROCESSED_CACHE.has(guid)) return true;

  const exactMatch = db.prepare(`
    SELECT 1 FROM posted WHERE guid = ? OR link = ? OR title_slug = ?
  `).get(guid, link, titleSlug);
  
  return !!exactMatch;
}

function markPosted({ guid, link, title, published_at }) {
  const titleSlug = generateSlug(title);
  PROCESSED_CACHE.add(guid);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO posted 
    (guid, link, title, title_slug, published_at) 
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(guid, link, title, titleSlug, published_at || null);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ========== UNSPLASH INTEGRATION & IMAGE FUNCTIONS ==========

async function fetchUnsplashImage(query) {
    const keywords = `${query} technology gadget review`;
    const url = 'https://api.unsplash.com/search/photos';
    
    try {
        const response = await axios.get(url, {
            params: {
                query: keywords,
                orientation: 'landscape',
                per_page: 1
            },
            headers: {
                Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}`
            },
            timeout: 10000
        });

        const image = response.data.results?.[0];

        if (image) {
            log(`🖼️ Unsplash: Found image for query "${keywords.substring(0, 30)}..."`);
            return image.urls.regular; 
        }

        return null;

    } catch (e) {
        log('❌ Unsplash API Error:', e.message);
        return null;
    }
}

// Uploads image to Blogger for proper thumbnail generation.
async function uploadExternalImageToBlogger(imageUrl, title) {
    try {
        const imageResponse = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': USER_AGENT },
            timeout: 30000
        });
        
        const mimeType = imageResponse.headers['content-type'] || 'image/jpeg';
        const base64Image = Buffer.from(imageResponse.data).toString('base64');

        const timestamp = Date.now();
        const filename = `mobiseko-${timestamp}.jpg`; 

        const media = await blogger.media.insert({
            blogId: BLOG_ID,
            requestBody: { title: `Image for ${title}`, fileName: filename },
            media: { mimeType: mimeType, data: base64Image }
        });
        
        log('✅ Image uploaded to Blogger successfully (for thumbnail)');
        return media.data.url;
    } catch (err) {
        log('❌ CRITICAL ERROR: Image upload failed. CHECK REFRESH_TOKEN/SCOPES.', err.message);
        return null; 
    }
}

// ========== CATEGORY CLASSIFICATION FUNCTION ==========
async function classifyCategory(title) {
    if (CATEGORY_LIST.length === 0) return null;

    const prompt = `Classify the following article title into one of these specific categories: [${BLOG_CATEGORIES}].
    If the title does not fit any category, use the first category in the list.
    Output ONLY the chosen category name, exactly as it appears in the list, with no extra text, quotes, or formatting.
    Title: ${title}`;

    try {
        const res = await openai.chat.completions.create({
            model: OPENAI_MODEL,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 15
        });
        
        let category = res.choices?.[0]?.message?.content?.trim() || CATEGORY_LIST[0];
        
        if (CATEGORY_LIST.map(c => c.toLowerCase()).includes(category.toLowerCase())) {
            return category;
        } else {
            return CATEGORY_LIST[0];
        }

    } catch (e) {
        log('OpenAI Classification error:', e.message);
        return CATEGORY_LIST[0];
    }
}

// ========== AI GENERATION FUNCTIONS (NEW SEO PROMPT) ==========
async function generateArticleAndMetadata({ title: sourceTitle, content: sourceContent, snippet: sourceSnippet }) {
    const rawContent = sourceSnippet || sourceContent.slice(0, 4000).replace(/<[^>]+>/g, '');
    
    const prompt = `CRITICAL ROLE: You are an expert SEO content writer and technical news analyst. Your task is to produce a concise, factual, and 100% original article based ONLY on the source material provided.

SOURCE ANALYSIS (Use this as your single source of truth):
Title: ${sourceTitle}
Content Snippet: ${rawContent}

NON-NEGOTIABLE REQUIREMENTS:
1. **SEO & QUALITY:** The article body must be highly readable, unique, and provide clear value.
2. **AUTHENTICITY:** All information must be strictly factual and derived ONLY from the source—AVOID any speculation or hallucination.
3. **STRUCTURE:** Use clear and logical HTML structure (paragraphs, h2 headings). Aim for a concise length (around 350-450 words) to optimize for reader time and token efficiency.
4. **PLAGIARISM-FREE:** Rewrite everything completely in your own words.

OUTPUT FORMAT (JSON ONLY - NO OTHER TEXT):
{
  "title": "SEO-Optimized 8-12 word title that summarizes the news",
  "search_description": "A highly compelling meta description (155-160 characters) for search engines", 
  "meta_tags": "Keyword1, Keyword2, Latest Tech, Industry News, Analysis",
  "alt_text": "Detailed 12-15 word description of the image content (e.g., A person typing code on a holographic screen)",
  "article_body": "Complete article with proper HTML (p, h2 tags). Must be 100% unique and factual."
}

FINAL VERIFICATION: Ensure the entire output is valid JSON and strictly adheres to the source material.`;

    try {
        const res = await openai.chat.completions.create({
            model: OPENAI_MODEL,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: MAX_TOKENS,
            response_format: { type: "json_object" }, 
            temperature: 0.7, 
        });

        let result = JSON.parse(res.choices?.[0]?.message?.content?.replace(/```json|```/g, '').trim() || '{}');
        
        // Clean up content
        if (result.article_body) {
             result.article_body = result.article_body
                .replace(/<a [^>]*>(.*?)<\/a>/gi, '$1') // Remove links
                .replace(/<img[^>]*>|<figure[^>]*>[\s\S]*?<\/figure>/gi, '') // Remove any image tags
                .trim();
        }
        
        log('Article and Metadata generated successfully');
        return result;

    } catch (e) {
        log('OpenAI Generation error:', e.message);
        return null;
    }
}

// ========== MAIN POSTING LOGIC ==========
async function processOnce() {
  try {
    const feed = await parser.parseURL(GSMARENA_RSS);
    if (!feed?.items?.length) return log('No feed items found.');

    const itemsToProcess = feed.items.filter(item => {
      const guid = item.guid || item.link;
      const title = item.title;
      // Using robust check (title_slug, guid, link)
      return !hasBeenPosted(guid, item.link, title); 
    }).slice(0, MAX_ITEMS_PER_RUN);
    
    if (itemsToProcess.length === 0) return log('No new items to post.');

    for (const item of itemsToProcess) {
      const guid = item.guid || item.link;
      const link = item.link;
      const title = item.title;
      
      log(`🔍 Processing: "${title}"`);
      PROCESSED_CACHE.add(guid); 

      const snippet = item.contentSnippet || '';
      const content = item['content:encoded'] || item.content || snippet;
      
      const articleData = await generateArticleAndMetadata({ title, snippet, content });
      
      if (!articleData || !articleData.article_body) {
          log('❌ Skipping post: AI failed to generate required structured content.');
          continue;
      }
      
      // Step 1: Image Fetching
      const unsplashImageUrl = await fetchUnsplashImage(articleData.alt_text);
      let finalImageUrl = null;
      
      if (unsplashImageUrl) {
          // Step 2: Try to upload to Blogger for thumbnail (Blogger API token required)
          const uploadedUrl = await uploadExternalImageToBlogger(unsplashImageUrl, articleData.title);
          finalImageUrl = uploadedUrl || unsplashImageUrl; // Fallback to direct Unsplash URL
      } else {
          log('⚠️ Proceeding without image. Unsplash search failed.');
      }
      
      // Step 3: SEO and Labels
      const postCategory = await classifyCategory(title);
      let labels = articleData.meta_tags.split(',').map(k => k.trim()).filter(Boolean);
      let finalLabels = [];
      if (postCategory) {
          finalLabels.push(postCategory); // Category is the first tag
          log(`🏷️ Category classified as: ${postCategory}`);
      }
      finalLabels = finalLabels.concat(labels.filter(l => l.toLowerCase() !== postCategory?.toLowerCase()));


      // Final HTML Construction
      const metaHtml = `<meta name="description" content="${articleData.search_description.slice(0, 160).replace(/["']/g, '')}">\n<meta name="keywords" content="${articleData.meta_tags}">`;
      
      let imageHtml = '';
      if (finalImageUrl) {
          // *** SOURCE CREDIT LINE IS REMOVED HERE AS PER USER REQUEST ***
          imageHtml = `<div style="text-align: center; margin: 20px 0;">
            <img src="${finalImageUrl}" 
                 alt="${articleData.alt_text}" 
                 title="${articleData.title}" 
                 style="max-width: ${MAX_IMAGE_HTML_WIDTH}px; width: 100%; height: auto; border-radius: 12px; display: block; margin: 0 auto;" />
          </div>\n`; 
      }

      const finalContent = `${metaHtml}${imageHtml}${articleData.article_body}`;

      // Step 4: Post to Blogger
      const res = await blogger.posts.insert({
        blogId: BLOG_ID,
        requestBody: { 
            title: articleData.title, 
            content: finalContent,
            labels: finalLabels.length ? finalLabels : undefined 
        }
      });

      log('✅ Posted:', res.data.url);
      log('🏷️ Tags used:', finalLabels.join(', '));
      markPosted({ guid, link, title, published_at: item.pubDate });
      
      if (MODE === 'once') return;
      await sleep(2000);
    }
  } catch (err) {
    log('processOnce error:', err.message);
  }
}

// ========== START EXECUTION ==========
async function start() {
  log(`🚀 Starting ${BLOG_BRAND_NAME} AutoPoster (Final Stable Build) in ${MODE} mode...`);
  
  if (!fs.existsSync(DB_PATH)) {
      log('⚠️ New Database will be created.');
  } else {
       log('⚠️ Existing DB found. If you see duplicates, run: rm -f ./data/posts.db');
  }

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
