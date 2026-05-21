const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'writings.json');
const FONTS_DIR = path.join(ROOT, 'fonts');

// Google Fonts URLs for Cairo (Arabic) and Anek Malayalam
// Using jsDelivr CDN for reliable font delivery
const FONTS = {
  cairo: {
    filename: 'Cairo-VariableFont_slnt,wght.ttf',
    urls: [
      'https://cdn.jsdelivr.net/gh/googlefonts/cairo@main/fonts/variable/Cairo%5Bslnt%2Cwght%5D.ttf',
      'https://github.com/googlefonts/cairo/raw/main/fonts/variable/Cairo%5Bslnt%2Cwght%5D.ttf'
    ]
  },
  anekMalayalam: {
    filename: 'AnekMalayalam-VariableFont_wght.ttf',
    urls: [
      'https://cdn.jsdelivr.net/gh/googlefonts/anek-malayalam@main/fonts/variable/AnekMalayalam%5Bwght%5D.ttf',
      'https://github.com/googlefonts/anek-malayalam/raw/main/fonts/variable/AnekMalayalam%5Bwght%5D.ttf'
    ]
  }
};

const PORT = process.env.PORT || 3002;

let puppeteer = null;
let puppeteerPkg = null;
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || null;
try {
  // If a system Chrome/Chromium path is provided, prefer puppeteer-core so we don't download Chromium.
  if (PUPPETEER_EXECUTABLE_PATH) {
    try {
      puppeteer = require('puppeteer-core');
      puppeteerPkg = 'puppeteer-core';
    } catch (e) {
      // fallback to full puppeteer if core isn't installed
      puppeteer = require('puppeteer');
      puppeteerPkg = 'puppeteer';
    }
  } else {
    // No executable path provided — use full puppeteer if available (it will download Chromium on install)
    puppeteer = require('puppeteer');
    puppeteerPkg = 'puppeteer';
  }
} catch (e) {
  console.warn('Puppeteer is not installed. PDF generation endpoint will return an instructive error.');
}

// Try to load PDFKit for lightweight server-side PDF generation fallback
let PDFDocument = null;
try {
  PDFDocument = require('pdfkit');
} catch (e) {
  // pdfkit not installed; we'll report helpful error later if needed
  PDFDocument = null;
}

// Try to locate a system-installed Chrome/Chromium on Windows (common paths)
function detectSystemChrome() {
  const possible = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe'
  ].filter(Boolean);

  for (let p of possible) {
    try {
      if (!p) continue;
      if (fs.existsSync(p)) return p;
    } catch (e) {
      // ignore
    }
  }
  return null;
}
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(FONTS_DIR)) {
  fs.mkdirSync(FONTS_DIR, { recursive: true });
}

function readWritings() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

// Fetch font from Google Fonts and cache it locally with fallback URLs
function fetchAndCacheFont(fontName, callback) {
  const fontInfo = FONTS[fontName];
  if (!fontInfo) {
    return callback(new Error('Font not found'));
  }

  const filePath = path.join(FONTS_DIR, fontInfo.filename);

  // If font already cached, use it
  if (fs.existsSync(filePath)) {
    return callback(null, fs.readFileSync(filePath));
  }

  // Try URLs in order, with fallback
  function tryFetchFromUrl(urlIndex) {
    if (urlIndex >= fontInfo.urls.length) {
      return callback(new Error(`Failed to fetch ${fontName} font from all sources`));
    }

    const url = fontInfo.urls[urlIndex];
    console.log(`Downloading ${fontName} font from URL ${urlIndex + 1}/${fontInfo.urls.length}...`);
    
    https.get(url, function(upstreamRes) {
      if (upstreamRes.statusCode === 302 || upstreamRes.statusCode === 301) {
        // Follow redirect
        return https.get(upstreamRes.headers.location, handleResponse);
      }
      handleResponse(upstreamRes);
    }).on('error', function(err) {
      console.warn(`Failed to fetch from URL ${urlIndex + 1}: ${err.message}`);
      tryFetchFromUrl(urlIndex + 1);
    });

    function handleResponse(res) {
      if (res.statusCode !== 200) {
        console.warn(`Failed to fetch ${fontName} from URL ${urlIndex + 1}: ${res.statusCode}`);
        return tryFetchFromUrl(urlIndex + 1);
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length === 0) {
          console.warn(`Empty response from URL ${urlIndex + 1}`);
          return tryFetchFromUrl(urlIndex + 1);
        }

        try {
          fs.writeFileSync(filePath, buf);
          console.log(`${fontName} font cached successfully (${buf.length} bytes)`);
        } catch (e) {
          console.error(`Failed to cache ${fontName} font:`, e);
        }
        callback(null, buf);
      });
    }
  }

  tryFetchFromUrl(0);
}

function writeWritings(items) {
  const payload = JSON.stringify(items, null, 2);
  fs.writeFileSync(DATA_FILE, payload, 'utf8');
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function sendText(res, statusCode, text, contentType) {
  res.writeHead(statusCode, {
    'Content-Type': contentType || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sanitizeWriting(input) {
  return {
    id: String(input.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    title: String(input.title || '').trim(),
    category: String(input.category || '').trim(),
    bab: String(input.bab || '').trim(),
    content: String(input.content || '').trim(),
    references: Array.isArray(input.references)
      ? input.references.map(ref => String(ref).trim()).filter(Boolean)
      : [],
    createdAt: input.createdAt || new Date().toISOString()
  };
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
}

function sanitizeFilename(name) {
  if (!name) return 'document';
  return name.replace(/[^a-z0-9\-_.() ]/gi, '_').trim();
}

function serveStatic(req, res, filePath, contentType) {
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (err) {
    sendText(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return serveStatic(req, res, path.join(ROOT, 'index.html'), 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/api/writings') {
    return sendJson(res, 200, readWritings());
  }

  if (req.method === 'POST' && url.pathname === '/api/writings') {
    try {
      const body = await readBody(req);
      const payload = body ? JSON.parse(body) : {};
      const writing = sanitizeWriting(payload);

      if (!writing.title || !writing.category || !writing.content) {
        return sendJson(res, 400, { error: 'Title, category, and content are required.' });
      }

      const writings = readWritings();
      writings.unshift(writing);
      writeWritings(writings);
      return sendJson(res, 201, writing);
    } catch (err) {
      return sendJson(res, 400, { error: 'Invalid JSON request body.' });
    }
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/writings/')) {
    const id = decodeURIComponent(url.pathname.replace('/api/writings/', ''));
    const writings = readWritings();
    const filtered = writings.filter(item => item.id !== id);

    if (filtered.length === writings.length) {
      return sendJson(res, 404, { error: 'Writing not found.' });
    }

    writeWritings(filtered);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname.startsWith('/data/')) {
    const rel = decodeURIComponent(url.pathname.replace('/data/', ''));
    const filePath = path.join(DATA_DIR, rel);

    // Serve existing data files
    if (fs.existsSync(filePath)) {
      const contentType = rel.endsWith('.json') ? 'application/json; charset=utf-8' : (rel.endsWith('.ttf') ? 'font/ttf' : 'application/octet-stream');
      return serveStatic(req, res, filePath, contentType);
    }

    return sendText(res, 404, 'Not found');
  }

  if (req.method === 'GET' && url.pathname.startsWith('/fonts/')) {
    const fontName = decodeURIComponent(url.pathname.replace('/fonts/', ''));

    // Check if font request is valid
    if (!FONTS[fontName]) {
      return sendText(res, 404, 'Font not found');
    }

    // Fetch or retrieve cached font
    fetchAndCacheFont(fontName, (err, fontBuffer) => {
      if (err) {
        console.error(`Error fetching ${fontName} font:`, err);
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(`Failed to fetch ${fontName} font: ${err.message}`);
      }

      res.writeHead(200, {
        'Content-Type': 'font/ttf',
        'Cache-Control': 'public, max-age=31536000'
      });
      res.end(fontBuffer);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/index.html') {
    return serveStatic(req, res, path.join(ROOT, 'index.html'), 'text/html; charset=utf-8');
  }

  // PDF generation endpoint: GET /api/writings/:id/pdf
  if (req.method === 'GET' && url.pathname.startsWith('/api/writings/') && url.pathname.endsWith('/pdf')) {
    const id = decodeURIComponent(url.pathname.replace('/api/writings/', '').replace('/pdf', '').replace(/\/+$/, ''));

    // If puppeteer is available, use it; otherwise fall back to pdfkit if present
    if (!puppeteer && !PDFDocument) {
      return sendJson(res, 501, { error: 'PDF generation not available. Install either puppeteer (for Chromium rendering) or pdfkit (lightweight server-side PDF generation).' });
    }

    const writings = readWritings();
    const item = writings.find(w => w.id === id);
    if (!item) return sendJson(res, 404, { error: 'Writing not found.' });

    // Build HTML for PDF rendering
    const host = req.headers.host || `localhost:${PORT}`;
    const origin = `http://${host}`;

    const html = `<!doctype html>
    <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${escapeHtml(item.title)}</title>
      <style>
        @font-face { font-family: 'CairoCustom'; src: url('${origin}/fonts/cairo'); }
        @font-face { font-family: 'AnekMalayalamCustom'; src: url('${origin}/fonts/anekMalayalam'); }
        body { font-family: 'CairoCustom', 'AnekMalayalamCustom', serif; margin: 36px; color: #111; }
        .title { font-size: 28px; font-weight: 700; text-align: center; margin-bottom: 8px; }
        .meta { text-align: center; color: #555; margin-bottom: 18px; }
        .content { font-size: 16px; line-height: 1.8; white-space: pre-wrap; margin-bottom: 20px; }
        .refs { margin-top: 24px; border-top: 1px solid #ddd; padding-top: 12px; font-size: 13px; color: #333; }
        .ref { margin-bottom: 6px; }
        /* Ensure RTL behavior for Arabic text blocks */
        .arabic { direction: rtl; unicode-bidi: embed; }
      </style>
    </head>
    <body>
      <div class="title">${escapeHtml(item.title)}</div>
      <div class="meta">${escapeHtml(item.bab || '')} &nbsp; ${escapeHtml(item.category || '')} &nbsp; ${new Date(item.createdAt).toLocaleDateString()}</div>
      <div class="content arabic">${escapeHtml(item.content)}</div>
      ${item.references && item.references.length ? '<div class="refs"><strong>References:</strong>' + item.references.map(r => '<div class="ref">' + escapeHtml(r) + '</div>').join('') + '</div>' : ''}
    </body>
    </html>`;

    try {
      if (puppeteer) {
        (async () => {
          const launchOpts = { args: ['--no-sandbox', '--disable-setuid-sandbox'] };
          if (PUPPETEER_EXECUTABLE_PATH) launchOpts.executablePath = PUPPETEER_EXECUTABLE_PATH;

          const browser = await puppeteer.launch(launchOpts);
          const page = await browser.newPage();
          await page.setContent(html, { waitUntil: 'networkidle0' });
          const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20mm', bottom: '20mm', left: '16mm', right: '16mm' } });
          await browser.close();

          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${sanitizeFilename(item.title)}.pdf"`,
            'Content-Length': pdfBuffer.length
          });
          res.end(pdfBuffer);
        })();
      } else {
        // Use PDFKit fallback
        const doc = new PDFDocument({ size: 'A4', margin: 40 });
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${sanitizeFilename(item.title)}.pdf"`
        });
        doc.pipe(res);

        // Register fonts if available in fonts dir
        try {
          const cairoPath = path.join(FONTS_DIR, FONTS.cairo.filename);
          const anekPath = path.join(FONTS_DIR, FONTS.anekMalayalam.filename);
          if (fs.existsSync(cairoPath)) doc.registerFont('Cairo', cairoPath);
          if (fs.existsSync(anekPath)) doc.registerFont('AnekMalayalam', anekPath);
        } catch (e) {
          // ignore font registration errors
        }

        const titleFont = fs.existsSync(path.join(FONTS_DIR, FONTS.cairo.filename)) ? 'Cairo' : 'Helvetica-Bold';
        const bodyFont = fs.existsSync(path.join(FONTS_DIR, FONTS.anekMalayalam.filename)) ? 'AnekMalayalam' : 'Times-Roman';

        doc.font(titleFont).fontSize(20).text(item.title, { align: 'center' });
        doc.moveDown(0.2);
        doc.fontSize(10).fillColor('gray').text(`${item.bab || ''} • ${item.category || ''} • ${new Date(item.createdAt).toLocaleDateString()}`, { align: 'center' });
        doc.moveDown(0.8);

        doc.font(bodyFont).fontSize(12).fillColor('black');
        // Preserve paragraphs
        const paragraphs = String(item.content || '').split(/\n{2,}/g);
        paragraphs.forEach(p => {
          doc.text(p.trim(), { align: 'justify' });
          doc.moveDown(0.5);
        });

        if (item.references && item.references.length) {
          doc.moveDown(0.6);
          doc.fontSize(11).font('Helvetica-Bold').text('References', { underline: true });
          doc.moveDown(0.2);
          doc.font('Helvetica').fontSize(10);
          item.references.forEach(r => {
            doc.fillColor('blue').text(r, { link: r });
            doc.moveDown(0.1);
          });
        }

        doc.end();
      }
    } catch (err) {
      console.error('PDF generation error:', err);
      return sendJson(res, 500, { error: 'Failed to generate PDF.' });
    }

    return;
  }

  sendText(res, 404, 'Not found');
});

server.listen(PORT, () => {
  console.log(`DHIUFIQH server running on http://localhost:${PORT}`);
});
