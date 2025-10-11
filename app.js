/**
 * app.js
 * 
 * MobiGadget - GSMArena RSS to Blogger Auto Poster
 * Advanced duplicate prevention + logo replacement
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
const MODE = (process.env.MODE || 'once').toLowerCase();
const USER_AGENT = process.env.USER_AGENT || 'MobiGadget/1.0';
const CUSTOM_LOGO_PATH = process.env.CUSTOM_LOGO_PATH || './assets/logo.png';
const MAX_IMAGE_WIDTH = process.env.MAX_IMAGE_WIDTH || '1000';

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

// ENHANCED DATABASE SCHEMA
db.prepare(`
  CREATE TABLE IF NOT EXISTS posted (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE,
    link TEXT UNIQUE,
    title TEXT,
    title_slug TEXT UNIQUE,
    content_hash TEXT,
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

// FUNCTION: Advanced duplicate checking
function hasBeenPosted(guid, link, title) {
  const titleSlug = generateSlug(title);
  
  // Check exact matches
  const exactMatch = db.prepare(`
    SELECT 1 FROM posted WHERE guid = ? OR link = ? OR title_slug = ?
  `).get(guid, link, titleSlug);
  
  if (exactMatch) return true;
  
  // Check similar titles (first 5 words)
  const titleWords = title.toLowerCase().split(' ').slice(0, 5).join(' ');
  const similarMatch = db.prepare(`
    SELECT title FROM posted WHERE title LIKE ?
  `).get(`%${titleWords}%`);
  
  return !!similarMatch;
}

// FUNCTION: Mark as posted
function markPosted({ guid, link, title, content_hash, published_at }) {
  const titleSlug = generateSlug(title);
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO posted 
    (guid, link, title, title_slug, content_hash, published_at) 
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(guid, link, title, titleSlug, content_hash, published_at || null);
}

// FUNCTION: Log with timestamp
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// FUNCTION: Fetch webpage
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

// FUNCTION: Extract first image from HTML
function extractFirstImageFromHtml(html) {
  if (!html) return null;
  const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];
  return null;
}

// FUNCTION: Extract OG image
function extractOgImage(html) {
  if (!html) return null;
  const m = html.match(/property=["']og:image["']\s*content=["']([^"']+)["']/i) || 
            html.match(/<meta[^>]*name=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  if (m) return m[1];
  return null;
}

// FUNCTION: Extract main article content
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

// FUNCTION: Replace GSMArena logo with custom logo
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
    
    // Resize original image to larger size
    const targetWidth = Math.min(metadata.width, 1200);
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
    
    // Calculate logo size (8% of image width)
    const logoWidth = Math.floor(resizedMetadata.width * 0.08);
    const logoHeight = Math.floor(logoWidth * 0.8);
    
    log(`🎯 Logo size: ${logoWidth}x${logoHeight}`);
    
    // Resize logo
    const resizedLogo = await sharp(logoBuffer)
      .resize(logoWidth, logoHeight, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 0.9 }
      })
      .png()
      .toBuffer();
    
    // Position: Bottom Right corner
    const left = resizedMetadata.width - logoWidth - 15;
    const top = resizedMetadata.height - logoHeight - 15;
    
    log(`📍 Logo position: ${left}px from left, ${top}px from top`);
    
    // Composite logo onto resized image
    const finalImageBuffer = await sharp(resizedImage)
      .composite([{
        input: resizedLogo,
        top: top,
        left: left,
        blend: 'over'
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

// FUNCTION: Upload image to Blogger (Base64 fallback)
async function uploadImageToBlogger(imageBuffer, title) {
  try {
    const base64Image = imageBuffer.toString('base64');
    const timestamp = Date.now();
    const filename = `mobigadget-${timestamp}.jpg`;
    
    log('📤 Uploading image to Blogger...');
    
    const media = await blogger.media.insert({
      blogId: BLOG_ID,
      requestBody: {
        title: `MobiGadget - ${title}`,
        fileName: filename
      },
      media: {
        mimeType: 'image/jpeg',
        data: base64Image
      }
    });
    
    log('✅ Image uploaded to Blogger successfully');
    return media.data.url;
  } catch (err) {
    log('❌ Image upload failed, using base64 fallback:', err.message);
    
    // Fallback: Use base64 data URL
    const base64Data = imageBuffer.toString('base64');
    const dataUrl = `data:image/jpeg;base64,${base64Data}`;
    return dataUrl;
  }
}

// FUNCTION: Rewrite content with OpenAI
async function rewriteWithOpenAI({ title, snippet, content }) {
  const prompt = `You are a highly skilled SEO Content Writer. Rewrite the following article into a **unique, high-quality, and comprehensive English news post** for a professional tech blog.

Rules for SEO and Originality:
1.  **Originality First:** Your main goal is to generate content that is **NOT duplicate**. Paraphrase and restructure the input completely.
2.  **Completeness/Depth:** The post must fully answer the user's intent. **Expand the topic to reach a minimum length of 1200 words** (unless the topic is extremely simple).
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

// FUNCTION: Generate image alt text
async function generateImageAlt(title, snippet, content) {
  const prompt = `Create a descriptive ALT TEXT for a smartphone product image. Describe what is visible in the picture. Be specific about the product, its features, and any visible details. Keep it under 10 words.

Article about: ${title}

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

// FUNCTION: Generate image title text
async function generateImageTitle(title, snippet, content) {
  const prompt = `Generate a short SEO-friendly TITLE for a smartphone image. Use high-search-volume keywords related to mobile technology. Focus on trending terms and main features. 3-5 words maximum.

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

// FUNCTION: Generate tags
async function generateTags(title, snippet, content) {
  const prompt = `Generate 3-6 SEO-friendly tags for this article. Return as comma-separated keywords only.\nTitle: ${title}\nSnippet: ${snippet}\nContent: ${content}`;

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

// FUNCTION: Create Blogger post
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

// FUNCTION: Check Blogger for existing posts
async function checkBloggerForExistingPosts(title) {
  try {
    log('🔍 Checking Blogger for existing posts...');
    
    const posts = await blogger.posts.list({
      blogId: BLOG_ID,
      maxResults: 20,
      fetchBodies: false
    });
    
    if (posts.data.items) {
      const cleanNewTitle = title.toLowerCase().replace(/[^\w\s]/g, '');
      
      for (const post of posts.data.items) {
        const cleanExistingTitle = post.title.toLowerCase().replace(/[^\w\s]/g, '');
        
        // Check if titles are similar
        if (cleanNewTitle.includes(cleanExistingTitle.substring(0, 20)) || 
            cleanExistingTitle.includes(cleanNewTitle.substring(0, 20))) {
          log(`❌ Similar post found on Blogger: "${post.title}"`);
          return true;
        }
      }
    }
    
    return false;
  } catch (err) {
    log('Blogger check error:', err?.message || err);
    return false;
  }
}

// FUNCTION: Generate content hash
function generateContentHash(content) {
  const crypto = require('crypto');
  return crypto.createHash('md5').update(content).digest('hex');
}

// MAIN PROCESSING FUNCTION
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

      log(`🔍 Checking: "${title}"`);

      // ENHANCED DUPLICATE CHECKING
      if (hasBeenPosted(guid, link, title)) {
        log('❌ Already posted in database:', title);
        continue;
      }

      const bloggerDuplicate = await checkBloggerForExistingPosts(title);
      if (bloggerDuplicate) {
        log('❌ Similar post found on Blogger:', title);
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
        
        // LOGO REPLACEMENT WITH FALLBACK
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
                  <p style="font-style: italic; color: #666; margin-top: 8px; font-size: 14px;">${escapeHtml(altText)}</p>
                </div>\n`;
                log('✅ Logo watermark applied successfully');
              } else {
                throw new Error('Image upload failed');
              }
            } else {
              throw new Error('Logo replacement failed');
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

      log('✅ Posted to Blogger:', posted.url);
      log('🏷️ Tags used:', tags);
      
      // Mark as posted with enhanced tracking
      const contentHash = generateContentHash(fullContent);
      markPosted({ 
        guid, 
        link, 
        title, 
        content_hash: contentHash,
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

// HELPER FUNCTIONS
function sleep(ms) { 
  return new Promise(r => setTimeout(r, ms)); 
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/[&<>"']/g, m => ({ 
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' 
  }[m]));
}

// START APPLICATION
async function start() {
  log('🚀 Starting MobiGadget Auto Poster', { 
    MODE, 
    OPENAI_MODEL, 
    GSMARENA_RSS,
    CUSTOM_LOGO_PATH,
    MAX_IMAGE_WIDTH: '1000px'
  });
  
  // Check dependencies
  if (fs.existsSync(CUSTOM_LOGO_PATH)) {
    log('✅ Custom logo found:', CUSTOM_LOGO_PATH);
  } else {
    log('❌ Custom logo not found:', CUSTOM_LOGO_PATH);
  }
  
  if (MODE === 'once') {
    await processOnce();
    log('🎯 Finished single run. Exiting.');
    process.exit(0);
  } else {
    log('⏰ Scheduling cron:', POST_INTERVA
