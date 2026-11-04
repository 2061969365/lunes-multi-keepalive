const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');
const net = require('net');
const os = require('os');

chromium.use(stealth);

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const SERVER_URL = process.env.LUNES_SERVER_URL;
const LOGIN_URL = process.env.LUNES_LOGIN_URL || 'https://betadash.lunes.host/login';
const HTTP_PROXY = process.env.LUNES_PROXY || process.env.HTTP_PROXY;

const DEBUG_PORT = 9222;
const PHOTO_DIR = path.join(process.cwd(), 'screenshots');
const DEFAULT_PROXY = 'socks5://127.0.0.1:40000';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseProxy(proxyStr) {
    if (!proxyStr) return null;
    try {
        const url = new URL(proxyStr);
        return {
            server: proxyStr,
            hostname: url.hostname,
            port: url.port,
            username: url.username ? decodeURIComponent(url.username) : undefined,
            password: url.password ? decodeURIComponent(url.password) : undefined
        };
    } catch (e) {
        console.error('[代理] 无效的代理地址:', proxyStr);
        return null;
    }
}

async function isPortOpen(host, port, timeout = 1500) {
    return new Promise(resolve => {
        const socket = net.connect({ host, port: Number(port) });
        const done = value => {
            socket.destroy();
            resolve(value);
        };
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
        socket.setTimeout(timeout, () => done(false));
    });
}

let PROXY_CONFIG = parseProxy(HTTP_PROXY || DEFAULT_PROXY);

async function resolveProxy() {
    if (!PROXY_CONFIG) return null;
    const ok = await isPortOpen(PROXY_CONFIG.hostname, PROXY_CONFIG.port);
    if (!ok) {
        console.warn(`[代理] ${PROXY_CONFIG.server} 不可用，改为直连`);
        return null;
    }
    return PROXY_CONFIG;
}

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

// Turnstile 控件在 closed shadow DOM 里，Playwright 无法直接定位，
// 这里劫持 attachShadow 拿到 shadow root，并实时计算复选框位置。
const TURNSTILE_HOOK = `
(function() {
    if (window.self === window.top) return;
    const roots = [];
    window.__lunesTurnstileRoots = roots;
    function describe(root) {
        const checkbox = root.querySelector('input[type="checkbox"]');
        if (!checkbox) return null;
        const rect = checkbox.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        if (window.innerWidth <= 0 || window.innerHeight <= 0) return null;
        return {
            xRatio: (rect.left + rect.width / 2) / window.innerWidth,
            yRatio: (rect.top + rect.height / 2) / window.innerHeight,
            checked: checkbox.checked
        };
    }
    window.__lunesFindTurnstile = function() {
        for (const root of roots) {
            const data = describe(root);
            if (data) return data;
        }
        return null;
    };
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                roots.push(shadowRoot);
                describe(shadowRoot);
                const observer = new MutationObserver(() => describe(shadowRoot));
                observer.observe(shadowRoot, { childList: true, subtree: true, attributes: true });
                setTimeout(() => observer.disconnect(), 120000);
            }
            return shadowRoot;
        };
    } catch (e) { }
})();
`;

function chromeBinary() {
    const candidates = [
        process.env.CHROME_PATH,
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch (e) { }
    }
    return null;
}

function checkPort(port) {
    return new Promise(resolve => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, res => {
            res.resume();
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(2000, () => {
            req.destroy();
            resolve(false);
        });
    });
}

async function launchChrome(proxy) {
    const binary = chromeBinary();
    if (!binary) throw new Error('找不到 Chrome，请确认已安装 google-chrome/chromium');

    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启');
        return;
    }

    console.log('正在启动 Chrome...');
    console.log('Chrome 路径:', binary);
    if (proxy) console.log('Chrome 代理:', proxy.server);
    else console.log('Chrome 代理: 直连');

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunes-chrome-'));
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--remote-debugging-address=127.0.0.1',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,960',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--user-data-dir=${userDataDir}`,
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-sync',
        '--metrics-recording-only',
        '--mute-audio',
        '--hide-scrollbars',
        '--lang=en-US',
        '--disable-blink-features=AutomationControlled'
    ];
    if (proxy) {
        args.push(`--proxy-server=${proxy.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }

    let stderr = '';
    const chrome = spawn(binary, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    chrome.stderr.on('data', chunk => {
        stderr += chunk.toString();
        if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    chrome.on('error', err => {
        stderr += `\nspawn error: ${err.message}`;
    });
    chrome.unref();

    console.log('等待 Chrome 初始化...');
    for (let i = 0; i < 60; i++) {
        if (await checkPort(DEBUG_PORT)) {
            console.log('Chrome 启动成功');
            return;
        }
        await sleep(1000);
    }

    console.error('Chrome 启动失败，stderr:');
    console.error(stderr.slice(-5000) || '(空)');
    throw new Error('Chrome launch failed');
}

function safeFileName(email) {
    return email.replace(/[^a-z0-9]/gi, '_');
}

async function getTurnstileToken(page) {
    const apiToken = await page.evaluate(() => {
        try {
            return window.turnstile && window.turnstile.getResponse ? window.turnstile.getResponse() : '';
        } catch (e) {
            return '';
        }
    }).catch(() => '');
    if (apiToken) return apiToken;

    const input = page.locator('input[name="cf-turnstile-response"]').first();
    if (await input.count().catch(() => 0)) {
        const value = await input.inputValue({ timeout: 1000 }).catch(() => '');
        if (value) return value;
    }
    return null;
}

async function waitForTurnstileToken(page, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const token = await getTurnstileToken(page);
        if (token) return token;
        await sleep(500);
    }
    return null;
}

async function findTurnstileWidget(page) {
    for (const frame of page.frames()) {
        if (!frame.url().includes('challenges.cloudflare.com')) continue;
        const data = await frame.evaluate(() => {
            try {
                return window.__lunesFindTurnstile ? window.__lunesFindTurnstile() : null;
            } catch (e) {
                return null;
            }
        }).catch(() => null);
        if (data) return { frame, data };
    }
    return null;
}

async function clickTurnstileWidget(page, client, target) {
    const iframe = await target.frame.frameElement();
    if (!iframe) return false;
    await iframe.scrollIntoViewIfNeeded().catch(() => { });
    await sleep(600);

    const box = await iframe.boundingBox();
    if (!box) return false;

    const data = await target.frame.evaluate(() => {
        try {
            return window.__lunesFindTurnstile ? window.__lunesFindTurnstile() : null;
        } catch (e) {
            return null;
        }
    }).catch(() => null) || target.data;

    const x = box.x + box.width * data.xRatio + (Math.random() * 4 - 2);
    const y = box.y + box.height * data.yRatio + (Math.random() * 2 - 1);
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    for (let step = 1; step <= 12; step++) {
        await client.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: startX + (x - startX) * step / 12,
            y: startY + (y - startY) * step / 12,
            button: 'none',
            buttons: 0
        });
        await sleep(20 + Math.random() * 30);
    }
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await sleep(100 + Math.random() * 100);
    await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        buttons: 1,
        clickCount: 1
    });
    await sleep(80 + Math.random() * 60);
    await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        buttons: 0,
        clickCount: 1
    });
    return true;
}

async function solveTurnstile(page) {
    let token = await getTurnstileToken(page);
    if (token) {
        console.log('   >> Turnstile 已有 token');
        return token;
    }

    const client = await page.context().newCDPSession(page);
    try {
        // Turnstile 脚本加载较慢，先最多等 30 秒让复选框出现
        let target = null;
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            token = await getTurnstileToken(page);
            if (token) {
                console.log(`   >> Turnstile 验证通过 (token 长度 ${token.length})`);
                return token;
            }
            target = await findTurnstileWidget(page);
            if (target) break;
            await sleep(1000);
        }

        if (!target) {
            console.log('   >> 30 秒内未出现 Turnstile 复选框');
            console.log('   >> 当前 frames:', page.frames().map(f => f.url().slice(0, 120)).join(' | '));
            token = await waitForTurnstileToken(page, 5000);
            if (token) console.log(`   >> Turnstile 验证通过 (token 长度 ${token.length})`);
            return token;
        }

        for (let attempt = 1; attempt <= 2; attempt++) {
            console.log(`   >> 第 ${attempt} 次点击 Turnstile 复选框...`);
            if (await clickTurnstileWidget(page, client, target)) {
                token = await waitForTurnstileToken(page, 20000);
                if (token) {
                    console.log(`   >> Turnstile 验证通过 (token 长度 ${token.length})`);
                    return token;
                }
            }

            target = await findTurnstileWidget(page);
            if (!target) {
                token = await waitForTurnstileToken(page, 5000);
                if (token) {
                    console.log(`   >> Turnstile 验证通过 (token 长度 ${token.length})`);
                    return token;
                }
                break;
            }
            await sleep(2000 + Math.random() * 1000);
        }
    } finally {
        await client.detach().catch(() => { });
    }
    return null;
}

async function loginOnce(page, user, label) {
    console.log(`[${label}] 打开登录页...`);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);

    const emailVisible = await page.locator('input[type="email"]').isVisible().catch(() => false);
    if (!emailVisible && !page.url().includes('/login')) {
        console.log(`[${label}] 检测到已登录`);
        return { success: true, alreadyLoggedIn: true };
    }

    console.log(`[${label}] 填充表单...`);
    const emailInput = page.locator('input[type="email"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 20000 });
    await emailInput.fill(user.username);
    await page.locator('input[type="password"]').first().fill(user.password);
    await page.waitForTimeout(500);

    console.log(`[${label}] 检测 Turnstile...`);
    const token = await solveTurnstile(page);
    if (!token) {
        return { success: false, retryable: true, error: 'Turnstile not solved' };
    }

    const submitButton = page.locator('button[type="submit"]').first();
    await submitButton.waitFor({ state: 'visible', timeout: 15000 });

    const [response] = await Promise.all([
        page.waitForResponse(r => r.url().includes('/login') && r.request().method() === 'POST', { timeout: 60000 }).catch(() => null),
        submitButton.click()
    ]);
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => { });
    await page.waitForTimeout(2500);

    const status = response ? response.status() : null;
    const location = response ? (response.headers()['location'] || '') : '';
    if (status) console.log(`[${label}] 登录响应: ${status}${location ? ' -> ' + location : ''}`);

    const url = page.url();
    const stillEmail = await page.locator('input[type="email"]').isVisible().catch(() => false);
    const bodyText = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 1500);
    const flash = (await page.locator('.flash-message').allInnerTexts().catch(() => [])).join(' ').trim();

    if (!stillEmail && !url.includes('/login')) {
        return { success: true, status, location };
    }

    console.log(`[${label}] 登录失败，页面文本: ${bodyText.slice(0, 300) || '(空)'}`);
    if (flash) console.log(`[${label}] 提示信息: ${flash}`);

    const messageMatch = bodyText.match(/(Incorrect information[^.]*\.|Complete the login verification[^.]*\.|Invalid[^.]*\.)/i);
    const message = (flash || (messageMatch ? messageMatch[1] : '')).trim();
    const combined = message.toLowerCase();
    const badCredentials = combined.includes('incorrect')
        || combined.includes('invalid')
        || combined.includes('ensure you have an account');
    const retryable = !badCredentials && (status === 400
        || combined.includes('complete the login verification')
        || combined.includes('verification')
        || location.includes('/login')
        || combined.includes('turnstile'));

    return {
        success: false,
        retryable,
        error: message || bodyText.slice(0, 120) || `Login failed (HTTP ${status})`,
        status,
        location
    };
}

async function processAccount(context, user) {
    const label = safeFileName(user.username);
    const ssPath = path.join(PHOTO_DIR, `${label}.png`);
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    await page.addInitScript(TURNSTILE_HOOK);

    try {
        console.log(`\n=== 处理账号: ${user.username} ===`);

        let loginResult = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            loginResult = await loginOnce(page, user, label);
            if (loginResult.success) break;
            console.log(`[${label}] 第 ${attempt} 次登录失败: ${loginResult.error}`);
            if (!loginResult.retryable) break;
            await page.waitForTimeout(2000);
        }

        if (!loginResult.success) {
            try { await page.screenshot({ path: ssPath, fullPage: false, timeout: 15000 }); } catch (e) { }
            return { success: false, screenshot: ssPath, user: user.username, error: loginResult.error };
        }

        console.log(`[${label}] 登录成功！跳转至保活面板: ${SERVER_URL}`);
        await page.goto(SERVER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(15000);

        try { await page.screenshot({ path: ssPath, fullPage: true, timeout: 30000 }); } catch (e) {
            try { await page.screenshot({ path: ssPath, fullPage: false, timeout: 15000 }); } catch (e2) { }
        }
        console.log(`[${label}] 截图已保存`);

        const sessionLost = page.url().includes('login')
            || await page.locator('input[type="email"]').isVisible().catch(() => false);
        if (sessionLost) {
            console.log(`[${label}] 跳转后会话丢失`);
            return { success: false, screenshot: ssPath, user: user.username, error: 'Session lost after redirect' };
        }

        console.log(`[${label}] 保活成功 ✅`);
        return { success: true, screenshot: ssPath, user: user.username };
    } catch (err) {
        console.error(`[${label}] 异常:`, err.message);
        try { await page.screenshot({ path: ssPath, fullPage: false, timeout: 15000 }); } catch (e) { }
        return { success: false, screenshot: ssPath, user: user.username, error: err.message };
    } finally {
        await context.clearCookies().catch(() => { });
        await page.close().catch(() => { });
        console.log(`[${label}] Cookies 已清除`);
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

    PROXY_CONFIG = await resolveProxy();
    await launchChrome(PROXY_CONFIG);

    console.log('正在连接 Chrome...');
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
            console.log('连接成功');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1}/5 失败，2秒后重试...`);
            await sleep(2000);
        }
    }
    if (!browser) {
        console.error('无法连接 Chrome');
        process.exit(1);
    }

    const context = browser.contexts()[0];
    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        console.log('[代理] 正在设置代理认证...');
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        }).catch(() => { });
    } else {
        await context.setHTTPCredentials(null).catch(() => { });
    }

    const results = [];
    for (const user of users) {
        const result = await processAccount(context, user);
        results.push(result);
    }

    const successCount = results.filter(r => r.success).length;
    let msg = `*Lunes Host 多账号打卡报告*\n`;
    msg += `成功: ${successCount}/${users.length}\n\n`;
    for (const r of results) {
        msg += `${r.success ? '✅' : '❌'} \`${r.user}\`\n`;
    }
    await sendTelegramMessage(msg);

    for (const r of results) {
        if (!r.success && r.screenshot && fs.existsSync(r.screenshot)) {
            await sendTelegramMessage(
                `❌ *失败详情*\n账号: \`${r.user}\`\n原因: ${r.error || '未知'}`,
                r.screenshot
            );
        }
    }

    console.log('\n全部账号处理完成');
    await browser.close().catch(() => { });
    process.exit(successCount === users.length ? 0 : 1);
})().catch(async err => {
    console.error('脚本异常:', err && err.stack ? err.stack : err);
    await sendTelegramMessage(`❌ *Lunes KeepAlive 脚本异常*\n${String(err && err.message ? err.message : err).slice(0, 500)}`);
    process.exit(1);
});
