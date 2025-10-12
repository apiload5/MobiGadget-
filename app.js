/**
 * app.js - FINAL BUILD (SEO Focused, Efficient, No Image Manipulation)
 *
 * This version is optimized for:
 * 1. Low Token Usage: Soft word count constraint (350-450 words) and efficient prompt.
 * 2. Pure SEO: Focus on structured JSON output for Title, Meta, Alt Text, and Tags.
 * 3. Clean Content: Removal of sharp and all local image processing logic.
 * 4. Multi-Feed Support: Rotation through configured RSS feeds.
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

// --- ENVIRONMENT VARIABLES AND CONFIG ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY; 

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const BLOG_ID = process.env.BLOG_ID;

// Use your specific GSMArena feed here. Default feeds kept for multi-feed compatibility.
const RSS_FEEDS_TO_PROCESS_STRING = process.env.RSS_FEEDS_TO_PROCESS || 
  'https://www.kdnuggets.com/feed,https://www.techrepublic.com/rssfeeds/topic/cybersecurity/'; 

const POST_INTERVAL_CRON = process.env.POST_INTERVAL_CRON || '0 */5 * * *'; 
const MAX_TOKENS = 3500; 
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'; 
const DB_PATH = process.env.DB_PATH || './data/posts.db';
const MODE = (process.env.MODE || 'cron').toLowerCase(); 
const USER_AGENT = process.env.USER_AGENT || 'TechBloggerAuto/1.0';

// Limit source characters sent to AI for token efficiency and focused context
const MAX_SOURCE_CHARS = 4000; 

// --- BASIC CHECKS ---
if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY not set in .env');
  process.exit(1);
}
if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !BLOG_ID) {
  console.error('ERROR: Blogger OAuth config missing. Post content will fail without a valid REFRESH_TOKEN.');
}
if (!UNSPLASH_ACCESS_KEY) {
    console.warn('WARNING: UNSPLASH_ACCESS_KEY is missing. Images will not be fetched automatically.');
}

// --- INITIALIZATION ---
const parser = new Parser({
    customFields: {
        item: ['content', 'contentSnippet', 'pubDate'],
    }
});
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
    feed_url TEXT,
    posted_at TEXT DEFAULT (datetime('now'))
  )
`).run();

// --- HELPER FUNCTIONS ---
function hasBeenPosted(guidOrLink) {
  const row = db.prepare('SELECT 1 FROM posted WHERE guid = ? OR link = ?').get(guidOrLink, guidOrLink);
  return !!row;
}

function markPosted({ guid, link, title, published_at, feed_url }) {
  const stmt = db.prepare('INSERT OR IGNORE INTO posted (guid, link, title, published_at, feed_url) VALUES (?, ?, ?, ?, ?)');
  stmt.run(guid || link, link, title, published_at || null, feed_url || null);
}

function getLastProcessedFeed() {
  const row = db.prepare('SELECT feed_url FROM posted ORDER BY posted_at DESC LIMIT 1').get();
  return row ? row.feed_url : null;
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Word count validation adjusted for the new prompt's target range
function validateWordCount(text, minWords = 350, maxWords = 550) {
    const wordCount = text.split(/\s+/).length;
    log(`Article word count: ${wordCount} words (Target: 350-450)`);
    return wordCount >= minWords && wordCount <= maxWords;
}

// --- CORE AI & FREE IMAGE FUNCTIONS ---

/**
 * Calls GPT to generate article content, title, and metadata in JSON format.
 * Uses the new, efficient, and factual SEO prompt.
 */
async function generateArticleAndMetadata(sourceContent) {
  // --- UPDATED PROMPT FOR EFFICIENCY AND FACTUAL CONTENT ---
  const prompt = `CRITICAL ROLE: You are an expert SEO content writer and technical news analyst. Your task is to produce a concise, factual, and 100% original article based ONLY on the source material provided.

SOURCE ANALYSIS (Use this as your single source of truth):
${sourceContent}

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
  // --- END OF UPDATED PROMPT ---

    try {
        const completion = await openai.chat.completions.create({
            model: OPENAI_MODEL,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: MAX_TOKENS,
            response_format: { type: "json_object" }, 
            temperature: 0.7, 
        });

        if (!completion.choices || !completion.choices[0] || !completion.choices[0].message) {
            throw new Error('Invalid response structure from OpenAI');
        }

        let jsonText = completion.choices[0].message.content;
        if (!jsonText) {
            throw new Error('Empty content from OpenAI');
        }
        
        jsonText = jsonText.replace(/```json|```/g, '').trim(); 
        
        let result;
        try {
            result = JSON.parse(jsonText);
        } catch (parseError) {
            log('JSON parse error. Raw content:', jsonText);
            throw new Error('Failed to parse JSON from OpenAI response');
        }
        
        const required = ['title', 'search_description', 'meta_tags', 'alt_text', 'article_body'];
        for (const field of required) {
            if (!result[field]) {
                throw new Error(`Missing required field: ${field}`);
            }
        }

        // Validate word count against the defined min/max range
        validateWordCount(result.article_body); 

        result.article_body = result.article_body
            .replace(/<a [^>]*>(.*?)<\/a>/gi, '$1') // Remove links in the rewritten body
            .replace(/\n\s*\n/g, '\n') 
            .trim();
        
        log('Article generated successfully');
        return result;

    } catch (err) {
        log('OpenAI Generation error:', err?.message || err);
        throw new Error('Failed to generate structured article content.');
    }
}

/**
 * Fetches a random high-quality image from Unsplash based on the search query (altText).
 */
async function fetchUnsplashImage(query) {
    if (!UNSPLASH_ACCESS_KEY) {
        return null;
    }

    try {
        log(`Searching Unsplash for: ${query}`);
        const UNSPLASH_URL = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape&client_id=${UNSPLASH_ACCESS_KEY}`;
        
        const res = await axios.get(UNSPLASH_URL, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 10000 
        });

        if (res.data.results && res.data.results.length > 0) {
            const image = res.data.results[0];
            log('Unsplash image found successfully');
            // Using 'regular' size directly
            return image.urls.regular; 
        } else {
            log('No images found on Unsplash for query:', query);
            return null;
        }
    } catch (err) {
        log('Unsplash API Error:', err?.message);
        return null; 
    }
}

/**
 * Uploads image to Blogger for proper thumbnail generation.
 */
async function uploadExternalImageToBlogger(imageUrl, title) {
    // CRITICAL: This part requires a working REFRESH_TOKEN with correct scopes.
    try {
        // 1. Get image data to determine MIME type and size 
        const imageResponse = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': USER_AGENT },
            timeout: 30000
        });
        
        const mimeType = imageResponse.headers['content-type'] || 'image/jpeg';
        const base64Image = Buffer.from(imageResponse.data).toString('base64');

        const timestamp = Date.now();
        const filename = `techblogger-${timestamp}.jpg`; 

        // 2. Insert as media (Blogger API upload)
        const media = await blogger.media.insert({
            blogId: BLOG_ID,
            requestBody: { title: `Image for ${title}`, fileName: filename },
            media: { mimeType: mimeType, data: base64Image }
        });
        
        log('✅ Image uploaded to Blogger successfully (for thumbnail)');
        return media.data.url;
    } catch (err) {
        // If upload fails (due to token issue), we fall back to the direct Unsplash URL
        log('❌ CRITICAL ERROR: Image upload failed. CHECK REFRESH_TOKEN/SCOPES.', err.message);
        return null; 
    }
}

// --- MAIN PROCESSING LOGIC ---

async function processOnce() {
  try {
    const feedUrls = RSS_FEEDS_TO_PROCESS_STRING.split(',').map(url => url.trim()).filter(Boolean);
    let allItems = [];

    log('--- Starting new run ---');
    
    // 1. Determine which feed to process next (Round-Robin logic)
    const lastProcessedFeed = getLastProcessedFeed();
    let feedToProcess = feedUrls[0]; 
    
    if (lastProcessedFeed && feedUrls.length > 1) {
        const lastIndex = feedUrls.findIndex(url => url === lastProcessedFeed);
        const nextIndex = (lastIndex + 1) % feedUrls.length;
        feedToProcess = feedUrls[nextIndex];
    } else if (feedUrls.length === 0) {
        log('ERROR: No RSS feeds configured in .env');
        return;
    }

    log(`Targeting the next feed in rotation: ${feedToProcess}`);

    // 2. Fetch items ONLY from the TARGET feed
    try {
        const feed = await parser.parseURL(feedToProcess);
        const newItems = feed.items.slice(0, 3).map(item => ({
            ...item,
            feedUrl: feedToProcess,
            pubDateParsed: item.pubDate ? new Date(item.pubDate) : new Date(0)
        }));
        allItems.push(...newItems);
        log(`Fetched ${newItems.length} items from ${feedToProcess}`);
    } catch (e) {
        log(`Failed to fetch target feed: ${feedToProcess}. Error: ${e.message}`);
        return; 
    }
    
    // 3. Filter and Sort to find the single newest UNPOSTED item from the target feed
    const unpostedItems = allItems
        .filter(item => {
            const identifier = item.guid || item.link; 
            if (!identifier) return false; 
            const posted = hasBeenPosted(identifier);
            if (!posted) {
                log(`Newest unposted item found: ${item.title}`);
            }
            return !posted;
        })
        .sort((a, b) => b.pubDateParsed.getTime() - a.pubDateParsed.getTime()); 
    
    if (!unpostedItems.length) {
        log(`No new, unposted items found in the current target feed (${feedToProcess}).`);
        return;
    }

    // 4. Select the newest UNPOSTED item
    const primaryItem = unpostedItems[0];
    
    // CONTENT TRUNCATION: Limit source for token efficiency
    const rawContent = primaryItem.contentSnippet || primaryItem.content || 'No content available';
    const filteredContent = rawContent.length > MAX_SOURCE_CHARS 
        ? rawContent.substring(0, MAX_SOURCE_CHARS) + ' [Content Truncated]' 
        : rawContent;
    
    const sourceContent = `
PRIMARY SOURCE:
Title: ${primaryItem.title}
Content: ${filteredContent}
Published: ${primaryItem.pubDate || 'Unknown date'}
Source: ${primaryItem.feedUrl}
`;

    log(`Synthesizing SEO article based on: "${primaryItem.title}"`);
    
    // 5. Generate Article, Title, and Metadata
    let articleData;
    try {
        articleData = await generateArticleAndMetadata(sourceContent);
        log('Article generation completed');
    } catch (e) {
        log('Article generation failed. Skipping post.');
        return;
    }

    // 6. Fetch and Embed Image
    let finalHtml = '';
    let imageUrl = await fetchUnsplashImage(articleData.alt_text);

    if (imageUrl) {
        // Attempt Blogger upload for thumbnail, use Unsplash URL as fallback
        const finalImageUrl = await uploadExternalImageToBlogger(imageUrl, articleData.title) || imageUrl;
        
        log('Image embedding in post');
        finalHtml += `<div style="text-align: center; margin: 20px 0;">
            <img src="${finalImageUrl}" alt="${escapeHtml(articleData.alt_text)}" title="${escapeHtml(articleData.title)}" style="max-width: 100%; height: auto; border-radius: 12px; box-shadow: 0 4px 8px rgba(0,0,0,0.1);" />
            <p style="font-style: italic; color: #666; margin-top: 8px; font-size: 14px;">Image Source: Unsplash</p>
        </div>\n`;
    } else {
        log('Image fetching failed - proceeding without image');
    }
    
    finalHtml += articleData.article_body;
    
    // Set labels (tags)
    const labels = articleData.meta_tags.split(',').map(t => t.trim()).filter(Boolean);
    
    // 7. Post to Blogger
    let posted;
    try {
        log('Posting to Blogger...');
        posted = await createBloggerPost({ 
            title: articleData.title, 
            htmlContent: finalHtml, 
            labels: labels 
        });
        log('Blogger post successful');
    } catch (e) {
        log('Failed to post to Blogger:', e.message);
        return;
    }

    // 8. Mark as Posted 
    log('=== POST SUCCESSFUL ===');
    log('Title:', articleData.title);
    log('Blogger URL:', posted.url);
    log('Source Feed:', primaryItem.feedUrl);
    
    markPosted({ 
        guid: primaryItem.guid || primaryItem.link, 
        link: primaryItem.link, 
        title: articleData.title, 
        published_at: primaryItem.pubDate || null,
        feed_url: primaryItem.feedUrl
    });
    
    await sleep(5000); 

  } catch (err) {
    log('processOnce Critical Error:', err?.message || err);
  }
}

// --- BLOGGER API FUNCTION ---
async function createBloggerPost({ title, htmlContent, labels = [] }) {
  try {
    const res = await blogger.posts.insert({
      blogId: BLOG_ID,
      requestBody: {
        title,
        content: htmlContent,
        // Fallback labels for safety
        labels: labels.length ? labels : ['Tech News', 'Analysis'] 
      }
    });
    return res.data;
  } catch (err) {
    log('Blogger API error (Post Insertion):', err?.message || err?.toString());
    throw err;
  }
}

// --- START APPLICATION ---
async function start() {
  log('Starting TechBloggerAuto (Final Efficient Build)', { 
    MODE, 
    OPENAI_MODEL, 
    MAX_SOURCE_CHARS,
    RSS_FEEDS: RSS_FEEDS_TO_PROCESS_STRING.split(',').length
  });
  
  if (MODE === 'once') {
    await processOnce();
    log('Finished single run. Exiting.');
    process.exit(0);
  } else {
    log(`Scheduling cron: ${POST_INTERVAL_CRON}`);
    await processOnce(); 
    cron.schedule(POST_INTERVAL_CRON, processOnce);
    process.stdin.resume(); 
  }
}

// Global error handling
process.on('unhandledRejection', (reason, promise) => {
  log('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  log('Uncaught Exception:', error);
  process.exit(1);
});

start().catch(e => { 
  log('Fatal startup error:', e?.message || e); 
  process.exit(1); 
});
