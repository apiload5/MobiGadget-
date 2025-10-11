/**
 * app.js
 *
 * Hybrid GSMArena/Engadget -> OpenAI -> Blogger autoposter
 * With custom logo replacement and enhanced content analysis
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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const BLOG_ID = process.env.BLOG_ID;

const GSMARENA_RSS = process.env.GSMARENA_RSS;
// CRON INTERVAL SET TO A SAFE 3-HOUR INTERVAL FOR TRIAL (8 RUNS/DAY)
const POST_INTERVAL_CRON = process.env.POST_INTERVAL_CRON || '0 */3 * * *';
// MAX ITEMS SET TO 1 TO AVOID BURSTING THE TRIAL LIMIT
const MAX_ITEMS_PER_RUN = parseInt(process.env.MAX_ITEMS_PER_RUN || '1', 10);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DB_PATH = process.env.DB_PATH || './data/posts.db';
const MODE = (process.env.MODE || 'cron').toLowerCase();
const USER_AGENT = process.env.USER_AGENT || 'MobiGadget/1.0';
const CUSTOM_LOGO_PATH = process.env.CUSTOM_LOGO_PATH || './assets/logo.png';
const MAX_IMAGE_WIDTH = process.env.MAX_IMAGE_WIDTH || '800';

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
  const m = html.match(/property=["']og:image["']\s*content=["']([^"']+)["']/i) || 
            html.match(/<meta[^>]*name=["']og:image["'][^>]*content=["']([^"']+)["']/i);
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

function extractNewsDetails(html) {
  if (!html) return {};
  
  const details = {};
  
  // Extract author information
  const authorMatch = html.match(/<a[^>]*class=["']author["'][^>]*>([^<]+)<\/a>/i) ||
                     html.match(/<span[^>]*class=["']author["'][^>]*>([^<]+)<\/span>/i) ||
                     html.match(/<meta[^>]*name=["']author["'][^>]*content=["']([^"']+)["']/i);
  if (authorMatch) details.author = authorMatch[1].trim();
  
  // Extract publication date
  const dateMatch = html.match(/<time[^>]*datetime=["']([^"']+)["']/i) ||
                   html.match(/<meta[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i) ||
                   html.match(/<span[^>]*class=["']date["'][^>]*>([^<]+)<\/span>/i);
  if (dateMatch) details.publishedDate = dateMatch[1].trim();
  
  // Extract category/tags
  const categoryMatch = html.match(/<a[^>]*class=["']category["'][^>]*>([^<]+)<\/a>/i) ||
                       html.match(/<meta[^>]*property=["']article:section["'][^>]*content=["']([^"']+)["']/i);
  if (categoryMatch) details.category = categoryMatch[1].trim();
  
  // Extract summary/description
  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                   html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
  if (descMatch) details.description = descMatch[1].trim();
  
  return details;
}

async function rewriteWithOpenAI({ title, snippet, content, newsDetails = {} }) {
  // ENHANCED PROMPT: Includes news details for more comprehensive rewriting
  const prompt = `You are a highly skilled SEO Content Writer and Tech Journalist. Rewrite the following article into a **unique, high-quality, and comprehensive English news post** for a professional tech blog.

Article Context:
- Title: ${title}
- Snippet: ${snippet || 'Not provided'}
${newsDetails.author ? `- Original Author: ${newsDetails.author}` : ''}
${newsDetails.publishedDate ? `- Publication Date: ${newsDetails.publishedDate}` : ''}
${newsDetails.category ? `- Category: ${newsDetails.category}` : ''}
${newsDetails.description ? `- Description: ${newsDetails.description}` : ''}

Rules for SEO and Originality:
1.  **Originality First:** Your main goal is to generate content that is **NOT duplicate**. Paraphrase and restructure the input completely.
2.  **Completeness/Depth:** The post must fully answer the user's intent. **Expand the topic to reach a minimum length of 1200 words** with comprehensive analysis.
3.  **News Analysis:** Provide expert analysis, market context, and future implications of the news.
4.  **Structure:** Use a compelling main headline (H1) and relevant, structured subheadings (H2, H3) for readability and SEO.
5.  **Formatting:** Use standard HTML formatting (p, strong, ul, ol, blockquote for important points).
6.  **Clean Output:** **DO NOT** include any links (hyperlinks/<a> tags). **DO NOT** include any introductory or concluding remarks outside the main article body.
7.  **Language:** Write in professional, clear English only.
8.  **Output Format:** Return **ONLY** the final HTML content for the article body.

Original Content:
${content || ''}`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4000 // Increased for comprehensive analysis
    });
    let text = completion.choices?.[0]?.message?.content || '';

    // Cleanup steps
    text = text.replace(/\.\.\.\s*html/gi, '');
    text = text.replace(/<a [^>]*>(.*?)<\/a>/gi, '$1');
    text = text.replace(/^```html|```$/g, '').trim();

    return text;
  } catch (err) {
    log('OpenAI rewrite error:', err?.message || err);
    throw err;
  }
}

async function generateImageAlt(title, snippet, content, newsDetails = {}) {
  const context = newsDetails.description ? `Description: ${newsDetails.description}` : '';
  const prompt = `Generate a descriptive image alt text (5-10 words) that explains what the picture shows based on this article:\nTitle: ${title}\nSnippet: ${snippet}\n${context}\nOnly return alt text.`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 40
    });
    return (completion.choices?.[0]?.message?.content || title).trim();
  } catch (err) {
    log('Alt error:', err?.message || err);
    return title;
  }
}

async function generateImageTitle(title, snippet, content, newsDetails = {}) {
  const context = newsDetails.description ? `Description: ${newsDetails.description}` : '';
  const prompt = `Generate a short SEO-friendly title text (3-6 words) for an image in this article:\nTitle: ${title}\nSnippet: ${snippet}\n${context}\nOnly return title text.`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 20
    });
    return (completion.choices?.[0]?.message?.content || title).trim();
  } catch (err) {
    log('Title error:', err?.message || err);
    return title;
  }
}

async function generateTags(title, snippet, content, newsDetails = {}) {
  const context = newsDetails.category ? `Category: ${newsDetails.category}` : '';
  const prompt = `Generate 3-6 SEO-friendly tags for this article. Return as comma-separated keywords only.\nTitle: ${title}\nSnippet: ${snippet}\n${context}`;

  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 40
    });
    const tags = (completion.choices?.[0]?.message?.content || '').split(',').map(t => t.trim()).filter(Boolean);
    return tags;
  } catch (err) {
    log('Tags error:', err?.message || err);
    return [];
  }
}

async function uploadImageToBlogger(imagePath, title) {
  try {
    // Read the image file
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    
    // Create a unique filename
    const timestamp = Date.now();
    const filename = `logo-${timestamp}.png`;
    
    // Upload to Blogger
    const media = await blogger.media.insert({
      blogId: BLOG_ID,
      media: {
        mimeType: 'image/png',
        data: base64Image
      },
      requestBody: {
        title: `Logo for ${title}`,
        fileName: filename
      }
    });
    
    return media.data.url;
  } catch (err) {
    log('Image upload error:', err?.message || err);
    return null;
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
      const title = item.title || 'Untitled';

      if (hasBeenPosted(guid) || hasBeenPosted(link)) {
        log('Already posted:', title);
        continue;
      }

      log('Processing new item:', title);

      let snippet = item.contentSnippet || '';
      let fullContent = item['content:encoded'] || item.content || snippet;
      let imageUrl = null;
      let isGSMArenaImage = false;
      let newsDetails = {};

      if (link) {
        const pageHtml = await fetchPage(link);
        if (pageHtml) {
          const extracted = extractMainArticle(pageHtml);
          if (extracted) fullContent = extracted;
          
          // Extract news details
          newsDetails = extractNewsDetails(pageHtml);
          log('Extracted news details:', newsDetails);
          
          if (!imageUrl) imageUrl = extractOgImage(pageHtml) || extractFirstImageFromHtml(pageHtml);
          
          // Check if this is a GSMArena image
          if (imageUrl && (link.includes('gsmarena.com') || imageUrl.includes('gsmarena'))) {
            isGSMArenaImage = true;
            log('Detected GSMArena image, will replace with custom logo');
          }
        }
      }
      
      if (!imageUrl) {
        imageUrl = extractFirstImageFromHtml(fullContent);
        if (imageUrl && imageUrl.includes('gsmarena')) {
          isGSMArenaImage = true;
        }
      }

      let rewrittenHtml = '';
      try {
        rewrittenHtml = await rewriteWithOpenAI({ 
          title, 
          snippet, 
          content: fullContent,
          newsDetails 
        });
      } catch (e) {
        log('OpenAI rewrite failed:', title);
        continue;
      }

      let finalHtml = '';
      if (imageUrl) {
        const altText = await generateImageAlt(title, snippet, fullContent, newsDetails);
        const titleText = await generateImageTitle(title, snippet, fullContent, newsDetails);
        
        // NEW LOGIC: Replace GSMArena images with custom logo
        if (isGSMArenaImage) {
          // Use your custom logo instead of GSMArena image
          const customLogoPath = CUSTOM_LOGO_PATH;
          
          // Check if custom logo exists
          if (fs.existsSync(customLogoPath)) {
            // Upload custom logo to Blogger and get URL
            const uploadedLogoUrl = await uploadImageToBlogger(customLogoPath, title);
            
            if (uploadedLogoUrl) {
              finalHtml += `<div style="text-align: center; margin: 20px 0;">
                <img src="${uploadedLogoUrl}" 
                     alt="${escapeHtml(altText)}" 
                     title="${escapeHtml(titleText)}" 
                     style="max-width: ${MAX_IMAGE_WIDTH}px; width: 100%; height: auto; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1);" />
                <p style="font-style: italic; color: #666; margin-top: 8px;">${escapeHtml(altText)}</p>
              </div>\n`;
              log('Replaced GSMArena image with custom logo');
            } else {
              // Fallback if upload fails
              finalHtml += `<div style="text-align: center; margin: 20px 0;">
                <img src="${imageUrl}" 
                     alt="${escapeHtml(altText)}" 
                     title="${escapeHtml(titleText)}" 
                     style="max-width: ${MAX_IMAGE_WIDTH}px; width: 100%; height: auto; border-radius: 8px;" />
              </div>\n`;
            }
          } else {
            log('Custom logo not found at:', customLogoPath);
            // Fallback to original image with better styling
            finalHtml += `<div style="text-align: center; margin: 20px 0;">
              <img src="${imageUrl}" 
                   alt="${escapeHtml(altText)}" 
                   title="${escapeHtml(titleText)}" 
                   style="max-width: ${MAX_IMAGE_WIDTH}px; width: 100%; height: auto; border-radius: 8px;" />
            </div>\n`;
          }
        } else {
          // For non-GSMArena images
          finalHtml += `<div style="text-align: center; margin: 20px 0;">
            <img src="${imageUrl}" 
                 alt="${escapeHtml(altText)}" 
                 title="${escapeHtml(titleText)}" 
                 style="max-width: ${MAX_IMAGE_WIDTH}px; width: 100%; height: auto; border-radius: 8px;" />
          </div>\n`;
        }
      }
      
      finalHtml += rewrittenHtml;

      const tags = await generateTags(title, snippet, fullContent, newsDetails);

      let posted;
      try {
        posted = await createBloggerPost({ 
          title, 
          htmlContent: finalHtml, 
          labels: tags 
        });
      } catch (e) {
        log('Failed to post to Blogger for:', title);
        continue;
      }

      log('Posted to Blogger:', posted.url || posted.id || '(no url returned)');
      log('Used tags:', tags);
      log('News details utilized:', Object.keys(newsDetails).length > 0 ? newsDetails : 'None');
      
      markPosted({ 
        guid, 
        link, 
        title, 
        published_at: item.pubDate || item.isoDate || null 
      });
      
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

function sleep(ms) { 
  return new Promise(r => setTimeout(r, ms)); 
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', 
    '<': '&lt;', 
    '>': '&gt;', 
    '"': '&quot;', 
    "'": '&#039;' 
  }[m]));
}

async function start() {
  log('Starting GSM2Blogger', { 
    MODE, 
    OPENAI_MODEL, 
    GSMARENA_RSS, 
    DB_PATH,
    CUSTOM_LOGO_PATH,
    MAX_IMAGE_WIDTH 
  });
  
  // Check if custom logo exists
  if (fs.existsSync(CUSTOM_LOGO_PATH)) {
    log('Custom logo found at:', CUSTOM_LOGO_PATH);
  } else {
    log('Warning: Custom logo not found at:', CUSTOM_LOGO_PATH);
  }
  
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

start().catch(e => { 
  log('Fatal error:', e?.message || e); 
  process.exit(1); 
});
