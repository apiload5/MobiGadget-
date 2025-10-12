/**
 * MobiGadget Auto Blogger (Internal Smart Image Processing Version)
 * Features:
 * ✅ Uses Internal SmartBackgroundChanger class for image editing (No external API needed).
 * ✅ Adds user's logo (mobiseko) on top of the internally edited image.
 * ✅ Uses Blogger's native API for image upload (100% Thumbnail Fix).
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
// Import new dependencies for the SmartBackgroundChanger class
import sharp from 'sharp';
import { removeBackground } from '@imgly/background-removal-node';
import { fileTypeFromBuffer } from 'file-type';
import cv from '@u4/opencv4nodejs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- SMART BACKGROUND CHANGER CLASS INCLUDED HERE ---
/**
 * 🎨 SMART BACKGROUND CHANGER CLASS
 * NOTE: Included directly in app.js for simpler module usage.
 */
class SmartBackgroundChanger {

  /**
   * 🧠 Process an image end-to-end
   */
  static async process(imageUrl, backgroundColor = 'auto') {
    try {
      console.log(`📥 Downloading image: ${imageUrl}`);

      const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      let imageBuffer = Buffer.from(response.data);

      // 🧩 Step 1: Remove watermarks
      imageBuffer = await this.removeWatermarks(imageBuffer);

      // 🧩 Step 2: Resize to 800px
      imageBuffer = await this.smartResizeTo800px(imageBuffer);

      // 🧩 Step 3: Remove background
      const foregroundBlob = await removeBackground(imageBuffer);
      imageBuffer = Buffer.from(await foregroundBlob.arraybuffer());

      // 🧩 Step 4: Improve quality
      imageBuffer = await this.improveImageQuality(imageBuffer);

      // 🧩 Step 5: Smart background color
      const finalBg = await this.getSmartBackgroundColor(imageBuffer, backgroundColor);

      // 🧩 Step 6: Merge on new background
      const metadata = await sharp(imageBuffer).metadata();
      const bgBuffer = await this.createBackgroundBuffer(metadata.width, metadata.height, finalBg);

      const finalImage = await sharp(bgBuffer)
        .composite([{ input: imageBuffer, blend: 'over' }])
        .jpeg({ quality: 85 })
        .toBuffer();

      console.log('✅ Image processing completed by SmartBackgroundChanger!');
      return {
        success: true,
        buffer: finalImage,
        backgroundColor: finalBg
      };

    } catch (err) {
      console.error('❌ SmartBackgroundChanger failed:', err.message);
      return { success: false, error: err.message };
    }
  }

  // 🔹 Watermark detection & cleaning
  static async removeWatermarks(imageBuffer) {
    try {
      // Check if the buffer is a valid image type before passing to imdecode
      const fileType = await fileTypeFromBuffer(imageBuffer);
      if (!fileType || !fileType.mime.startsWith('image/')) return imageBuffer;

      const image = cv.imdecode(imageBuffer);
      const corners = [
        { x: 0, y: 0, width: 200, height: 100 },
        { x: image.cols - 200, y: 0, width: 200, height: 100 },
        { x: 0, y: image.rows - 100, width: 200, height: 100 },
        { x: image.cols - 200, y: image.rows - 100, width: 200, height: 100 }
      ];

      let modified = false;
      for (const c of corners) {
        // Ensure rect is within image bounds
        if (c.x < 0 || c.y < 0 || c.x + c.width > image.cols || c.y + c.height > image.rows) continue;

        const roi = image.getRegion(new cv.Rect(c.x, c.y, c.width, c.height));
        const gray = roi.cvtColor(cv.COLOR_BGR2GRAY);
        const edges = gray.canny(50, 150);
        const edgeDensity = cv.countNonZero(edges) / (c.width * c.height);

        if (edgeDensity > 0.1) {
          // Use current image type for better results or just clean with white/transparent
          const clean = new cv.Mat(roi.rows, roi.cols, roi.type, [255, 255, 255, 255]);
          clean.copyTo(roi);
          modified = true;
        }
      }

      if (modified) {
        console.log('🧽 Watermark(s) removed');
        return cv.imencode('.jpg', image).getNodeBuffer();
      }
      console.log('ℹ️ No watermark detected/removed');
      return imageBuffer;

    } catch (e) {
      console.log(`⚠️ Watermark detection failed or image decode error: ${e.message}`);
      return imageBuffer;
    }
  }

  // 🔹 Resize logic
  static async smartResizeTo800px(imageBuffer) {
    const meta = await sharp(imageBuffer).metadata();
    if (meta.width <= 800 && meta.height <= 800) return imageBuffer;

    const target = 800;
    const scale = meta.width > meta.height
      ? { width: target, height: Math.round(meta.height / meta.width * target) }
      : { height: target, width: Math.round(meta.width / meta.height * target) };

    return sharp(imageBuffer)
      .resize(scale.width, scale.height, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
  }

  // 🔹 Quality enhancement
  static async improveImageQuality(imageBuffer) {
    return sharp(imageBuffer)
      .normalize()
      .sharpen({ sigma: 0.5 })
      .median(1)
      .jpeg({ quality: 90, progressive: true })
      .toBuffer();
  }

  // 🔹 Smart background color
  static async getSmartBackgroundColor(buffer, userColor) {
    if (userColor !== 'auto') return userColor;

    try {
      const { data, info } = await sharp(buffer)
        .resize(100, 100)
        .raw()
        .toBuffer({ resolveWithObject: true });

      let total = 0;
      for (let i = 0; i < data.length; i += 3) {
        total += (data[i] + data[i + 1] + data[i + 2]) / 3;
      }

      const avg = total / (info.width * info.height);
      return avg > 128 ? '#2C3E50' : '#FFFFFF'; // Dark Gray/White
    } catch {
      return '#FFFFFF';
    }
  }

  // 🔹 Background generation
  static async createBackgroundBuffer(width, height, color) {
    return sharp({
      create: {
        width,
        height,
        channels: 3,
        background: color
      }
    }).jpeg({ quality: 90 }).toBuffer();
  }
}
// --- END OF SMART BACKGROUND CHANGER CLASS ---


// --- ENV VARIABLES ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const BLOG_ID = process.env.BLOG_ID;
// EXTERNAL_EDIT_API removed as it is no longer needed
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
// CHECK: EXTERNAL_EDIT_API removed from checks
if (!OPENAI_API_KEY || !CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !BLOG_ID) {
    console.error('❌ ERROR: Essential environment variables are missing (OpenAI/Blogger).');
    process.exit(1);
}

const parser = new Parser();
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const google = new GoogleApis();
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const blogger = google.blogger({ version: 'v3', auth: oauth2Client }); 

// Database setup unchanged
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


// --- IMAGE PROCESSING LOGIC (Uses Internal Class) ---

/**
 * Executes the internal SmartBackgroundChanger class and returns the final image buffer.
 */
async function getProcessedImageBuffer(imageUrl) {
    try {
        const result = await SmartBackgroundChanger.process(imageUrl);
        if (result.success) {
            log('✅ Image successfully processed by internal class.');
            return result.buffer;
        } else {
            log(`❌ Internal Image Processing failed: ${result.error}`);
            // Fallback: If processing fails, try to return the original image buffer
            try {
                const originalRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
                log('⚠️ Falling back to original image due to internal processing failure.');
                return originalRes.data;
            } catch (e) {
                log('❌ Original image fetch failed too.');
                return null;
            }
        }
    } catch (err) {
        log('❌ Error running SmartBackgroundChanger:', err.message);
        return null;
    }
}

/**
 * Adds the user's logo to the processed image (Buffer).
 */
async function brandProcessedImageBuffer(imageBuffer) {
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


// --- AI FUNCTIONS (Unchanged) ---

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


// --- MAIN PROCESS ---

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
      
      // 2. GET PROCESSED IMAGE FROM INTERNAL CLASS
      const processedImageBuffer = await getProcessedImageBuffer(imageUrl);
      if (!processedImageBuffer) continue;
      
      // 3. ADD USER LOGO TO EDITED IMAGE
      const brandedImageBuffer = await brandProcessedImageBuffer(processedImageBuffer);
      if (!brandedImageBuffer) continue;

      // 4. UPLOAD TO BLOGGER
      const finalImageUrl = await uploadToBlogger(brandedImageBuffer, altText);
      if (!finalImageUrl) continue;

      // 5. Content rewriting
      const rewrittenHtml = await rewriteWithOpenAI({ title, snippet, content: fullContent });

      // Construct final HTML with the Google-hosted URL
      // ✅ FIX: String/Template Literal completed here
      let finalHtml = `<p><img src="${finalImageUrl}" alt="${escapeHtml(
