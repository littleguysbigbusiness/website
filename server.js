const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve index.html from either path
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
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;

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
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
    console.log('Headless Interactive Chrome initialized.');
}

// Function to safely capture a screenshot frame
async function captureFrame(res) {
    try {
        const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 70 });
        res.json({ screenshot: `data:image/jpeg;base64,${screenshot}`, currentUrl: page.url() });
    } catch (error) {
        res.status(500).json({ error: 'Failed to capture frame: ' + error.message });
    }
}

// Navigation endpoint
app.post('/navigate', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL missing' });

    try {
        let targetUrl = url.trim();
        if (!/^https?:\/\//i.test(targetUrl)) {
            targetUrl = 'https://' + targetUrl;
        }
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 45000 });
        await captureFrame(res);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Click forwarding endpoint
app.post('/click', async (req, res) => {
    const { x, y } = req.body;
    if (x === undefined || y === undefined) return res.status(400).json({ error: 'Coordinates missing' });

    try {
        // Perform virtual mouse click on the remote page
        await page.mouse.click(x, y);
        
        // Wait briefly for animations or page routing changes to trigger
        await page.waitForTimeout ? await page.waitForTimeout(1000) : await new Promise(r => setTimeout(r, 1000));
        
        await captureFrame(res);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => res.status(200).send('OK'));

initBrowser().then(() => {
    app.listen(PORT, () => console.log(`Interactive cloud browser running on port ${PORT}`));
}).catch(err => {
    console.error('Failed to launch browser:', err);
    process.exit(1);
});
