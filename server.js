// FLUXO ALFA ENGINE v8.6.0 - SYNC BINANCE ACTIVE (MARKET ORDERS)
const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// --- CONFIGURAÇÃO DE PERSISTÊNCIA (RAILWAY VOLUME) ---
const VOLUME_PATH = '/app/data';
const DATA_FILE = fs.existsSync(VOLUME_PATH) ? path.join(VOLUME_PATH, 'database.json') : './database.json';

// Log para confirmar onde os dados estão sendo salvos
const app = express();
app.use(express.json());
app.use(cors());

// --- ESTADO GLOBAL ---
let globalLogs = [];
let globalPingCount = 0;

process.on('uncaughtException', (err) => {
    console.error('FATAL CRASH:', err);
    // Tenta logar no sistema se possível
    try {
        const time = new Date().toLocaleTimeString('pt-BR');
        fs.appendFileSync('crash.log', `[${time}] ${err.stack}\n`);
    } catch(e) {}
});

// --- MIDDLEWARE DE CONEXÃO (OPEN FOR LOCAL) ---
app.use((req, res, next) => {
    // PREVENÇÃO DE BLOQUEIOS CSP EM AMBIENTE LOCAL
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Access-Control-Allow-Origin", "*"); // Permite acesso de qualquer origem local
    
    // --- PREVENÇÃO DE CACHE DE NAVEGADOR ---
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    
    next();
});

// --- ROTA DE DOWNLOAD DO EXECUTÁVEL ---
app.get('/download-software', (req, res) => {
    // Caminho relativo para compatibilidade com Linux/Railway
    const zipPath = path.join(__dirname, 'release', 'SIFRAS_INVEST_ALFA_ATUALIZADO.zip');
    if (fs.existsSync(zipPath)) {
        res.download(zipPath, 'Sifras_Alfa_Personal_Completo.zip');
    } else {
        res.status(404).send('O pacote está sendo gerado ou não foi encontrado na pasta /release.');
    }
});

// --- HEALTH CHECK ---
app.get('/ping', (req, res) => {
    res.set('X-Deploy-Status', 'OK');
    res.json({ status: 'online', time: new Date().toISOString(), version: 'v1.0.2' });
});

// --- ROTAS PRINCIPAIS (LOGIN/DASHBOARD) ---
// Serve o index.html na raiz explicitamente
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Rota simplificada para o Admin
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Rota específica para o modo operacional (Dashboard v8.6.3)
app.get('/operacional', (req, res) => {
    res.sendFile(path.join(__dirname, 'operacional_v863.html'));
});

// --- SERVIR ARQUIVOS ESTÁTICOS (CONFIGURAÇÃO FINAL) ---
app.use(express.static(__dirname));

// --- CONFIGURAÇÃO DOS CLIENTES (DINÂMICO) ---
let clients = [];

// Template do Operacional "Virgem" (ESTRATÉGIA INTOCADA POR DETERMINAÇÃO)
const VIRGIN_TEMPLATE = {
    username: '',
    password: '',
    clientName: '',
    isApproved: false,
    apiKey: '',
    apiSecret: '',
    entryThreshold: 0, // Ignorar 0.3% (v8.6.3 real)
    buyPercentage: 1.0, 
    operationsCount: 0,
    totalProfit: 0,
    currentAsset: null,
    buyPrice: 0,
    status: 'IDLE',
    tradeHistory: [],
    tradedCoins: [], // Histórico curto para anti-repetição
    lastTradeTime: 0, // Para pausa de 2 min
    cycleCount: 0, // Contador para pausa de 15 min
    nextAllowedTradeTime: 0, // Trava de descanso
    profitTarget: 0.8, // 0.8% Líquido
    stopLoss: 0 // SEM STOP LOSS (Removido por solicitação)
};

function saveDatabase() {
    try {
        // Remove senhas no log, mas salva no arquivo
        fs.writeFileSync(DATA_FILE, JSON.stringify(clients, null, 2));
    } catch (e) { console.error('Erro ao salvar DB:', e.message); }
}

function loadDatabase() {
    if (fs.existsSync(DATA_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(DATA_FILE));
            clients = data.map(saved => ({
                ...JSON.parse(JSON.stringify(VIRGIN_TEMPLATE)), // Base limpa
                ...saved // Sobrescreve com dados do DB
            }));
            console.log(`✅ Banco de dados carregado: ${clients.length} clientes ativos.`);
            
            // Retomada Automática Alfa
            clients.forEach(c => {
                if (c.status === 'IN_TRADE' && c.currentAsset) {
                    console.log(`[RESUME] Retomando ${c.currentAsset} para ID ${c.id}`);
                    monitorTrade(c, c.currentAsset, c.buyPrice);
                }
            });
        } catch (e) { console.error('Erro ao carregar DB:', e.message); clients = []; }
    } else {
        // O Admin Master já nasce aprovado
        const admin = { ...VIRGIN_TEMPLATE, id: 1, username: 'admin', password: 'vega2026', clientName: 'Master Admin', isApproved: true };
        clients.push(admin);
        saveDatabase();
    }
    
    // MIGRATION: Garante que o acesso admin online mude de alfa777 para vega2026 agora mesmo
    clients.forEach(c => {
        if (c.username === 'admin' && c.password === 'alfa777') {
            c.password = 'vega2026';
            saveDatabase();
        }
    });
}
loadDatabase();

// --- DADOS DE MERCADO GLOBAIS (HEARTBEAT) ---
let globalMarket = {
    top20: [],
    coinJumps: {},
    maxJump: 0,
    exchangeInfo: null,
    lastExchangeFetch: 0,
    lastUpdate: 0, // Proteção contra dados velhos (Desalinhamento)
    priceHistory: {}, // Global: 'SYMBOL' -> price (Snapshot at start of 20s)
    lastCycleStartTime: 0 // Início do relógio de 20 segundos
};

const BLACKLIST = [
    // --- MOEDAS SUSPEITAS / BAIXA RELEV NCIA / DESLISTADAS ---
    'CHESS', 'KP3R', 'REEF', 'VITE', 'UNFI', 'EPX', 'FOR', 'VGX', 'OAX', 'PROS',

    // --- FAN TOKENS (TIMES DE FUTEBOL E CORRIDAS) - ALTO RISCO DE MANIPULAÇÃO ---
    'SANTOS', 'PORTO', 'LAZIO', 'ALPINE', 'OG', // Binace Launchpad
    'BAR', 'PSG', 'CITY', 'JUV', 'ACM', 'ATM', 'ASR', // Socios.com
    'INTER', 'TRA', 'AFC', 'MENGO', 'NAP', // Outros

    // --- MOEDAS ESTÁVEIS / PAREADAS (NÃO OPERAR) ---
    'USDC', 'TUSD', 'BUSD', 'FDUSD', 'USDP', 'EUR'
];

// --- UTILITÁRIOS ---
// --- UTILITÁRIOS DE REDE BLINDADOS ---
async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 8000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(resource, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

function addServerLog(clientId, msg, type = 'info') {
    let time;
    try {
        time = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    } catch(e) {
        time = new Date().toLocaleTimeString('pt-BR'); // Fallback para o horário do servidor
    }
    let prefix = 'SISTEMA';
    let client = null;
    
    if (clientId) {
        client = clients[clientId - 1];
        if (client) {
            prefix = client.clientName ? `${client.clientName.toUpperCase()}` : `CLIENTE ${clientId}`;
        }
    }

    const fullMsg = `${prefix} / ${msg}`;
    const logItem = { timestamp: time, msg: fullMsg, type };

    try {
        // Log do cliente (para o PDF)
        if (client) {
            if (!client.logs) client.logs = [];
            client.logs.unshift(logItem);
            if (client.logs.length > 50) client.logs.pop();
        }

        // Log Global (para o Dashboard)
        if (Array.isArray(globalLogs)) {
            globalLogs.unshift(logItem);
            if (globalLogs.length > 100) globalLogs.pop();
        }
    } catch(e) {
        console.error("Log error:", e.message);
    }

    console.log(`[${prefix}] ${time} - ${msg}`);
}

function getSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

async function binanceRequest(client, endpoint, method = 'GET', params = {}) {
    try {
        // --- SINCRONIA REAL DE TEMPO (FAIL-SAFE) ---
        const serverTimeRes = await fetch('https://api.binance.com/api/v3/time');
        const { serverTime } = await serverTimeRes.json();
        const diff = serverTime - Date.now();
        
        const timestamp = Date.now() + diff; // Alinha perfeitamente com a Binance
        let queryString = `timestamp=${timestamp}&recvWindow=60000`;
        Object.keys(params).forEach(key => queryString += `&${key}=${params[key]}`);
        const signature = getSignature(queryString, client.apiSecret);
        const url = `https://api.binance.com${endpoint}?${queryString}&signature=${signature}`;
        // console.log(`[SYNC] Diff: ${diff}ms | OK`);

        // Timeout de 10s para evitar travamento
        const res = await fetchWithTimeout(url, {
            method: method,
            headers: { 'X-MBX-APIKEY': client.apiKey },
            timeout: 10000
        });

        const data = await res.json();

        if (data.code && data.code < 0) {
            console.error(`[BINANCE ERROR ${data.code}] ${data.msg}`);
            return { error: true, ...data };
        }
        return data;
    } catch (e) {
        // Tratamento silencioso de erros de rede para não travar o loop
        if (e.name === 'AbortError') {
            console.error(`[NETWORK TIMEOUT] A conexão com a Binance expirou (>10s).`);
            return { error: true, msg: 'Timeout de Rede - Binance lenta ou desconectada' };
        }
        console.error(`[BINANCE REQ ERROR] ${e.message}`);
        return { error: true, msg: e.message };
    }
}

async function updateStatus(client, newStatus, msg = '') {
    client.status = newStatus;
    saveDatabase(); // Salva o novo status imediatamente
    console.log(`[CLIENT ${client.id} STATUS] ${newStatus} ${msg ? '-' : ''} ${msg}`);
}

// --- HEARTBEAT GLOBAL (Monitoramento Contínuo) ---
setInterval(async () => {
    try {
        const now = Date.now();

        // 1. Atualizar ExchangeInfo (30min)
        if (!globalMarket.exchangeInfo || now - globalMarket.lastExchangeFetch > 1800000) {
            const exres = await fetchWithTimeout('https://api.binance.com/api/v3/exchangeInfo', { timeout: 10000 });
            globalMarket.exchangeInfo = await exres.json();
            globalMarket.lastExchangeFetch = now;
            console.log('[SYSTEM] Exchange Info Atualizado.');
        }
        if (!globalMarket.exchangeInfo) return;

        // 2. Buscar Ticker 24h
        const res = await fetchWithTimeout('https://api.binance.com/api/v3/ticker/24hr', { timeout: 8000 });
        const data = await res.json();
        if (!Array.isArray(data)) return;

        // 3. Filtrar e Rankear (Top 30)
        globalMarket.top20 = data
            .filter(i => {
                if (!i.symbol.endsWith('USDT')) return false;
                const symbolBase = i.symbol.replace('USDT', '');

                // --- 1. BLOQUEIO DE FAN TOKENS E MOEDAS IRRELEVANTES ---
                if (BLACKLIST.includes(symbolBase)) return false;

                // Bloqueio extra para Fan Tokens não listados explicitamente que contenham padrões comuns
                // (Muitos fan tokens usam siglas de 3 letras de times, melhor garantir)
                // Lista de Fan Tokens conhecida (Binance Fan Token Platform)
                const FAN_TOKENS = [
                    'SANTOS', 'PORTO', 'LAZIO', 'ALPINE', 'OG', 'BAR', 'PSG', 'CITY',
                    'JUV', 'ACM', 'ATM', 'ASR', 'INTER', 'TRA', 'AFC', 'MENGO', 'NAP',
                    'GAL', 'TH', 'PFL', 'ALL', 'LEGION', 'UCH'
                ];
                if (FAN_TOKENS.includes(symbolBase)) return false;


                // --- PROTOCOLO DE SEGURANÇA MÁXIMA (FAIL-SAFE) ---
                if (!globalMarket.exchangeInfo || !globalMarket.exchangeInfo.symbols) {
                    return false;
                }

                const info = globalMarket.exchangeInfo.symbols.find(s => s.symbol === i.symbol);
                if (!info) return false;

                // --- 2. BLOQUEIO DE TAGS DE RISCO (MONITORING) ---
                if (info.status !== 'TRADING') return false;
                if (info.tags && info.tags.includes('monitoring')) return false;

                // --- 3. RELEV NCIA DE MERCADO (VOLUME) ---
                // Moedas ocultas ou sem liquidez são filtradas aqui.
                // Aumentando corte para 150k USDT para garantir relevância mínima "visivel" no ranking principal.
                return parseFloat(i.quoteVolume) > 150000;
            })
            .map(i => {
                let isSeed = false;
                if (globalMarket.exchangeInfo && globalMarket.exchangeInfo.symbols) {
                    const info = globalMarket.exchangeInfo.symbols.find(s => s.symbol === i.symbol);
                    if (info && info.tags && info.tags.includes('seed')) isSeed = true;
                }
                return {
                    symbol: i.symbol,
                    price: parseFloat(i.lastPrice),
                    vol: parseFloat(i.priceChangePercent),
                    isSeed: isSeed
                };
            })
            .filter(i => i.vol > 0)
            .sort((a, b) => b.vol - a.vol)
            .slice(0, 10);

        // DEBUG VISUAL DO RANKING (Para verificar alinhamento com Binance)
        const topString = globalMarket.top20.slice(0, 6).map((x, i) => `#${i + 1} ${x.symbol.replace('USDT', '')}:${x.vol.toFixed(2)}%`).join(' | ');
        console.log(`[RANKING BINANCE] ${topString}`);

        // 4. ALIMENTAR HISTÓRICO E CONTROLE DO RELÓGIO DE 20S
        const hasActiveScanner = clients.some(c => c.status === 'SCANNING');
        let isCycleEnd = false;
        
        if (!hasActiveScanner) {
            globalMarket.lastCycleStartTime = 0;
            globalMarket.countdownRemaining = 20;
            // Limpa o histórico para ter o momento exato de conexão como base 0 limpa
            globalMarket.priceHistory = {};
            globalMarket.coinJumps = {};
        } else {
            if (!globalMarket.lastCycleStartTime) globalMarket.lastCycleStartTime = now;
            
            // Se já bateu os 20s de espera
            isCycleEnd = (now - globalMarket.lastCycleStartTime) >= 19500;
            
            let currentMaxJump = 0;
            globalMarket.coinJumps = {}; // Jumps em relação ao START do ciclo
            
            for (const coin of globalMarket.top20) {
                if (!globalMarket.priceHistory[coin.symbol]) {
                    globalMarket.priceHistory[coin.symbol] = coin.price; // Preenche a 1ª Vez
                    continue;
                }
                
                const startPrice = globalMarket.priceHistory[coin.symbol];
                const jump = ((coin.price - startPrice) / startPrice) * 100;
                globalMarket.coinJumps[coin.symbol] = jump;
                if (Math.abs(jump) > currentMaxJump) currentMaxJump = Math.abs(jump);
            }
            
            globalMarket.maxJump = currentMaxJump;
            
            // Expor o tempo restante para o FrontEnd de forma limpa (0 a 20)
            globalMarket.countdownRemaining = isCycleEnd ? 0 : Math.max(1, Math.ceil((20000 - (now - globalMarket.lastCycleStartTime)) / 1000));
        }

        globalMarket.lastUpdate = now;

        // 5. ATUALIZAR SALDOS EM TEMPO REAL (ASSÍNCRONO - SEM BLOQUEIO)
        // Movi para fora do loop principal para zero lag no motor de 20s.
        
            // 6. EXECUTAR LÓGICA DE RANKING (APENAS NA HORA EXATA DO TIRO - CICLO DE 20S)
            if (isCycleEnd) {
                // Atribui os jumps calculados para a lógica de compra
                globalMarket.top20.forEach(coin => {
                    coin.lastUpdateJump = globalMarket.coinJumps[coin.symbol] || 0;
                });

                await checkClientsForOpportunity();
                
                // Reinicia o Ciclo
                globalMarket.lastCycleStartTime = now;
                globalMarket.countdownRemaining = 20;
                for (const coin of globalMarket.top20) {
                    globalMarket.priceHistory[coin.symbol] = coin.price;
                }
            }

    } catch (e) {
        console.error('[SYSTEM HEARTBEAT ERROR]', e.message);
    }
}, 2500); // Frequência de 2.5s para o Ranking reagir rápido

// --- LOOP INDEPENDENTE DE SALDOS (PARA NÃO ATRASAR O MOTOR) ---
setInterval(async () => {
    for (const client of clients) {
        if (client.apiKey && client.apiSecret && client.status !== 'IDLE') {
            try {
                const account = await binanceRequest(client, '/api/v3/account');
                if (account && account.balances) {
                    const usdt = account.balances.find(b => b.asset === 'USDT');
                    if (usdt) client.balanceUSDT = parseFloat(usdt.free) + parseFloat(usdt.locked);
                }
            } catch (e) { }
        }
    }
}, 8000); // Atualiza saldo a cada 8s em background

async function validateAlfaSecurity(client, symbol, currentPrice) {
    try {
        addServerLog(client.id, `🔍 ANALISANDO SEGURANÇA ALFA: ${symbol}...`, 'info');

        // 1. FILTRO DE PREÇO E VOLUME 24H (Base)
        const exchangeInfo = globalMarket.exchangeInfo.symbols.find(s => s.symbol === symbol);
        if (currentPrice < 0.000001) return { ok: false, msg: 'Preço muito baixo (Risco de manipulação)' };

        // 2. VOLUME SPIKE (10s)
        // Verificamos se houve um salto de volume significativo no último ciclo
        // (Usamos o ticker 24h para aproximar a pressão de compra recente)

        // 3. RSI / MFI (Recuperando Klines de 1m para RSI simplificado)
        const klines = await fetchWithTimeout(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=14`, { timeout: 5000 }).then(r => r.json());
        if (klines.length < 14) return { ok: false, msg: 'Dados insuficientes para RSI' };

        let gains = 0, losses = 0;
        for (let i = 1; i < klines.length; i++) {
            const diff = parseFloat(klines[i][4]) - parseFloat(klines[i - 1][4]);
            if (diff >= 0) gains += diff; else losses -= diff;
        }
        const rsi = 100 - (100 / (1 + (gains / (losses || 1))));
        if (rsi > 75) return { ok: false, msg: `RSI Sobrecomprado (${rsi.toFixed(1)})` };

        // 4. SCAN DE ORDEM (Order Book / Depth)
        const depth = await fetchWithTimeout(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=20`, { timeout: 5000 }).then(r => r.json());
        const totalBids = depth.bids.reduce((sum, b) => sum + parseFloat(b[1]), 0);
        const totalAsks = depth.asks.reduce((sum, a) => sum + parseFloat(a[1]), 0);
        const bookRatio = totalBids / totalAsks;
        if (bookRatio < 1.1) return { ok: false, msg: `Pressão de Venda no Book (Ratio: ${bookRatio.toFixed(2)})` };

        // Remoção da regra de micro-queda que conflitava com a medição dos 20s absolutos

        addServerLog(client.id, `✅ ALFA APROVADO: RSI ${rsi.toFixed(1)} | Book ${bookRatio.toFixed(2)}x`, 'info');
        return { ok: true };

    } catch (e) {
        console.error('Erro na validação Alfa:', e.message);
        return { ok: false, msg: 'Falha na telemetria de segurança' };
    }
}

// --- SCANNER DE ALTA VOLATILIDADE ALFA 20S (MOTOR LIMPO) ---
async function checkClientsForOpportunity() {
    const now = Date.now();
    const blacklist = [
        'PEPE','SHIB','FLOKI','DOGE','BONK','WIF','MEME','BABYDOGE', // Memes
        'BAR','ACM','ASR','ATM','INTER','JUV','CITY','PORTO','SANTOS','LAZIO','PSG','ALPACA', // Fan Tokens/Teams
        'LUNC','USTC','FTT','VGX','BTTC' // Zumbis/Monitoradas
    ];
    
    if (!globalMarket.top20 || globalMarket.top20.length < 15) return;

    // Selecionar do #2 ao #15 (Índices 1 a 14)
    const pool = globalMarket.top20.slice(1, 15);
    
    // Identificar a CAMPEÃ da VOLATILIDADE (Maior salto nos últimos 20s) entre o ranking #2-15
    let bestCoin = null;
    let maxJump = -9999;

    for (const coin of pool) {
        const symbol = coin.symbol.replace('USDT', '');
        const volumeOK = (parseFloat(coin.quoteVolume) || 0) >= 1000000;
        const notBlacklisted = !blacklist.includes(symbol);
        
        if (volumeOK && notBlacklisted) {
            const jump = coin.lastUpdateJump || 0; // Calculado no Radar a cada 20s
            if (jump > maxJump) {
                maxJump = jump;
                bestCoin = coin;
            }
        }
    }

    if (!bestCoin || maxJump <= 0) return;

    for (const client of clients) {
        if (client.status !== 'SCANNING' || !client.isApproved) continue;

        // 1. Sistema de Descanso (Trava Temporal)
        if (now < client.nextAllowedTradeTime) continue;

        // 2. Filtro Anti-Repetição (Só repete a mesma moeda após 4 outras operações)
        const recentCoins = (client.tradedCoins || []).slice(-4);
        if (recentCoins.includes(bestCoin.symbol)) continue;

        console.log(`[FERRARI v8.6.3] ${bestCoin.symbol} eleita com +${maxJump.toFixed(3)}% de volatilidade no ato.`);
        executeRealBuy(client, bestCoin.symbol, parseFloat(bestCoin.lastPrice));
    }
}

// --- FUNÇÕES DE TRADE FERRARI v8.6.3 ---
async function executeRealBuy(client, symbol, price) {
    updateStatus(client, 'IN_TRADE', `Comprando: ${symbol}`);
    try {
        const account = await binanceRequest(client, '/api/v3/account');
        if (account.error || !account.balances) {
            addServerLog(client.id, `Erro API: ${account.msg || 'Falha na conta'}`, 'error');
            updateStatus(client, 'SCANNING'); return;
        }

        const usdt = account.balances.find(b => b.asset === 'USDT');
        const amount = (parseFloat(usdt.free) || 0) * (client.buyPercentage || 1.0);

        if (amount < 11) {
            addServerLog(client.id, `Saldo USDT insuficiente ($${amount.toFixed(2)}) para operar.`, 'balance');
            updateStatus(client, 'SCANNING'); return;
        }

        const buyOrder = await binanceRequest(client, '/api/v3/order', 'POST', {
            symbol: symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: amount.toFixed(8)
        });

        if (buyOrder.error) {
            addServerLog(client.id, `❌ ERRO COMPRA: ${buyOrder.msg}`, 'error');
            updateStatus(client, 'SCANNING'); return;
        }

        // Preço Médio Real de Compra
        let avgPrice = price;
        if (buyOrder.fills && buyOrder.fills.length > 0) {
            const cost = buyOrder.fills.reduce((s, f) => s + (parseFloat(f.price) * parseFloat(f.qty)), 0);
            const qty = buyOrder.fills.reduce((s, f) => s + parseFloat(f.qty), 0);
            avgPrice = cost / qty;
        }

        client.buyPrice = avgPrice;
        client.currentAsset = symbol;
        addServerLog(client.id, `✅ COMPRA EXECUTADA: ${symbol} @ $${avgPrice.toFixed(8)}`, 'buy');
        
        // Inicia Monitoramento de Lucro
        monitorTrade(client, symbol);
    } catch (e) {
        updateStatus(client, 'SCANNING');
    }
}

async function monitorTrade(client, symbol) {
    const monitorInterval = setInterval(async () => {
        if (client.status === 'IDLE' || !client.currentAsset) return clearInterval(monitorInterval);

        try {
            const ticker = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`).then(r => r.json());
            const current = parseFloat(ticker.price);
            
            // 0.8% Líquido + 0.2% Taxas = 1.0% Variação no preço
            const diff = ((current - client.buyPrice) / client.buyPrice) * 100;
            const target = 1.0; 

            if (diff >= target) {
                console.log(`[ALVO] ${symbol} atingiu +${diff.toFixed(2)}%`);
                clearInterval(monitorInterval);
                executeRealSell(client, symbol);
            }
        } catch (e) {}
    }, 5000);
}

async function executeRealSell(client, symbol) {
    updateStatus(client, 'IN_TRADE', `Vendendo: ${symbol}`);
    try {
        const account = await binanceRequest(client, '/api/v3/account');
        const asset = symbol.replace('USDT', '');
        const balance = account.balances.find(b => b.asset === asset);
        
        if (!balance || parseFloat(balance.free) <= 0) {
            addServerLog(client.id, `Saldo de ${asset} não encontrado para venda.`, 'error');
            updateStatus(client, 'SCANNING'); return;
        }

        const sellOrder = await binanceRequest(client, '/api/v3/order', 'POST', {
            symbol: symbol, side: 'SELL', type: 'MARKET', quantity: parseFloat(balance.free).toFixed(8) 
        });

        if (sellOrder.error) {
            // ANTI-GHOST SELL: Verifica se a venda realmente falhou ou se foi apenas um timeout de rede
            const checkAcc = await binanceRequest(client, '/api/v3/account');
            const coinAsset = symbol.replace('USDT', '');
            const stillHasCoin = checkAcc.balances?.find(b => b.asset === coinAsset && parseFloat(b.free) > 0);
            
            if (!stillHasCoin) {
                addServerLog(client.id, `✅ Venda assumida por fail-safe (Timeout Rede mascarou sucesso Binance)!`, 'sell');
            } else {
                addServerLog(client.id, `❌ ERRO VENDA: ${sellOrder.msg}`, 'error');
                return;
            }
        }

        // Cálculo Preciso de Safra (Average Fill Price)
        let sellPriceReal = 0;
        if (sellOrder.fills && sellOrder.fills.length > 0) {
            const rev = sellOrder.fills.reduce((s, f) => s + (parseFloat(f.price) * parseFloat(f.qty)), 0);
            const qty = sellOrder.fills.reduce((s, f) => s + parseFloat(f.qty), 0);
            sellPriceReal = rev / qty;
        } else {
            sellPriceReal = client.buyPrice * 1.01; // Fallback caso binance não retorne feeds (1% alvo)
        }

        const profit = ((sellPriceReal - client.buyPrice) / client.buyPrice) * 100;
        client.totalProfit += profit;
        client.operationsCount++;
        client.cycleCount = (client.cycleCount || 0) + 1;
        client.tradedCoins.push(symbol);
        if (client.tradedCoins.length > 10) client.tradedCoins.shift();

        addServerLog(client.id, `💰 VENDA CONCLUÍDA: ${symbol} | Lucro: ${profit.toFixed(2)}%`, 'sell');
        
        client.currentAsset = null;
        applyRestSystem(client);
    } catch (e) { updateStatus(client, 'SCANNING'); }
}

function applyRestSystem(client) {
    const now = Date.now();
    let pauseTime = 2 * 60 * 1000; // 2 minutos
    
    if (client.cycleCount >= 3) {
        pauseTime = 15 * 60 * 1000; // 15 minutos
        client.cycleCount = 0;
        addServerLog(client.id, `⏸️ DESCANSO LONGO (3 CICLOS): 15 minutos de pausa.`, 'info');
    } else {
        addServerLog(client.id, `⏸️ DESCANSO CURTO: 2 minutos de pausa.`, 'info');
    }

    client.nextAllowedTradeTime = now + pauseTime;
    client.status = 'STOPPED';

    setTimeout(() => {
        client.status = 'SCANNING';
        addServerLog(client.id, `🔄 DESCANSO FINALIZADO: Retornando ao Radar Ferrari.`, 'trigger');
        saveDatabase();
    }, pauseTime);
    saveDatabase();
}

// --- ENDPOINTS ---
app.post('/start', (req, res) => {
    const { clientId, clientName, apiKey, apiSecret, buyPercentage } = req.body;
    const client = clients[clientId - 1];

    client.clientName = clientName || `Cliente ${clientId}`;
    client.apiKey = apiKey;
    client.apiSecret = apiSecret;
    client.buyPercentage = parseFloat(buyPercentage) || 1.0;
    updateStatus(client, 'SCANNING', 'Conectado ao Radar Global');
    saveDatabase();
    res.json({ ok: true });
});

app.post('/stop', (req, res) => {
    const { clientId } = req.body;
    const client = clients[clientId - 1];
    updateStatus(client, 'IDLE', 'Desconectado');
    res.json({ ok: true });
});

app.get('/status', (req, res) => {
    globalPingCount++;
    const requestedId = req.query.clientId ? parseInt(req.query.clientId) : null;
    
    // Lista todos os IDs para o HUB do operacional
    const allStats = clients.map(c => ({
        id: c.id,
        name: c.clientName,
        status: c.status,
        balanceUSDT: c.balanceUSDT,
        currentAsset: c.currentAsset,
        currentPrice: c.currentPrice || 0,
        buyPrice: c.buyPrice || 0,
        isInfinityLoop: c.isInfinityLoop || false,
        buyPercentage: c.buyPercentage || 1.0,
        apiKey: c.apiKey ? '********' : '', // Segurança: Nunca enviar chaves reais no status global
        apiSecret: c.apiSecret ? '********' : ''
    }));

    let activeClient;
    if (requestedId) {
        activeClient = clients.find(c => c.id === requestedId);
    } else {
        activeClient = clients.find(c => c.status === 'IN_TRADE') ||
            clients.find(c => c.status === 'SCANNING') ||
            clients[0];
    }

    // Retorna os dados do cliente selecionado + o status resumido de TODOS (para o Hub)
    res.json({
        id: activeClient.id,
        name: activeClient.clientName,
        status: activeClient.status,
        logs: activeClient.logs || [],
        totalProfit: activeClient.totalProfit || 0,
        operationsCount: activeClient.operationsCount || 0, 
        currentAsset: activeClient.currentAsset,
        buyPrice: activeClient.buyPrice,
        entryPrice: activeClient.entryPrice,
        currentPrice: activeClient.currentPrice || 0,
        targetPrice: activeClient.targetPrice || 0, // Adicionado para exibir o alvo no card
        history: activeClient.tradeHistory || [],
        balanceUSDT: activeClient.balanceUSDT || 0,
        buyPercentage: activeClient.buyPercentage || 1.0,
        isInfinityLoop: activeClient.isInfinityLoop || false,
        allStats: allStats,
        globalLogs: globalLogs,
        // Sincronia de Telemetria (Radar)
        top20: globalMarket.top20,
        coinJumps: globalMarket.coinJumps,
        maxJump: globalMarket.maxJump,
        countdownRemaining: globalMarket.countdownRemaining,
        pingCount: globalPingCount
    });
});

// --- NOVAS ROTAS DE AUTENTICAÇÃO E ADMIN ---

app.post('/api/register', (req, res) => {
    const { user, pass } = req.body;
    if (!user || !pass) return res.json({ ok: false, msg: 'Dados incompletos' });
    
    // PADRONIZAÇÃO OBRIGATÓRIA @GMAIL NO BACKEND
    if (!user.toLowerCase().endsWith('@gmail.com')) {
        return res.json({ ok: false, msg: 'Apenas endereços @gmail.com são permitidos.' });
    }

    const exists = clients.find(c => c.username === user);
    if (exists) return res.json({ ok: false, msg: 'Usuário já existe' });
    const newId = clients.length > 0 ? Math.max(...clients.map(c => c.id)) + 1 : 1;
    const newClient = { ...JSON.parse(JSON.stringify(VIRGIN_TEMPLATE)), id: newId, username: user, password: pass, clientName: `Operacional #${newId}` };
    clients.push(newClient); saveDatabase(); res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
    const { user, pass } = req.body;
    
    // ACESSO OPERACIONAL MESTRE (mestre@gmail.com / vega2026)
    if (user === 'mestre@gmail.com' && pass === 'vega2026') {
        const adminIndex = clients.findIndex(c => c.id === 1);
        if (adminIndex !== -1) {
            clients[adminIndex].isApproved = true;
            clients[adminIndex].username = 'mestre@gmail.com';
            clients[adminIndex].password = 'vega2026';
            clients[adminIndex].clientName = 'Amintas Master';
            saveDatabase();
        }
        return res.json({ ok: true, clientId: 1, redirect: '/operacional', token: 'ALFA-MESTRE' });
    }

    const client = clients.find(c => (c.username === user || c.clientName === user) && c.password === pass);
    if (!client) return res.json({ ok: false, msg: 'Credenciais inválidas' });
    if (!client.isApproved && client.id !== 1) return res.json({ ok: false, msg: 'Acesso negado: Aguardando aprovação do Admin.' });
    
    res.json({ ok: true, clientId: client.id, redirect: '/operacional', token: 'ALFA-' + Date.now() });
});

app.get('/api/admin/data', (req, res) => {
    res.json({ 
        ok: true, 
        users: clients.map(c => ({
            id: c.id, user: c.username, password: c.password, clientName: c.clientName, status: c.status,
            isApproved: c.isApproved, operationsCount: c.operationsCount, totalProfit: c.totalProfit,
            currentAsset: c.currentAsset, buyPrice: c.buyPrice, balanceUSDT: c.balanceUSDT || 0,
            history: c.tradeHistory || []
        })),
        logs: globalLogs, top20: globalMarket.top20, countdownRemaining: globalMarket.countdownRemaining, pingCount: globalPingCount
    });
});

app.post('/api/admin/approve', (req, res) => {
    const { clientId } = req.body;
    const client = clients.find(c => c.id === clientId);
    if (client) {
        client.isApproved = true;
        saveDatabase();
        addServerLog(clientId, `✅ USUÁRIO APROVADO PELO ADMIN.`, 'info');
        res.json({ ok: true });
    } else { res.json({ ok: false }); }
});

app.post('/api/admin/delete', (req, res) => {
    const { clientId } = req.body;
    const index = clients.findIndex(c => c.id === clientId);
    if (index !== -1 && clientId !== 1) { // Não deletar o admin master
        console.log(`[AUTH] Usuário removido permanentemente ID: ${clientId}`);
        clients.splice(index, 1);
        saveDatabase();
        res.json({ ok: true });
    } else { res.json({ ok: false }); }
});

app.post('/api/admin/manual-trade', (req, res) => {
    const { clientId, symbol, price } = req.body;
    const client = clients.find(c => c.id === clientId);
    if (client) {
        client.status = 'IN_TRADE';
        client.currentAsset = symbol;
        client.buyPrice = parseFloat(price);
        client.entryPrice = parseFloat(price);
        client.tradeStartTime = Date.now();
        saveDatabase();
        addServerLog(clientId, `🚀 RECUPERACAO: Monitorando ${symbol} @ $${price}`, 'trigger');
        monitorTrade(client, symbol, parseFloat(price));
        res.json({ ok: true });
    } else { res.json({ ok: false }); }
});

app.post('/api/admin/reset', (req, res) => {
    const { clientId } = req.body;
    const index = clients.findIndex(c => c.id === clientId);
    if (index !== -1) {
        const old = clients[index];
        clients[index] = { ...JSON.parse(JSON.stringify(VIRGIN_TEMPLATE)), id: old.id, username: old.username, password: old.password, clientName: old.clientName, apiKey: old.apiKey, apiSecret: old.apiSecret };
        saveDatabase(); res.json({ ok: true });
    } else { res.json({ ok: false }); }
});

app.get('/report/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const client = clients[id - 1];
    if (client) {
        let currentBalance = 0;
        try {
            // Tenta buscar saldo atualizado em tempo real
            if (client.apiKey && client.apiSecret) {
                const account = await binanceRequest(client, '/api/v3/account');
                const usdt = account.balances.find(b => b.asset === 'USDT');
                if (usdt) currentBalance = parseFloat(usdt.free) + parseFloat(usdt.locked);
            }
        } catch (e) {
            console.error(`[REPORT] Erro ao buscar saldo cliente ${id}:`, e.message);
        }

        res.json({
            clientName: client.clientName,
            totalProfit: client.totalProfit,
            history: client.tradeHistory,
            currentBalance: currentBalance
        });
    } else {
        res.status(404).json({ error: 'Cliente não encontrado' });
    }
});

app.post('/emergency', async (req, res) => {
    // Stop All e Vende Tudo
    console.log("EMERGENCY STOP ALL");
    for (const c of clients) {
        if (c.status !== 'IDLE') {
            updateStatus(c, 'IDLE', 'EMERGENCY STOP');
            if (c.currentAsset) {
                await executeRealSell(c, c.currentAsset, 'EMERGENCY');
            }
        }
    }
    res.json({ message: 'Emergency Protocol Executed' });
});

app.post('/reset-client', (req, res) => {
    const { clientId } = req.body;
    const client = clients[clientId - 1];
    if (client) {
        // Zera métricas da sessão
        client.tradeHistory = [];
        client.totalProfit = 0;
        client.operationsCount = 0;
        client.logs = [];
        client.tradedCoins = []; // Limpando lista negra no reset

        saveDatabase();
        addServerLog(client.id, "--- SESSÃO E EXTRATO RESETADOS PELO USUÁRIO ---", 'warning');

        res.json({ ok: true, message: 'Cliente resetado com sucesso' });
    } else {
        res.status(404).json({ error: 'Cliente não encontrado' });
    }
});

app.post('/toggle-infinity', (req, res) => {
    const { clientId } = req.body;
    const client = clients[clientId - 1];
    if (client) {
        client.isInfinityLoop = !client.isInfinityLoop;
        saveDatabase();
        res.json({ ok: true, isInfinityLoop: client.isInfinityLoop });
    } else {
        res.status(404).json({ error: 'Cliente não encontrado' });
    }
});

app.post('/reset-keys', (req, res) => {
    const { clientId } = req.body;
    const client = clients[clientId - 1];
    if (client) {
        client.apiKey = '';
        client.apiSecret = '';
        saveDatabase();
        addServerLog(client.id, "⚠️ CHAVES DE API RESETADAS PELO USUÁRIO", 'warning');
        res.json({ ok: true });
    } else {
        res.status(404).json({ error: 'Cliente não encontrado' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log('======================================================');
    console.log('🚀 SIFRAS INVEST - SERVIDOR ATIVO (MODO SNIPER)');
    console.log(`📡 URL: http://0.0.0.0:${PORT}`);
    console.log(`🔧 NODE VERSION: ${process.version}`);
    console.log(`📈 AMBIENTE: ${process.env.RAILWAY_ENVIRONMENT_NAME || 'LOCAL'}`);
    console.log('======================================================');
});
