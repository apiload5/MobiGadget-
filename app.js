/**
 * app.js
 * 
 * GSMArena -> OpenAI -> Blogger with Perfect Logo Replacement
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
const USER_AGENT = process.env.USER_AGENT || 'MobiGadget/1.0';
const CUSTOM_LOGO_PATH = process.env.CUSTOM_LOGO_PATH || './assets/logo.png';
const MAX_IMAGE_WIDTH = process.env.MAX_IMAGE_WIDTH || '1000'; // Increased to 1000px

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

// Database schema
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
  const stmt = db.prepare('INSERT OR IGNORE INTO posted (guid, link, title, published_at) VALUES (?, ?, ?, ?)');
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

// PERFECT LOGO REPLACEMENT FUNCTION
async function replaceGSMArenaLogo(originalImageUrl, customLogoPath) {
  try {
    log('🔄 Starting logo replacement process...');
    
    // Download original image
    const imageResponse = await axios.get(originalImageUrl, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': USER_AGENT },
      timeout: 30000
    });
    
    // Download custom logo
    const logoBuffer = fs.readFileSync(customLogoPath);
    
    // Process original image
    let originalImage = sharp(imageResponse.data);
    const metadata = await originalImage.metadata();
    
    log(`📐 Original image dimensions: ${metadata.width}x${metadata.height}`);
    
    // RESIZE ORIGINAL IMAGE TO LARGER SIZE
    const targetWidth = Math.min(metadata.width, 1200); // Max 1200px width
    const resizedImage = await originalImage
      .resize(targetWidth, null, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: 90 })
      .toBuffer();
    
    // Get resized dimensions
    const resizedMetadata = await sharp(resizedImage).metadata();
    log(`📏 Resized image to: ${resizedMetadata.width}x${resizedMetadata.height}`);
    
    // Calculate logo size (8% of image width - optimal visibility)
    const logoWidth = Math.floor(resizedMetadata.width * 0.08);
    const logoHeight = Math.floor(logoWidth * 0.8); // Maintain aspect ratio
    
    log(`🎯 Logo size: ${logoWidth}x${logoHeight}`);
    
    // Resize logo with white background for better visibility
    const resizedLogo = await sharp(logoBuffer)
      .resize(logoWidth, logoHeight, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 0.9 } // Semi-transparent white background
      })
      .png()
      .toBuffer();
    
    // Position: Bottom Right corner with small margin
    const left = resizedMetadata.width - logoWidth - 15;
    const top = resizedMetadata.height - logoHeight - 15;
    
    log(`📍 Logo position: ${left}px from left, ${top}px from top`);
    
    // Composite logo onto resized image
    const finalImageBuffer = await sharp(resizedImage)
      .composite([{
        input: resizedLogo,
        top: top,
        left: left,
        blend: 'over' // Proper blending mode
      }])
      .jpeg({ 
        quality: 85,
        mozjpeg: true 
      })
      .toBuffer();
    
    log('✅ Logo replacement completed successfully');
    return finalImageBuffer;
    
  } catch (err) {
    log('❌ Logo replacement failed:', err.message);
    return null;
  }
}

async function uploadImageToBlogger(imageBuffer, title) {
  try {
    const base64Image = imageBuffer.toString('base64');
    const timestamp = Date.now();
    const filename = `mobigadget-${timestamp}.jpg`;
    
    const media = await blogger.media.insert({
      blogId: BLOG_ID,
      media: {
        mimeType: 'image/jpeg',
        data: base64Image
      },
      requestBody: {
        title: `MobiGadget - ${title}`,
        fileName: filename
      }
    });
    
    log('✅ Image uploaded to Blogger successfully');
    return media.data.url;
  } catch (err) {
    log('❌ Image upload error:', err?.message || err);
    return null;
  }
}
// --- AI FUNCTIONS (FINAL IMPROVED PROMPTS) ---

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

    // Clean up
    text = text.replace(/\.\.\.\s*html/gi, '');
    text = text.replace(/<a [^>]*>(.*?)<\/a>/gi, '$1');

    return text;
  } catch (err) {
    log('OpenAI rewrite error:', err?.message || err);
    throw err;
  }
}

// IMPROVED ALT TEXT - Focus on image description for Accessibility & SEO
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
    
    // Clean up
    altText = altText.replace(/^alt text:?/i, '').trim();
    altText = altText.replace(/^["']|["']$/g, '');
    
    return altText || `Detailed view of ${title}`;
  } catch (err) {
    log('Alt error:', err?.message || err);
    return `Close up shot of ${title}`;
  }
}

// IMPROVED TITLE TEXT - Focus on core SEO keywords
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
    
    // Clean up
    titleText = titleText.replace(/^title:?/i, '').trim();
    titleText = titleText.replace(/^["']|["']$/g, '');
    
    return titleText || 'latest smartphone technology';
  } catch (err) {
    log('Title error:', err?.message || err);
    return 'mobile tech innovation';
  }
}

// IMPROVED TAGS - Focus on High-Ranking, Relevant Keywords for SEO Labels
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
    log('📡 Fetching RSS:', GSMARENA_RSS);
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

      // Duplicate check
      if (hasBeenPosted(guid) || hasBeenPosted(link)) {
        log('❌ Already posted:', title);
        continue;
      }

      log('✅ Processing new item:', title);

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
      
      if (!imageUrl) {
        imageUrl = extractFirstImageFromHtml(fullContent);
      }

      let rewrittenHtml = '';
      try {
        rewrittenHtml = await rewriteWithOpenAI({ title, snippet, content: fullContent });
      } catch (e) {
        log('OpenAI rewrite failed:', title);
        continue;
      }

      let finalHtml = '';
      if (imageUrl) {
        const altText = await generateImageAlt(title, snippet, fullContent);
        const titleText = await generateImageTitle(title, snippet, fullContent);
        
        log(`🖼️ Image found: ${imageUrl}`);
        log(`📝 Alt Text: ${altText}`);
        log(`🏷️ Title Text: ${titleText}`);
        
        // LOGO REPLACEMENT FOR ALL IMAGES (not just GSMArena)
        const customLogoPath = CUSTOM_LOGO_PATH;
        
        if (fs.existsSync(customLogoPath)) {
          try {
            log('🎨 Applying logo watermark...');
            const watermarkedImageBuffer = await replaceGSMArenaLogo(imageUrl, customLogoPath);
            
            if (watermarkedImageBuffer) {
              const uploadedImageUrl = await uploadImageToBlogger(watermarkedImageBuffer, title);
              
              if (uploadedImageUrl) {
                finalHtml += `<div style="text-align: center; margin: 20px 0;">
                  <img src="${uploadedImageUrl}" 
                       alt="${escapeHtml(altText)}" 
                       title="${escapeHtml(titleText)}" 
                       style="max-width: ${MAX_IMAGE_WIDTH}px; width: 100%; height: auto; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />
                  <p style="font-style: italic; color: #666; margin-top: 8px; font-size: 14px;">Image: ${escapeHtml(altText)}</p>
                </div>\n`;
                log('✅ Logo watermark applied successfully');
              } else {
                throw new Error('Failed to upload watermarked image');
              }
            } else {
              throw new Error('Failed to create watermarked image');
            }
          } catch (watermarkError) {
            log('❌ Watermarking failed, using original image:', watermarkError.message);
            // Fallback to original image
            finalHtml += `<div style="text-align: center; margin: 20px 0;">
              <img src="${imageUrl}" 
                   alt="${escapeHtml(altText)}" 
                   title="${escapeHtml(titleText)}" 
                   style="max-width: ${MAX_IMAGE_WIDTH}px; width: 100%; height: auto; border-radius: 8px;" />
            </div>\n`;
          }
        } else {
          log('❌ Custom logo not found, using original image');
          finalHtml += `<div style="text-align: center; margin: 20px 0;">
            <img src="${imageUrl}" 
                 alt="${escapeHtml(altText)}" 
                 title="${escapeHtml(titleText)}" 
                 style="max-width: ${MAX_IMAGE_WIDTH}px; width: 100%; height: auto; border-radius: 8px;" />
          </div>\n`;
        }
      }
      
      finalHtml += rewrittenHtml;

      const tags = await generateTags(title, snippet, fullContent);

      let posted;
      try {
        posted = await createBloggerPost({ title, htmlContent: finalHtml, labels: tags });
      } catch (e) {
        log('Failed to post to Blogger for:', title);
        continue;
      }

      log('✅ Posted to Blogger:', posted.url || posted.id);
      log('🏷️ Tags used:', tags);
      
      markPosted({ 
        guid, 
        link, 
        title, 
        published_at: item.pubDate || item.isoDate || null 
      });
      
      await sleep(3000);

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
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' 
  }[m]));
}

async function start() {
  log('🚀 Starting MobiGadget with Perfect Logo Replacement', { 
    MODE, 
    OPENAI_MODEL, 
    GSMARENA_RSS,
    CUSTOM_LOGO_PATH,
    MAX_IMAGE_WIDTH: '1000px'
  });
  
  // Check assets
  if (fs.existsSync(CUSTOM_LOGO_PATH)) {
    log('✅ Custom logo found:', CUSTOM_LOGO_PATH);
  } else {
    log('❌ ERROR: Custom logo not found at:', CUSTOM_LOGO_PATH);
    log('💡 Please add your logo.png file to the assets folder');
  }
  
  if (MODE === 'once') {
    await processOnce();
    log('🎯 Finished single run. Exiting.');
    process.exit(0);
  } else {
    log('⏰ Scheduling cron:', POST_INTERVAL_CRON);
    await processOnce();
    cron.schedule(POST_INTERVAL_CRON, processOnce);
    process.stdin.resume();
  }
}

start().catch(e => { 
  log('💥 Fatal error:', e?.message || e); 
  process.exit(1); 
});
