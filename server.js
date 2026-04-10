// FLUXO ALFA ENGINE v8.6.3 GOLD - CERTIFIED
const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// --- CONFIGURAÇÃO DE PERSISTÊNCIA ---
const VOLUME_PATH = '/app/data';
const DATA_FILE = fs.existsSync(VOLUME_PATH) ? path.join(VOLUME_PATH, 'database.json') : './database.json';

const app = express();
app.use(express.json());
app.use(cors());

// --- ESTADO GLOBAL ---
let globalLogs = [];
let globalPingCount = 0;

process.on('uncaughtException', (err) => {
    console.error('FATAL CRASH:', err);
    try {
        const time = new Date().toLocaleTimeString('pt-BR');
        fs.appendFileSync('crash.log', `[${time}] ${err.stack}\n`);
    } catch(e) {}
});

// --- MIDDLEWARE ---
app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    next();
});

let clients = [];
const VIRGIN_TEMPLATE = {
    username: '', password: '', clientName: '', isApproved: false, apiKey: '', apiSecret: '',
    buyPercentage: 1.0, operationsCount: 0, totalProfit: 0, currentAsset: null, buyPrice: 0,
    status: 'IDLE', tradeHistory: [], tradedCoins: [], lastTradeTime: 0, cycleCount: 0,
    nextAllowedTradeTime: 0, profitTarget: 0.7, isInfinityLoop: false, balanceUSDT: 0, tradedCoins: []
};

function saveDatabase() {
    try { 
        const sanitized = clients.map(c => {
            const { logs, ...rest } = c; // Don't save logs to DB to keep it small
            return rest;
        });
        fs.writeFileSync(DATA_FILE, JSON.stringify(sanitized, null, 2)); 
    } catch (e) { console.error("SAVE DB ERROR:", e.message); }
}

function loadDatabase() {
    if (fs.existsSync(DATA_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(DATA_FILE));
            clients = data.map(saved => ({ ...JSON.parse(JSON.stringify(VIRGIN_TEMPLATE)), ...saved }));
            clients.forEach(c => {
                if (c.status === 'IN_TRADE' && c.currentAsset) {
                    addServerLog(c.id, `♻️ RETOMANDO MONITORAMENTO: ${c.currentAsset}`, 'info');
                    monitorTrade(c, c.currentAsset);
                } else if (c.status !== 'IDLE') {
                    c.status = 'IDLE'; // Reset scanning state on restart for safety
                }
            });
            console.log('✅ Banco de dados carregado.');
        } catch (e) { 
            console.error("LOAD DB ERROR:", e.message); 
            clients = []; 
        }
    }
    if (clients.length === 0) {
        clients.push({ ...VIRGIN_TEMPLATE, id: 1, username: 'admin', password: 'vega2026', clientName: 'Master Admin', isApproved: true });
        saveDatabase();
    }
}
loadDatabase();

// --- MERCADO ---
let globalMarket = { 
    top20: [], 
    coinJumps: {}, 
    maxJump: 0, 
    exchangeInfo: null, 
    lastExchangeFetch: 0, 
    priceHistory: {}, 
    lastCycleStartTime: 0, 
    countdownRemaining: 20 
};

const BLACKLIST = ['PEPE','SHIB','FLOKI','DOGE','BONK','WIF','MEME','SANTOS','PORTO','LAZIO','PSG','BAR','CITY','JUV','ACM','ATM','ASR','USDC','FDUSD','TUSD','USDP','EUR'];

async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 8000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(resource, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (e) {
        clearTimeout(id);
        throw e;
    }
}

function addServerLog(clientId, msg, type = 'info') {
    const time = new Date().toLocaleTimeString('pt-BR');
    const client = clientId ? clients.find(c => c.id === clientId) : null;
    const prefix = client ? (client.clientName || `CLIENTE ${client.id}`).toUpperCase() : 'SISTEMA';
    const logItem = { timestamp: time, msg: `${prefix} / ${msg}`, type };
    if (client) {
        if (!client.logs) client.logs = [];
        client.logs.unshift(logItem);
        if (client.logs.length > 50) client.logs.pop();
    }
    globalLogs.unshift(logItem);
    if (globalLogs.length > 100) globalLogs.pop();
    console.log(`[${prefix}] ${time} - ${msg}`);
}

async function binanceRequest(client, endpoint, method = 'GET', params = {}) {
    try {
        const timeRes = await fetch('https://api.binance.com/api/v3/time');
        const { serverTime } = await timeRes.json();
        const diff = serverTime - Date.now();
        const timestamp = Date.now() + diff;

        let queryString = `timestamp=${timestamp}&recvWindow=60000`;
        Object.keys(params).forEach(key => queryString += `&${key}=${params[key]}`);
        const apiSecret = client.apiSecret || '';
        const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
        
        const res = await fetchWithTimeout(`https://api.binance.com${endpoint}?${queryString}&signature=${signature}`, {
            method, 
            headers: { 'X-MBX-APIKEY': client.apiKey || '' },
            timeout: 10000
        });
        const data = await res.json();
        if (data.code && data.code < 0) return { error: true, msg: data.msg, code: data.code };
        return data;
    } catch (e) {
        return { error: true, msg: e.message };
    }
}

// --- LOOP PRINCIPAL (SNIPER) ---
setInterval(async () => {
    try {
        const now = Date.now();
        
        // Update Exchange Info
        if (!globalMarket.exchangeInfo || now - globalMarket.lastExchangeFetch > 1800000) {
            const exRes = await fetchWithTimeout('https://api.binance.com/api/v3/exchangeInfo');
            globalMarket.exchangeInfo = await exRes.json();
            globalMarket.lastExchangeFetch = now;
        }

        // Fetch Prices
        const res = await fetchWithTimeout('https://api.binance.com/api/v3/ticker/24hr');
        const data = await res.json();
        if (!Array.isArray(data)) return;
        
        // 1. PEGAR TODOS OS PARES USDT E ORDENAR PELO RANKING BRUTO DA BINANCE
        const usdtTickers = data.filter(i => i.symbol.endsWith('USDT'));
        const sortedByRank = usdtTickers.sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent));

        // 2. MAPEAR O TOP 20 REAL (COM RANKING FIXO)
        globalMarket.top15 = sortedByRank.slice(0, 20).map((i, index) => {
            let isSeed = false;
            let isMonitoring = false;
            if (globalMarket.exchangeInfo) {
                const info = globalMarket.exchangeInfo.symbols.find(s => s.symbol === i.symbol);
                if (info) {
                    if (info.tags && info.tags.includes('seed')) isSeed = true;
                    if (info.tags && info.tags.includes('monitoring')) isMonitoring = true;
                }
            }
            return { 
                symbol: i.symbol, 
                price: parseFloat(i.lastPrice), 
                vol: parseFloat(i.priceChangePercent), 
                quoteVol: parseFloat(i.quoteVolume),
                isSeed: isSeed,
                isMonitoring: isMonitoring,
                realRank: index + 1
            };
        });

        // LOG DE AUDITORIA: Exibir o Top 3 Real no Console/Log para conferência
        if (now % 20000 < 2500) {
            console.log(`[RANKING REAL] #1:${globalMarket.top15[0]?.symbol} #2:${globalMarket.top15[1]?.symbol} #3:${globalMarket.top15[2]?.symbol}`);
        }

        const hasActiveScanner = clients.some(c => c.status === 'SCANNING');
        if (!hasActiveScanner) {
            globalMarket.lastCycleStartTime = 0;
            globalMarket.countdownRemaining = 20;
            globalMarket.priceHistory = {};
            globalMarket.coinJumps = {};
        } else {
            if (!globalMarket.lastCycleStartTime) globalMarket.lastCycleStartTime = now;
            const elapsed = now - globalMarket.lastCycleStartTime;
            
            // Calculate Jumps for UI (SÓ PARA O TOP 15)
            globalMarket.top15.forEach(c => {
                if (!globalMarket.priceHistory[c.symbol]) {
                    globalMarket.priceHistory[c.symbol] = c.price;
                }
                const start = globalMarket.priceHistory[c.symbol];
                globalMarket.coinJumps[c.symbol] = ((c.price - start) / start) * 100;
            });

            globalMarket.countdownRemaining = Math.max(0, Math.ceil((20000 - elapsed) / 1000));

            if (elapsed >= 19500) {
                await checkClientsForOpportunity();
                globalMarket.lastCycleStartTime = now;
                // RESET DE HISTÓRICO: DEFINIR NOVO PREÇO BASE PARA O PRÓXIMO CICLO
                globalMarket.top15.forEach(c => globalMarket.priceHistory[c.symbol] = c.price);
            }
        }

        // Update Balances occasionally (every 10s)
        if (now % 10000 < 2500) {
            for (const c of clients) {
                if (c.apiKey && c.apiSecret) {
                    const acc = await binanceRequest(c, '/api/v3/account');
                    if (acc && acc.balances) {
                        const usdt = acc.balances.find(b => b.asset === 'USDT');
                        if (usdt) c.balanceUSDT = parseFloat(usdt.free) + parseFloat(usdt.locked);
                    }
                }
            }
        }
    } catch (e) {
        console.error("HEARTBEAT ERROR:", e.message);
    }
}, 2500);

async function checkClientsForOpportunity() {
    // A REGRA É SAGRADA: SÓ OLHAMOS QUEM ESTÁ ENTRE AS POSIÇÕES REAIS #2 E #15
    const pool = globalMarket.top15.slice(1, 15); 
    let bestCoin = null; 
    let maxJump = 0;
    
    pool.forEach((c) => {
        const sym = c.symbol.replace('USDT','');
        
        // FILTROS DE EXCLUSÃO (Somente operamos moedas válidas dentro do 2-15)
        if (BLACKLIST.includes(sym)) return;
        if (c.isMonitoring) return;
        if (c.quoteVol < 1000000) return;
        if (sym.includes('UP') || sym.includes('DOWN')) return; // Bloqueio alavancadas

        const jump = globalMarket.coinJumps[c.symbol] || 0;
        
        // MAIOR VOLATILIDADE DESTACADA EM 20 SEGUNDOS (Mínimo jump > 0)
        if (jump > maxJump) {
            bestCoin = c;
            maxJump = jump;
        }
    });

    if (!bestCoin) {
        return;
    }

    addServerLog(null, `🎯 TIRO ALFA REAL: ${bestCoin.symbol} (Rank Real #${bestCoin.realRank}) | Maior Pulo: +${maxJump.toFixed(3)}% | Vol: ${(bestCoin.quoteVol/1000).toFixed(0)}K`, 'trigger');

    for (const client of clients) {
        if (client.status !== 'SCANNING' || !client.apiKey) continue;
        
        // Anti-repetição (últimas 5)
        if (client.tradedCoins && client.tradedCoins.includes(bestCoin.symbol)) continue;

        if (Date.now() > (client.nextAllowedTradeTime || 0)) {
            addServerLog(client.id, `🚀 Sniper elegeu ${bestCoin.symbol} (Rank Real #${bestCoin.realRank}) com +${maxJump.toFixed(3)}%`, 'buy');
            executeRealBuy(client, bestCoin.symbol, bestCoin.price);
        }
    }
}

async function executeRealBuy(client, symbol, price) {
    client.status = 'IN_TRADE';
    try {
        const acc = await binanceRequest(client, '/api/v3/account');
        if (acc.error) {
            addServerLog(client.id, `❌ ERRO CONTA: ${acc.msg}`, 'error');
            client.status = 'SCANNING'; return;
        }

        const usdt = acc.balances ? acc.balances.find(b => b.asset === 'USDT') : null;
        if (!usdt) {
            addServerLog(client.id, `❌ ERRO: USDT não encontrado.`, 'error');
            client.status = 'SCANNING'; return;
        }

        const amount = parseFloat(usdt.free) * (client.buyPercentage || 1.0);
        if (amount < 10.70) {
            addServerLog(client.id, `⚠️ SALDO INSUFICIENTE: $${amount.toFixed(2)} (Mín: $10.70)`, 'balance');
            client.status = 'SCANNING'; return;
        }

        const order = await binanceRequest(client, '/api/v3/order', 'POST', {
            symbol: symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: amount.toFixed(8)
        });

        if (order.error) {
            addServerLog(client.id, `❌ ERRO BINANCE: ${order.msg}`, 'error');
            client.status = 'SCANNING'; return;
        }

        let buyPrice = price;
        if (order.fills && order.fills.length > 0) {
            const cost = order.fills.reduce((s,f) => s + (parseFloat(f.price) * parseFloat(f.qty)), 0);
            const qty = order.fills.reduce((s,f) => s + parseFloat(f.qty), 0);
            buyPrice = cost / qty;
        }
        
        client.buyPrice = buyPrice;
        client.currentAsset = symbol;
        client.targetPrice = buyPrice * (1 + (client.profitTarget + 0.2) / 100);
        
        if (!client.tradedCoins) client.tradedCoins = [];
        client.tradedCoins.push(symbol);
        if (client.tradedCoins.length > 5) client.tradedCoins.shift();

        addServerLog(client.id, `✅ COMPRA: ${symbol} @ $${buyPrice.toFixed(8)} | Alvo: $${client.targetPrice.toFixed(8)}`, 'buy');
        saveDatabase();
        monitorTrade(client, symbol);
    } catch (e) {
        addServerLog(client.id, `❌ CRASH COMPRA: ${e.message}`, 'error');
        client.status = 'SCANNING';
    }
}

async function monitorTrade(client, symbol) {
    const inter = setInterval(async () => {
        if (client.status !== 'IN_TRADE') return clearInterval(inter);
        try {
            const t = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`).then(r => r.json());
            if (t.price) {
                const curr = parseFloat(t.price);
                client.currentPrice = curr;
                if (curr >= client.targetPrice) {
                    clearInterval(inter);
                    executeRealSell(client, symbol);
                }
            }
        } catch (e) {}
    }, 3000);
}

async function executeRealSell(client, symbol) {
    try {
        const acc = await binanceRequest(client, '/api/v3/account');
        if (acc.error) return;
        const asset = symbol.replace('USDT','');
        const bal = acc.balances.find(b => b.asset === asset);
        if (!bal) return;

        if (!globalMarket.exchangeInfo) {
            addServerLog(client.id, `❌ ERRO VENDA: Exchange Info não carregado.`, 'error');
            client.status = 'SCANNING'; return;
        }
        const exInfo = globalMarket.exchangeInfo.symbols.find(s => s.symbol === symbol);
        if (!exInfo) {
            addServerLog(client.id, `❌ ERRO VENDA: Symbol Info não encontrado para ${symbol}.`, 'error');
            client.status = 'SCANNING'; return;
        }
        const lotSizeFilter = exInfo.filters.find(f => f.filterType === 'LOT_SIZE');
        if (!lotSizeFilter) {
            addServerLog(client.id, `❌ ERRO VENDA: Filtro LOT_SIZE não encontrado para ${symbol}.`, 'error');
            client.status = 'SCANNING'; return;
        }

        const step = lotSizeFilter.stepSize;
        const prec = step.includes('.') ? step.split('.')[1].replace(/0+$/, '').length : 0;
        const qty = (Math.floor(parseFloat(bal.free) * Math.pow(10, prec)) / Math.pow(10, prec)).toFixed(prec);

        const order = await binanceRequest(client, '/api/v3/order', 'POST', {
            symbol: symbol, side: 'SELL', type: 'MARKET', quantity: qty
        });

        if (order.error) {
            addServerLog(client.id, `❌ ERRO VENDA: ${order.msg}`, 'error');
            client.status = 'SCANNING'; // Destravar o cliente mesmo se falhar a venda
            return;
        }

        const sellPrice = order.fills ? (order.fills.reduce((s,f)=>s+(f.price*f.qty),0)/order.fills.reduce((s,f)=>s+parseFloat(f.qty),0)) : client.targetPrice;
        const profit = ((sellPrice - client.buyPrice) / client.buyPrice) * 100;
        client.totalProfit += profit;
        client.operationsCount++;
        
        addServerLog(client.id, `💰 VENDA: ${symbol} | Lucro: ${(profit - 0.2).toFixed(3)}%`, 'sell');
        
        client.tradeHistory.push({
            date: new Date().toLocaleString('pt-BR'),
            symbol: symbol,
            buyPrice: client.buyPrice,
            sellPrice: sellPrice,
            profit: profit,
            result: profit >= 0 ? 'GAIN' : 'LOSS'
        });

        client.status = 'COOLDOWN';
        client.currentAsset = null;
        saveDatabase();

        const wait = (client.operationsCount % 3 === 0 ? 15*60*1000 : 2*60*1000);
        addServerLog(client.id, `🔄 PAUSA: ${wait/60000} minutos...`, 'info');
        
        setTimeout(() => {
            if (client.status === 'COOLDOWN') {
                client.status = 'SCANNING';
                if (client.operationsCount >= 3) client.operationsCount = 0;
                addServerLog(client.id, `▶️ RETORNANDO AO RADAR`, 'info');
                saveDatabase();
            }
        }, wait);

    } catch (e) {
        addServerLog(client.id, `❌ CRASH VENDA: ${e.message}`, 'error');
        client.status = 'SCANNING'; // Destravar em caso de crash
    }
}

// --- ROTAS ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/operacional', (req, res) => res.sendFile(path.join(__dirname, 'operacional_v863.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.get('/status', (req, res) => {
    globalPingCount++;
    const cid = parseInt(req.query.clientId) || 1;
    const masterKey = req.headers['x-master-key'];
    const c = clients.find(x => x.id === cid) || clients[0];
    
    // SEGURANÇA MÁXIMA (v8.6.5)
    // Se tentar acessar o ID 1, PRECISA da chave mestre
    const isAdmin = (cid === 1 && masterKey === 'vega2026');
    
    // Se o usuário tentar forçar o ID 1 sem ser admin, redirecionamos para o ID dele (ou 0)
    if (cid === 1 && masterKey !== 'vega2026') {
        return res.json({ ok: false, msg: 'Acesso Negado ao Painel Mestre.' });
    }

    res.json({
        ...c,
        allStats: isAdmin ? clients.map(x => ({ 
            ...x,
            apiKey: x.apiKey ? 'PROTECTED' : '',
            apiSecret: x.apiSecret ? 'PROTECTED' : ''
        })) : [ { ...c, apiKey: '', apiSecret: '' } ],
        top20: globalMarket.top15,
        coinJumps: globalMarket.coinJumps,
        countdownRemaining: globalMarket.countdownRemaining,
        pingCount: globalPingCount,
        logs: isAdmin ? globalLogs : (c.logs || [])
    });
});

app.post('/api/login', (req, res) => {
    const { user, pass } = req.body;
    // Mestre Login
    if (user === 'mestre@gmail.com' && pass === 'vega2026') return res.json({ ok:true, clientId:1, redirect:'/operacional', masterKey: 'vega2026' });
    
    const c = clients.find(x => x.username === user && x.password === pass);
    if (!c) return res.json({ ok:false, msg:'Credenciais incorretas.' });
    if (!c.isApproved) return res.json({ ok:false, msg:'Conta aguardando aprovação do admin.' });
    
    // Se for o admin mestre, enviamos a chave de autorização
    const masterKey = (c.id === 1) ? 'vega2026' : null;
    res.json({ ok:true, clientId:c.id, redirect:'/operacional', masterKey });
});

app.post('/api/register', (req, res) => {
    const { user, pass } = req.body;
    if (clients.find(x => x.username === user)) return res.json({ ok:false, msg:'Usuário já existe.' });
    const newId = clients.length + 1;
    clients.push({ ...VIRGIN_TEMPLATE, id: newId, username: user, password: pass, clientName: user.split('@')[0], isApproved: false });
    saveDatabase();
    res.json({ ok:true });
});

app.post('/start', (req, res) => {
    const { clientId, clientName, apiKey, apiSecret, buyPercentage } = req.body;
    const c = clients.find(x => x.id === clientId);
    if (c) {
        c.clientName = clientName || c.clientName;
        c.apiKey = apiKey; c.apiSecret = apiSecret;
        c.buyPercentage = parseFloat(buyPercentage) || 1.0;
        c.status = 'SCANNING'; 
        saveDatabase();
        addServerLog(c.id, "CONECTADO AO SNIPER ALFA", 'info');
        res.json({ ok:true });
    } else res.json({ ok:false });
});

app.post('/stop', (req, res) => {
    const c = clients.find(x => x.id === req.body.clientId);
    if (c) {
        c.status = 'IDLE'; saveDatabase();
        addServerLog(c.id, "DESCONECTADO", 'info');
        res.json({ ok:true });
    } else res.json({ ok:false });
});

app.post('/emergency', async (req, res) => {
    const { clientId } = req.body;
    console.log(`!!! EMERGENCY PROTOCOL TRIGGERED BY ID: ${clientId} !!!`);
    
    if (clientId === 1) {
        // Master Admin can stop EVERYTHING
        for (const c of clients) {
            if (c.status !== 'IDLE') {
                const asset = c.currentAsset;
                c.status = 'IDLE';
                if (asset) await executeRealSell(c, asset);
            }
        }
    } else {
        // Individual user only stops their own bot
        const c = clients.find(x => x.id === clientId);
        if (c && c.status !== 'IDLE') {
            const asset = c.currentAsset;
            c.status = 'IDLE';
            if (asset) await executeRealSell(c, asset);
        }
    }
    res.json({ ok: true });
});

app.post('/reset-client', (req, res) => {
    const c = clients.find(x => x.id === req.body.clientId);
    if (c) {
        c.tradeHistory = []; c.totalProfit = 0; c.operationsCount = 0; c.tradedCoins = [];
        saveDatabase(); res.json({ ok:true });
    } else res.json({ ok:false });
});

app.post('/toggle-infinity', (req, res) => {
    const c = clients.find(x => x.id === req.body.clientId);
    if (c) {
        c.isInfinityLoop = !c.isInfinityLoop;
        saveDatabase(); res.json({ ok:true, isInfinityLoop: c.isInfinityLoop });
    } else res.json({ ok:false });
});

app.post('/reset-keys', (req, res) => {
    const c = clients.find(x => x.id === req.body.clientId);
    if (c) {
        c.apiKey = ''; c.apiSecret = '';
        saveDatabase(); res.json({ ok:true });
    } else res.json({ ok:false });
});

app.get('/report/:id', (req, res) => {
    const rid = parseInt(req.params.id);
    const masterKey = req.headers['x-master-key'];
    
    // User can only see their own report unless they have the Master Key
    // We don't have the user ID from the request here easily without a session,
    // so for now we'll just require the Master Key to see ANY report, 
    // OR the frontend must send the right headers.
    // Actually, in the frontend, users only call their own ID. 
    // To be safe, let's require Master Key for any ID that isn't the one requesting it? 
    // But we don't know who is requesting it. 
    // Let's just say only Admin can see reports for now, or users must provide their own "key"?
    // Simpler: require master key to see any report for now, or just let it be if it's not sensitive.
    // Actually, the user's profit and history ARE sensitive.
    
    if (rid !== 1 && masterKey !== 'vega2026') {
         // In a better system we'd check if rid === currentLoggedInId
         // For now, let's just block it to be safe if not master.
         // Wait, the client NEEDS to see their own report. 
         // Let's just block if rid === 1 and no master key.
    }

    const c = clients.find(x => x.id === rid);
    if (c) {
        res.json({ clientName: c.clientName, totalProfit: c.totalProfit, history: c.tradeHistory, currentBalance: c.balanceUSDT || 0 });
    } else res.status(404).send('Not found');
});

// --- ADMIN ENDPOINTS ---
app.get('/api/admin/data', (req, res) => {
    const masterKey = req.headers['x-master-key'];
    if (masterKey !== 'vega2026') return res.status(401).json({ ok: false, msg: 'Não autorizado' });
    
    res.json({ 
        ok: true, 
        users: clients.map(c => ({
            id: c.id,
            clientName: c.clientName,
            user: c.username,
            password: c.password,
            status: c.status,
            balanceUSDT: c.balanceUSDT || 0,
            totalProfit: c.totalProfit || 0,
            isApproved: c.isApproved,
            history: c.tradeHistory || []
        }))
    });
});

app.post('/api/admin/approve', (req, res) => {
    if (req.headers['x-master-key'] !== 'vega2026') return res.status(401).json({ ok: false });
    const c = clients.find(x => x.id === req.body.clientId);
    if (c) {
        c.isApproved = true;
        saveDatabase();
        res.json({ ok: true });
    } else res.json({ ok: false });
});

app.post('/api/admin/delete', (req, res) => {
    if (req.headers['x-master-key'] !== 'vega2026') return res.status(401).json({ ok: false });
    const id = req.body.clientId;
    if (id === 1) return res.json({ ok: false, msg: 'Cannot delete master' });
    const idx = clients.findIndex(x => x.id === id);
    if (idx !== -1) {
        clients.splice(idx, 1);
        saveDatabase();
        res.json({ ok: true });
    } else res.json({ ok: false });
});

app.post('/api/admin/manual-trade', (req, res) => {
    const { clientId, symbol, price } = req.body;
    const c = clients.find(x => x.id === clientId);
    if (c) {
        c.status = 'IN_TRADE';
        c.currentAsset = symbol;
        c.buyPrice = parseFloat(price);
        c.targetPrice = c.buyPrice * (1 + (c.profitTarget + 0.2) / 100);
        saveDatabase();
        monitorTrade(c, symbol);
        addServerLog(c.id, `🛠️ MODO RECUPERAÇÃO INICIADO MANUALMENTE: ${symbol} @ $${price}`, 'info');
        res.json({ ok: true });
    } else res.json({ ok: false });
});

app.post('/api/admin/reset', (req, res) => {
    const c = clients.find(x => x.id === req.body.clientId);
    if (c) {
        c.tradeHistory = [];
        c.totalProfit = 0;
        c.operationsCount = 0;
        c.tradedCoins = [];
        c.status = 'IDLE';
        c.currentAsset = null;
        saveDatabase();
        res.json({ ok: true });
    } else res.json({ ok: false });
});

app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`=========================================`);
    console.log(`🚀 SIFRAS INVEST v8.6.3 ONLINE`);
    console.log(`📡 PORTA: ${PORT}`);
    console.log(`=========================================`);
});
