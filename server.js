const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let browser;
let page;

// Start the browser when the server starts
async function initBrowser() {
    browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
}

// Endpoint to navigate and capture the screen
app.post('/navigate', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    try {
        // Simple URL validation/formatting
        let targetUrl = url;
        if (!/^https?:\/\//i.test(targetUrl)) {
            targetUrl = 'https://' + targetUrl;
        }

        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        const screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 80 });
        
        res.json({ screenshot: `data:image/jpeg;base64,${screenshot}` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

initBrowser().then(() => {
    app.listen(PORT, () => console.log(`Cloud browser running on http://localhost:${PORT}`));
});
