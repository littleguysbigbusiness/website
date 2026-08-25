const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

// Inject the stealth protection layer
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
    const publicPath = path.join(__dirname, 'public', 'index.html');
    const rootPath = path.join(__dirname, 'index.html');
    
    if (fs.existsSync(publicPath)) {
        res.sendFile(publicPath);
    } else if (fs.existsSync(rootPath)) {
        res.sendFile(rootPath);
    } else {
        res.status(404).send('Error: index.html not found.');
    }
});

app.use(express.static(path.join(__dirname, 'public')));

let browser;
let page;

async function initBrowser() {
    browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage', 
            '--disable-gpu'
        ]
    });
    page = await browser.newPage();
    
    // Mask your server's fingerprint as a standard Windows computer
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 720 });
    console.log('Headless Stealth Chrome initialized successfully.');
}

app.post('/navigate', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL parameter is missing' });

    try {
        let targetUrl = url.trim();
        if (!/^https?:\/\//i.test(targetUrl)) {
            targetUrl = 'https://' + targetUrl;
        }

        // Navigate with a natural desktop timeout metric
        await page.goto(targetUrl, { 
            waitUntil: 'networkidle2', 
            timeout: 45000 
        });
        
        const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 70 });
        res.json({ screenshot: `data:image/jpeg;base64,${screenshot}` });
    } catch (error) {
        console.error('Navigation error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => res.status(200).send('OK'));

initBrowser().then(() => {
    app.listen(PORT, () => console.log(`Cloud browser running on port ${PORT}`));
}).catch(err => {
    console.error('Failed to launch browser:', err);
    process.exit(1);
});
