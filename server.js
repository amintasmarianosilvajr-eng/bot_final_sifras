// FLUXO ALFA ENGINE v8.6.3 GOLD - CERTIFIED
const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const VOLUME_PATH = '/app/data';
const DATA_FILE = fs.existsSync(VOLUME_PATH) ? path.join(VOLUME_PATH, 'database.json') : './database.json';

const app = express();
app.use(express.json());
app.use(cors());

let globalLogs = [];
let globalPingCount = 0;

process.on('uncaughtException', (err) => {
    console.error('FATAL CRASH:', err);
    try {
        const time = new Date().toLocaleTimeString('pt-BR');
        fs.appendFileSync('crash.log', `[${time}] ${err.stack}\n`);
    } catch(e) {}
});

app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    next();
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/operacional', (req, res) => res.sendFile(path.join(__dirname, 'operacional_v863.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.static(__dirname));

let clients = [];
const VIRGIN_TEMPLATE = {
    username: '', password: '', clientName: '', isApproved: false, apiKey: '', apiSecret: '',
    buyPercentage: 1.0, operationsCount: 0, totalProfit: 0, currentAsset: null, buyPrice: 0,
    status: 'IDLE', tradeHistory: [], tradedCoins: [], lastTradeTime: 0, cycleCount: 0,
    nextAllowedTradeTime: 0, profitTarget: 0.8
};

function saveDatabase() {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(clients, null, 2)); } catch (e) {}
}

function loadDatabase() {
    if (fs.existsSync(DATA_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(DATA_FILE));
            clients = data.map(saved => ({ ...JSON.parse(JSON.stringify(VIRGIN_TEMPLATE)), ...saved }));
            clients.forEach(c => {
                if (c.status === 'IN_TRADE' && c.currentAsset) monitorTrade(c, c.currentAsset);
            });
        } catch (e) { clients = []; }
    } else {
        clients.push({ ...VIRGIN_TEMPLATE, id: 1, username: 'admin', password: 'vega2026', clientName: 'Master Admin', isApproved: true });
        saveDatabase();
    }
}
loadDatabase();

let globalMarket = { top20: [], coinJumps: {}, maxJump: 0, exchangeInfo: null, lastExchangeFetch: 0, priceHistory: {}, lastCycleStartTime: 0, countdownRemaining: 20 };

const BLACKLIST = ['PEPE','SHIB','FLOKI','DOGE','BONK','WIF','MEME','SANTOS','PORTO','LAZIO','PSG','BAR','PSG','CITY','JUV','ACM','ATM','ASR','USDC','FDUSD','TUSD'];

async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 8000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(resource, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
}

function addServerLog(clientId, msg, type = 'info') {
    const time = new Date().toLocaleTimeString('pt-BR');
    const client = clientId ? clients.find(c => c.id === clientId) : null;
    const prefix = client ? client.clientName.toUpperCase() : 'SISTEMA';
    const logItem = { timestamp: time, msg: `${prefix} / ${msg}`, type };
    if (client) {
        if (!client.logs) client.logs = [];
        client.logs.unshift(logItem);
        if (client.logs.length > 50) client.logs.pop();
    }
    globalLogs.unshift(logItem);
    if (globalLogs.length > 100) globalLogs.pop();
}

async function binanceRequest(client, endpoint, method = 'GET', params = {}) {
    try {
        const timeRes = await fetch('https://api.binance.com/api/v3/time');
        const { serverTime } = await timeRes.json();
        let queryString = `timestamp=${serverTime}&recvWindow=60000`;
        Object.keys(params).forEach(key => queryString += `&${key}=${params[key]}`);
        const signature = crypto.createHmac('sha256', client.apiSecret).update(queryString).digest('hex');
        const res = await fetchWithTimeout(`https://api.binance.com${endpoint}?${queryString}&signature=${signature}`, {
            method, headers: { 'X-MBX-APIKEY': client.apiKey }
        });
        return await res.json();
    } catch (e) { return { error: true, msg: e.message }; }
}

setInterval(async () => {
    try {
        const now = Date.now();
        if (!globalMarket.exchangeInfo || now - globalMarket.lastExchangeFetch > 1800000) {
            const ex = await fetch('https://api.binance.com/api/v3/exchangeInfo');
            globalMarket.exchangeInfo = await ex.json();
            globalMarket.lastExchangeFetch = now;
        }
        const res = await fetch('https://api.binance.com/api/v3/ticker/24hr');
        const data = await res.json();
        
        globalMarket.top20 = data.filter(i => i.symbol.endsWith('USDT') && !BLACKLIST.includes(i.symbol.replace('USDT','')))
            .map(i => ({ symbol: i.symbol, price: parseFloat(i.lastPrice), vol: parseFloat(i.priceChangePercent), quoteVol: parseFloat(i.quoteVolume) }))
            .sort((a, b) => b.vol - a.vol).slice(0, 20);

        const hasActiveScanner = clients.some(c => c.status === 'SCANNING');
        if (!hasActiveScanner) {
            globalMarket.lastCycleStartTime = 0;
            globalMarket.countdownRemaining = 20;
        } else {
            if (!globalMarket.lastCycleStartTime) globalMarket.lastCycleStartTime = now;
            const elapsed = now - globalMarket.lastCycleStartTime;
            globalMarket.countdownRemaining = Math.max(0, Math.ceil((20000 - elapsed) / 1000));

            if (elapsed >= 19500) {
                globalMarket.top20.forEach(c => {
                    const start = globalMarket.priceHistory[c.symbol] || c.price;
                    c.lastUpdateJump = ((c.price - start) / start) * 100;
                    globalMarket.priceHistory[c.symbol] = c.price;
                });
                await checkClientsForOpportunity();
                globalMarket.lastCycleStartTime = now;
            }
        }
    } catch (e) {}
}, 2500);

async function checkClientsForOpportunity() {
    const pool = globalMarket.top20.slice(1, 15);
    let bestCoin = null; let maxJump = 0;
    
    pool.forEach(c => {
        if (c.quoteVol >= 1000000 && c.lastUpdateJump > maxJump) {
            maxJump = c.lastUpdateJump; bestCoin = c;
        }
    });

    for (const client of clients) {
        if (client.status !== 'SCANNING' || !client.apiKey) continue;
        
        pool.forEach(c => addServerLog(client.id, `🔍 Scan #2-15: ${c.symbol} | Jump: ${c.lastUpdateJump?.toFixed(3)}% | Vol: $${(c.quoteVol/1000).toFixed(0)}k`, 'info'));

        if (bestCoin && Date.now() > client.nextAllowedTradeTime) {
            addServerLog(client.id, `🚀 Sniper elegeu ${bestCoin.symbol} (+${maxJump.toFixed(3)}%)`, 'buy');
            executeRealBuy(client, bestCoin.symbol, bestCoin.price);
        } else if (!bestCoin) {
            addServerLog(client.id, `📡 Ciclo concluído: Nenhuma moeda atingiu força de disparo.`, 'info');
        }
    }
}

async function executeRealBuy(client, symbol, price) {
    client.status = 'IN_TRADE';
    const acc = await binanceRequest(client, '/api/v3/account');
    const usdt = acc.balances.find(b => b.asset === 'USDT');
    const amount = parseFloat(usdt.free) * client.buyPercentage;
    if (amount < 11) { client.status = 'SCANNING'; return; }

    const order = await binanceRequest(client, '/api/v3/order', 'POST', { symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: amount.toFixed(8) });
    if (order.error) { client.status = 'SCANNING'; return; }

    client.buyPrice = price;
    if (order.fills) {
        const cost = order.fills.reduce((s,f) => s + (f.price * f.qty), 0);
        const qty = order.fills.reduce((s,f) => s + parseFloat(f.qty), 0);
        client.buyPrice = cost / qty;
    }
    client.currentAsset = symbol;
    client.targetPrice = client.buyPrice * (1 + (client.profitTarget + 0.2)/100);
    addServerLog(client.id, `✅ COMPRA: ${symbol} @ $${client.buyPrice.toFixed(8)} | Alvo: $${client.targetPrice.toFixed(8)}`, 'buy');
    monitorTrade(client, symbol);
}

async function monitorTrade(client, symbol) {
    const inter = setInterval(async () => {
        if (client.status !== 'IN_TRADE') return clearInterval(inter);
        const t = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`).then(r => r.json());
        const curr = parseFloat(t.price); client.currentPrice = curr;
        if (curr >= client.targetPrice) { clearInterval(inter); executeRealSell(client, symbol); }
    }, 5000);
}

async function executeRealSell(client, symbol) {
    const acc = await binanceRequest(client, '/api/v3/account');
    const asset = symbol.replace('USDT','');
    const bal = acc.balances.find(b => b.asset === asset);
    
    const ex = globalMarket.exchangeInfo.symbols.find(s => s.symbol === symbol);
    const step = ex.filters.find(f => f.filterType === 'LOT_SIZE').stepSize;
    const prec = step.indexOf('1') - 1;
    const qty = (Math.floor(parseFloat(bal.free) * Math.pow(10, prec)) / Math.pow(10, prec)).toFixed(prec);

    const order = await binanceRequest(client, '/api/v3/order', 'POST', { symbol, side: 'SELL', type: 'MARKET', quantity: qty });
    const sellPrice = order.fills ? (order.fills.reduce((s,f)=>s+(f.price*f.qty),0)/order.fills.reduce((s,f)=>s+parseFloat(f.qty),0)) : client.targetPrice;
    
    const profit = ((sellPrice - client.buyPrice) / client.buyPrice) * 100;
    client.totalProfit += profit; client.operationsCount++;
    addServerLog(client.id, `💰 VENDA: ${symbol} | Lucro Líquido: ${(profit - 0.2).toFixed(3)}%`, 'sell');
    
    client.status = 'STOPPED'; client.currentAsset = null;
    client.nextAllowedTradeTime = Date.now() + (client.operationsCount % 3 === 0 ? 15*60*1000 : 2*60*1000);
    setTimeout(() => { client.status = 'SCANNING'; saveDatabase(); }, client.nextAllowedTradeTime - Date.now());
    saveDatabase();
}

app.get('/status', (req, res) => {
    const cid = parseInt(req.query.clientId) || 1;
    const c = clients.find(x => x.id === cid) || clients[0];
    res.json({ ...c, allStats: clients.map(x => ({ ...x, apiKey: '***', apiSecret: '***' })), top20: globalMarket.top20, countdownRemaining: globalMarket.countdownRemaining });
});

app.post('/api/login', (req, res) => {
    const { user, pass } = req.body;
    if (user === 'mestre@gmail.com' && pass === 'vega2026') return res.json({ ok:true, clientId:1, redirect:'/operacional' });
    const c = clients.find(x => x.username === user && x.password === pass);
    if (!c) return res.json({ ok:false, msg:'Erro' });
    res.json({ ok:true, clientId:c.id, redirect:'/operacional' });
});

app.post('/start', (req, res) => {
    const c = clients.find(x => x.id === req.body.clientId);
    c.apiKey = req.body.apiKey; c.apiSecret = req.body.apiSecret;
    c.status = 'SCANNING'; saveDatabase(); res.json({ ok:true });
});

app.listen(process.env.PORT || 3000, () => console.log('SERVER ONLINE'));
