const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve index.html from either 'public/index.html' or the main directory
app.get('/', (req, res) => {
    const publicPath = path.join(__dirname, 'public', 'index.html');
    const rootPath = path.join(__dirname, 'index.html');
    
    if (fs.existsSync(publicPath)) {
        res.sendFile(publicPath);
    } else if (fs.existsSync(rootPath)) {
        res.sendFile(rootPath);
    } else {
        res.status(404).send('Error: index.html not found in root or public folder.');
    }
});

// Serve other static assets if a public folder exists
app.use(express.static(path.join(__dirname, 'public')));

let browser;
let page;

// Initialise the headless browser with cloud-safe flags
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
    await page.setViewport({ width: 1280, height: 720 });
    console.log('Headless Chrome initialized successfully.');
}

// Target navigation and screenshot streaming endpoint
app.post('/navigate', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL parameter is missing' });

    try {
        let targetUrl = url.trim();
        if (!/^https?:\/\//i.test(targetUrl)) {
            targetUrl = 'https://' + targetUrl;
        }

        // Navigate and wait until the network traffic settles down
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Capture page viewport as a base64 image string
        const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 75 });
        
        res.json({ screenshot: `data:image/jpeg;base64,${screenshot}` });
    } catch (error) {
        console.error('Navigation error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Render health check route
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Boot the application
initBrowser().then(() => {
    app.listen(PORT, () => console.log(`Cloud browser running on port ${PORT}`));
}).catch(err => {
    console.error('Failed to launch browser:', err);
    process.exit(1);
});
