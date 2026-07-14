const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

chromium.use(stealth);

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const SERVER_URL = process.env.LUNES_SERVER_URL;
const HTTP_PROXY = process.env.HTTP_PROXY;

const DEBUG_PORT = 9222;
const PHOTO_DIR = path.join(process.cwd(), 'screenshots');
const DEFAULT_PROXY = 'socks5://127.0.0.1:40000';

function parseProxy(proxyStr) {
    if (!proxyStr) return null;
    try {
        const url = new URL(proxyStr);
        const isSocks = proxyStr.startsWith('socks');
        return {
            server: proxyStr,
            hostname: url.hostname,
            port: url.port,
            username: url.username ? decodeURIComponent(url.username) : undefined,
            password: url.password ? decodeURIComponent(url.password) : undefined,
            isSocks
        };
    } catch (e) {
        console.error('[代理] 无效的代理地址:', proxyStr);
        return null;
    }
}

const PROXY_CONFIG = parseProxy(HTTP_PROXY || DEFAULT_PROXY);

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        await axios.post(url, { chat_id: TG_CHAT_ID, text: message, parse_mode: 'Markdown' });
        console.log('[Telegram] 消息已发送');
    } catch (e) {
        console.error('[Telegram] 消息发送失败:', e.message);
    }
    if (imagePath && fs.existsSync(imagePath)) {
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        await new Promise(resolve => {
            exec(cmd, err => {
                if (err) console.error('[Telegram] 截图发送失败:', err.message);
                else console.log('[Telegram] 截图已发送');
                resolve();
            });
        });
    }
}

const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };
                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) { }
})();
`;

async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                console.log('   >> 在 Frame 中发现 Turnstile, 比例:', data);
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;
                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);
                console.log(`   >> 计算点击坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);
                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1
                });
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1
                });
                console.log('   >> CDP 点击已发送');
                await client.detach();
                return true;
            }
        } catch (e) { }
    }
    return false;
}

function checkPort(port) {
    return new Promise(resolve => {
        const req = http.get(`http://localhost:${port}/json/version`, res => resolve(true));
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启');
        return;
    }
    console.log('正在启动 Chrome...');
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data',
        '--disable-dev-shm-usage'
    ];
    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    const chrome = spawn('/usr/bin/google-chrome', args, { detached: true, stdio: 'ignore' });
    chrome.unref();
    console.log('等待 Chrome 初始化...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }
    if (!await checkPort(DEBUG_PORT)) {
        console.error('Chrome 启动失败');
        throw new Error('Chrome launch failed');
    }
    console.log('Chrome 启动成功');
}

function safeFileName(email) {
    return email.replace(/[^a-z0-9]/gi, '_');
}

async function processAccount(page, user) {
    const label = safeFileName(user.username);
    const ssPath = path.join(PHOTO_DIR, `${label}.png`);

    try {
        console.log(`\n=== 处理账号: ${user.username} ===`);

        // 导航到登录页
        await page.goto('https://betadash.lunes.host/login', { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(3000);

        // 如果已登录（被重定向到 dashboard），直接保活
        const onLoginPage = page.url().includes('login') ||
            await page.locator('input[type="email"]').isVisible().catch(() => false);

        if (!onLoginPage) {
            console.log(`[${label}] 检测到已登录，直接跳转至 SERVER_URL...`);
            await page.goto(SERVER_URL, { waitUntil: 'load', timeout: 30000 });
            await page.waitForTimeout(15000);
            try { await page.screenshot({ path: ssPath, fullPage: true }); } catch (e) { }
            const stillLoggedIn = !page.url().includes('login') &&
                !await page.locator('input[type="email"]').isVisible().catch(() => false);
            if (!stillLoggedIn) {
                console.log(`[${label}] 会话已失效`);
                return { success: false, screenshot: ssPath, user: user.username, error: 'Session expired' };
            }
            console.log(`[${label}] 保活成功`);
            return { success: true, screenshot: ssPath, user: user.username };
        }

        // 填充登录表单
        console.log(`[${label}] 填充表单...`);
        const emailInput = page.locator('input[type="email"]');
        await emailInput.waitFor({ state: 'visible', timeout: 15000 });
        await emailInput.fill(user.username);

        const pwdInput = page.locator('input[type="password"]');
        await pwdInput.fill(user.password);
        await page.waitForTimeout(500);

        const rememberMe = page.locator('input[type="checkbox"]');
        if (await rememberMe.isVisible().catch(() => false)) {
            await rememberMe.click();
            console.log(`[${label}] 已勾选记住我`);
        }

        // CDP Turnstile 过盾
        console.log(`[${label}] 检测 Turnstile...`);
        let cdpClicked = false;
        for (let attempt = 0; attempt < 20; attempt++) {
            cdpClicked = await attemptTurnstileCdp(page);
            if (cdpClicked) break;
            await page.waitForTimeout(1000);
        }

        if (cdpClicked) {
            console.log(`[${label}] CDP 点击已发送，等待验证...`);
            for (let w = 0; w < 10; w++) {
                let isSuccess = false;
                for (const f of page.frames()) {
                    if (f.url().includes('cloudflare')) {
                        try {
                            if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) {
                                isSuccess = true; break;
                            }
                        } catch (e) { }
                    }
                }
                if (isSuccess) { console.log(`[${label}] Turnstile 验证通过`); break; }
                await page.waitForTimeout(1000);
            }
        }

        // 点击 Continue
        const continueBtn = page.locator(
            'button:has-text("Continue"), button:has-text("Zaloguj"), button[type="submit"]'
        ).first();
        if (await continueBtn.isVisible().catch(() => false)) {
            await continueBtn.click();
            console.log(`[${label}] 已点击 Continue`);
        }
        await page.waitForTimeout(8000);

        // 验证登录是否成功
        const loginFailed = page.url().includes('login') ||
            await page.locator('input[type="email"]').isVisible().catch(() => false);

        if (loginFailed) {
            console.log(`[${label}] 登录失败`);
            try { await page.screenshot({ path: ssPath, fullPage: true }); } catch (e) { }
            return { success: false, screenshot: ssPath, user: user.username, error: 'Login failed' };
        }

        // 登录成功，跳转至保活面板
        console.log(`[${label}] 登录成功！跳转至: ${SERVER_URL}`);
        await page.goto(SERVER_URL, { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(15000);

        try { await page.screenshot({ path: ssPath, fullPage: true }); } catch (e) { }
        console.log(`[${label}] 截图已保存`);

        // 最终验证：仍在登录状态
        const sessionLost = page.url().includes('login') ||
            await page.locator('input[type="email"]').isVisible().catch(() => false);

        if (sessionLost) {
            console.log(`[${label}] 跳转后会话丢失`);
            return { success: false, screenshot: ssPath, user: user.username, error: 'Session lost after redirect' };
        }

        console.log(`[${label}] 保活成功 ✅`);
        return { success: true, screenshot: ssPath, user: user.username };

    } catch (err) {
        console.error(`[${label}] 异常:`, err.message);
        try { await page.screenshot({ path: ssPath, fullPage: true }); } catch (e) { }
        return { success: false, screenshot: ssPath, user: user.username, error: err.message };
    } finally {
        if (!page.isClosed()) {
            await page.context().clearCookies();
            console.log(`[${label}] Cookies 已清除`);
        }
    }
}

(async () => {
    const users = JSON.parse(process.env.USERS_JSON || '[]');
    if (!users.length) {
        console.error('错误: USERS_JSON 为空');
        process.exit(1);
    }
    if (!SERVER_URL) {
        console.error('错误: 缺少 LUNES_SERVER_URL');
        process.exit(1);
    }

    console.log(`共 ${users.length} 个账号，开始处理`);
    if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true });

    await launchChrome();

    console.log('正在连接 Chrome...');
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('连接成功');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1}/5 失败，2秒后重试...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    if (!browser) {
        console.error('无法连接 Chrome');
        process.exit(1);
    }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        console.log('[代理] 正在设置代理认证...');
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    } else {
        await context.setHTTPCredentials(null);
    }

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加');

    const results = [];
    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        if (page.isClosed()) {
            page = await context.newPage();
            await page.addInitScript(INJECTED_SCRIPT);
        }
        const result = await processAccount(page, user);
        results.push(result);
    }

    // Telegram 汇总通知
    const successCount = results.filter(r => r.success).length;
    let msg = `*Lunes Host 多账号打卡报告*\n`;
    msg += `成功: ${successCount}/${users.length}\n\n`;
    for (const r of results) {
        msg += `${r.success ? '✅' : '❌'} \`${r.user}\`\n`;
    }
    await sendTelegramMessage(msg);

    // 发送失败详情 + 截图
    for (const r of results) {
        if (!r.success && r.screenshot && fs.existsSync(r.screenshot)) {
            await sendTelegramMessage(
                `❌ *失败详情*\n账号: \`${r.user}\`\n原因: ${r.error || '未知'}`,
                r.screenshot
            );
        }
    }

    console.log('\n全部账号处理完成');
    await browser.close();
    process.exit(0);
})();
