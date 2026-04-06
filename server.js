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
console.log(`[STORAGE] Usando base de dados em: ${DATA_FILE}`);

const app = express();
app.use(express.json());
app.use(cors());

// --- MIDDLEWARE DE SEGURANÇA E CONEXÃO (CSP FIX) ---
app.use((req, res, next) => {
    // Permite que o dashboard se conecte a si mesmo, ao Google Fonts e à Binance
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://*.binance.com; connect-src 'self' https://*.binance.com;");
    res.setHeader("X-Content-Type-Options", "nosniff");
    
    // --- PREVENÇÃO DE CACHE DE NAVEGADOR ESTILIZADO PARA O CLIENTE FINAL ---
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

// Rota específica para o modo operacional (Dashboard)
app.get('/operacional', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// --- SERVIR ARQUIVOS ESTÁTICOS (CONFIGURAÇÃO FINAL) ---
app.use(express.static(__dirname));

// --- CONFIGURAÇÃO DOS CLIENTES ---
const clients = [];
for (let i = 0; i < 1; i++) {
    clients.push({
        id: i + 1,
        clientName: '',
        apiKey: '',
        apiSecret: '',
        entryThreshold: 0.3,
        profitTarget: 0.6,
        stopLoss: 4.0,
        maxOpsBeforePause: 3,
        pauseDuration: 900000,
        interTradePause: 120000,
        status: 'IDLE',
        operationsCount: 0,
        currentAsset: null,
        entryPrice: 0,
        buyPrice: 0,
        tradeStartTime: 0,
        lastTradeDuration: '',
        maxJump: 0,
        pingCount: 0,
        logs: [],
        tradedCoins: [],
        lastSoldSymbol: null,
        lastSoldTime: 0,
        balanceUSDT: 0,
        totalProfit: 0,
        tradeHistory: [],
        buyPercentage: 1.0,
        isInfinityLoop: false
    });
}

function saveDatabase() {
    try {
        const data = clients.map(c => ({
            id: c.id,
            clientName: c.clientName,
            apiKey: c.apiKey,
            apiSecret: c.apiSecret,
            totalProfit: c.totalProfit,
            tradeHistory: c.tradeHistory,
            tradedCoins: c.tradedCoins || [],
            status: c.status,
            currentAsset: c.currentAsset,
            buyPrice: c.buyPrice,
            entryPrice: c.entryPrice,
            buyPercentage: c.buyPercentage || 1.0,
            isInfinityLoop: c.isInfinityLoop || false
        }));
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (e) { console.error('Erro ao salvar DB:', e.message); }
}

function loadDatabase() {
    if (fs.existsSync(DATA_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(DATA_FILE));
            data.forEach(saved => {
                const client = clients[saved.id - 1];
                if (client) {
                    client.clientName = saved.clientName || '';
                    client.apiKey = saved.apiKey || '';
                    client.apiSecret = saved.apiSecret || '';
                    client.totalProfit = saved.totalProfit || 0;
                    client.tradeHistory = saved.tradeHistory || [];
                    client.tradedCoins = saved.tradedCoins || [];
                    client.buyPercentage = saved.buyPercentage || 1.0;
                    client.isInfinityLoop = saved.isInfinityLoop || false;

                    // Lógica de Recuperação Automática (Modo Persistente Alfa)
                    if (saved.status === 'IN_TRADE' && saved.currentAsset) {
                        client.status = 'IN_TRADE';
                        client.currentAsset = saved.currentAsset;
                        client.buyPrice = saved.buyPrice;
                        client.entryPrice = saved.entryPrice;
                        client.tradeStartTime = Date.now();
                        addServerLog(client.id, `♻️ OPERAÇÃO RECUPERADA: Monitorando ${client.currentAsset} novamente...`, 'info');
                        monitorTrade(client, client.currentAsset, client.buyPrice);
                    } else if (saved.status === 'SCANNING') {
                        client.status = 'SCANNING';
                        addServerLog(client.id, `♻️ MONITORAMENTO RESTAURADO: Sniper ativo no Radar Global.`, 'info');
                    } else if (saved.status === 'COOLDOWN') {
                        client.status = 'SCANNING'; // Ao reiniciar em cooldown, volta a escanear para não perder tempo
                        addServerLog(client.id, `♻️ REINÍCIO PÓS-PAUSA: Retornando ao monitoramento.`, 'info');
                    }
                }
            });
            console.log('✅ Banco de dados carregado: Lucros e Históricos restaurados.');
        } catch (e) { console.error('Erro ao carredar DB:', e.message); }
    }
}
const globalLogs = [];
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
    const time = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
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

    // Log do cliente (para o PDF)
    if (client) {
        client.logs.unshift(logItem);
        if (client.logs.length > 50) client.logs.pop();
    }

    // Log Global (para o Dashboard)
    globalLogs.unshift(logItem);
    if (globalLogs.length > 100) globalLogs.pop();

    console.log(`[${prefix}] ${time} - ${msg}`);
}

function getSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

async function binanceRequest(client, endpoint, method = 'GET', params = {}) {
    try {
        const timestamp = Date.now();
        let queryString = `timestamp=${timestamp}`;
        Object.keys(params).forEach(key => queryString += `&${key}=${params[key]}`);
        const signature = getSignature(queryString, client.apiSecret);
        const url = `https://api.binance.com${endpoint}?${queryString}&signature=${signature}`;

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

        // 5. ATUALIZAR SALDOS EM TEMPO REAL
        for (const client of clients) {
            if (client.apiKey && client.apiSecret) {
                try {
                    const account = await binanceRequest(client, '/api/v3/account');
                    if (account && account.balances) {
                        const usdt = account.balances.find(b => b.asset === 'USDT');
                        if (usdt) client.balanceUSDT = parseFloat(usdt.free) + parseFloat(usdt.locked);
                    }
                } catch (e) { }
            }
        }

        // 6. EXECUTAR LÓGICA DE RANKING (APENAS NA HORA EXATA DO TIRO)
        await checkClientsForOpportunity(isCycleEnd);

        // Se atiramos, o ciclo se renova imediatamente para a próxima conta de 20s e RECARREGA OS PREÇOS ALVO
        if (isCycleEnd) {
            globalMarket.lastCycleStartTime = now;
            globalMarket.countdownRemaining = 20;
            // Atualiza a Snapshot DEPOIS do gatilho ter sido puxado para não bugar a segurança
            for (const coin of globalMarket.top20) {
                globalMarket.priceHistory[coin.symbol] = coin.price;
            }
        }

    } catch (e) {
        console.error('[SYSTEM HEARTBEAT ERROR]', e.message);
    }
}, 5000); // Frequência de 5s para o Ranking reagir rápido

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
async function checkClientsForOpportunity(isCycleEnd) {
    // SÓ atira na virada exata dos 20 segundos
    if (!isCycleEnd) return;

    const top = globalMarket.top20;
    if (!top || top.length === 0) return;

    // ISOLAR DA 2ª À 10ª COLOCADA (Índices 1 ao 9 no Top20 ordenado)
    const validPool = top.slice(1, 10);

    let bestCoin = null;
    let maxVolPositive = -9999; // Buscamos apenas ganhos nesse ciclo de 20s

    for (const targetCoin of validPool) {
        const jump = globalMarket.coinJumps[targetCoin.symbol] || 0;
        if (jump > maxVolPositive && jump > 0) { // Deve ser positivo
            maxVolPositive = jump;
            bestCoin = targetCoin;
        }
    }

    if (!bestCoin) {
        // Enviar log de sistema nulo para mostrar ao usuário que o relógio bateu
        addServerLog(null, `⏱️ CICLO 20s FECHADO: Nenhuma moeda(2-10) saltou com percentual positivo (Máx: ${maxVolPositive.toFixed(2)}%). Reiniciando...`, 'info');
        return;
    }

    addServerLog(null, `🎯 JANELA 20s FECHADA: Vencedora isolada foi ${bestCoin.symbol} (+${maxVolPositive.toFixed(3)}%)`, 'trigger');

    for (const client of clients) {
        if (client.status !== 'SCANNING') continue;

        // Anti-repetição básica: A mesma moeda não deve ser re-comprada repetidamente nas 5 últimas trades
        if (client.tradedCoins && client.tradedCoins.includes(bestCoin.symbol)) continue;

        addServerLog(client.id, `🎯 FIM DOS 20s: A Campeã do Ranking(2-10) é ${bestCoin.symbol} (+${maxVolPositive.toFixed(3)}%)`, 'trigger');

        // BYPASS COMPLETO DE SEGURANÇA: Compra garantida absoluta da eleita dos 20s
        addServerLog(client.id, `🚀 EXECUTANDO COMPRA FERRARI: ${bestCoin.symbol} (Tiro Isolado 20s!)`, 'buy');
        await executeRealBuy(client, bestCoin.symbol, bestCoin.price);
    }
}

// --- FUNÇÕES DE TRADE ---
async function executeRealBuy(client, symbol, price) {
    updateStatus(client, 'IN_TRADE', `Comprando Alvo: ${symbol}`);
    try {
        const account = await binanceRequest(client, '/api/v3/account');
        if (account.error || !account.balances) {
            addServerLog(client.id, `Erro ao acessar conta: ${account.msg || 'Chave API Inválida'}`, 'error');
            updateStatus(client, 'SCANNING');
            return;
        }

        const usdtBalance = account.balances.find(b => b.asset === 'USDT');
        if (!usdtBalance) {
            addServerLog(client.id, "Saldo USDT não localizado na conta.", 'balance');
            updateStatus(client, 'SCANNING');
            return;
        }

        let totalVal = parseFloat(usdtBalance.free);
        let amount = totalVal * (client.buyPercentage || 1.0);

        if (amount < 10) { // Binance mínimo é ~10 USDT
            addServerLog(client.id, `Saldo insuficiente ($${amount.toFixed(2)}) para comprar ${symbol} (Mínimo $10)`, 'balance');
            updateStatus(client, 'SCANNING');
            return;
        }

        const buyOrder = await binanceRequest(client, '/api/v3/order', 'POST', {
            symbol: symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: amount.toFixed(8)
        });

        if (buyOrder.error) {
            addServerLog(client.id, `ERRO BINANCE COMPRA [${buyOrder.code}]: ${buyOrder.msg || 'Falha ao processar ordem'}`, 'error');
            updateStatus(client, 'SCANNING');
            return;
        }

        if (!client.tradedCoins) client.tradedCoins = [];
        client.tradedCoins.push(symbol);
        // Mantém apenas as últimas 5 na memória para evitar repetição curta
        if (client.tradedCoins.length > 5) client.tradedCoins.shift();

        addServerLog(client.id, `COMPRA REALIZADA / ${symbol}`, 'buy');
        client.currentAsset = symbol;
        client.entryPrice = price;
        client.buyPrice = price; // Preço de referência para lucro
        client.tradeStartTime = Date.now();

        // Inicia monitor exclusivo deste trade
        monitorTrade(client, symbol, price);

    } catch (e) {
        addServerLog(client.id, "Erro Interno COMPRA: " + e.message, 'error');
        updateStatus(client, 'SCANNING');
    }
}

// Monitor específico de trade em andamento
async function monitorTrade(client, symbol, entryPrice) {
    // Adicionamos um buffer de 0.2% para cobrir a taxa de compra (0.1%) e venda (0.1%) da Binance
    const BINANCE_FEE_BUFFER = 0.2;
    const netProfitTarget = client.profitTarget + BINANCE_FEE_BUFFER;

    const profitTarget = entryPrice * (1 + (netProfitTarget / 100));
    const stopLossTarget = entryPrice * (1 - (client.stopLoss / 100));

    console.log(`[CLIENT ${client.id}] MONITOR ${symbol} | ALVO REAL (+TAXAS): ${profitTarget.toFixed(8)} | STOP: ${stopLossTarget}`);

    const tradeInterval = setInterval(async () => {
        if (client.status === 'IDLE') return clearInterval(tradeInterval);

        try {
            const ticker = await fetchWithTimeout(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, { timeout: 3000 }).then(r => r.json());
            const current = parseFloat(ticker.price);
            client.currentPrice = current; // Salva para o frontend ler
            client.targetPrice = profitTarget; // Salva o alvo para o frontend
            // Verifica Profit APENAS (Stop Loss removido)
            if (current >= profitTarget) {
                clearInterval(tradeInterval);
                await executeRealSell(client, symbol, 'PROFIT');
            }
            // Lógica de Stop Loss removida a pedido do usuário
            /* else if (current <= stopLossTarget) {
                clearInterval(tradeInterval);
                addServerLog(client.id, `⚠️ STOP LOSS ATINGIDO em ${symbol}: Preço ${current}`, 'error');
                await executeRealSell(client, symbol, 'STOP_LOSS');
            } */
        } catch (e) { console.error(e); }
    }, 1000);
}

async function executeRealSell(client, symbol, reason) {
    updateStatus(client, 'IN_TRADE', `Vendendo ${symbol} (${reason})...`);
    try {
        const exchangeInfo = globalMarket.exchangeInfo || await fetchWithTimeout(`https://api.binance.com/api/v3/exchangeInfo?symbol=${symbol}`, { timeout: 5000 }).then(r => r.json());
        const sInfo = exchangeInfo.symbols.find(s => s.symbol === symbol);
        const stepSize = sInfo.filters.find(f => f.filterType === 'LOT_SIZE').stepSize;
        const precision = stepSize.indexOf('1') - stepSize.indexOf('.');

        const account = await binanceRequest(client, '/api/v3/account');
        if (account.error || !account.balances) {
            addServerLog(client.id, `Erro ao buscar saldo para venda: ${account.msg || 'Falha na conta'}`, 'error');
            return;
        }

        const asset = symbol.replace('USDT', '');
        const balance = account.balances.find(b => b.asset === asset);
        if (!balance) {
            addServerLog(client.id, `Ativo ${asset} não encontrado no saldo para venda.`, 'error');
            return;
        }
        let qty = parseFloat(balance.free);

        const factor = Math.pow(10, precision > 0 ? precision : 0);
        qty = Math.floor(qty * factor) / factor;

        if (qty > 0) {
            const sellOrder = await binanceRequest(client, '/api/v3/order', 'POST', {
                symbol: symbol, side: 'SELL', type: 'MARKET', quantity: qty.toFixed(precision > 0 ? precision : 0)
            });

            if (sellOrder.error) {
                addServerLog(client.id, `ERRO BINANCE VENDA [${sellOrder.code}]: ${sellOrder.msg || 'Falha ao processar ordem'}`, 'error');
                updateStatus(client, 'IDLE');
                return;
            }
        } else {
            addServerLog(client.id, `ERRO VENDA: Quantidade calculada é zero para ${symbol}`, 'error');
            updateStatus(client, 'IDLE');
            return;
        }

        // Calcular Lucro
        const ticker = await fetchWithTimeout(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`, { timeout: 5000 }).then(r => r.json());
        const sellPrice = parseFloat(ticker.price);
        const profitPercent = ((sellPrice - client.buyPrice) / client.buyPrice) * 100;

        client.totalProfit += profitPercent;
        client.operationsCount++;
        client.lastSoldSymbol = symbol;
        client.lastSoldTime = Date.now();
        client.currentAsset = null; // Limpa ativo atual

        const logType = 'sell';
        const logPrefix = profitPercent >= 0 ? 'GAIN' : 'LOSS';
        addServerLog(client.id, `${logPrefix} / ${symbol} / ${profitPercent.toFixed(2)}% / TOTAL: ${client.totalProfit.toFixed(2)}%`, logType);

        // SALVAR NO HISTÓRICO PARA O RELATÓRIO
        client.tradeHistory.push({
            date: new Date().toLocaleString('pt-BR'),
            symbol: symbol,
            buyPrice: client.buyPrice,
            sellPrice: sellPrice,
            profit: profitPercent,
            result: logPrefix
        });

        // SALVAR NO DISCO
        saveDatabase();

        // Check OBRIGATÓRIO de 3 Ciclos e 15 Minutos de Pausa
        if (client.operationsCount >= client.maxOpsBeforePause) {
            // "Após 3 ciclos com lucro de 0,6%, pausa de 15 minutos e entra-se no ciclo seguinte."
            updateStatus(client, 'COOLDOWN');
            addServerLog(client.id, `🔄 META DE 3 CICLOS CONCLUÍDA! Iniciando Pausa Programada de 15 Minutos.`, 'info');
            setTimeout(() => {
                client.operationsCount = 0;
                updateStatus(client, 'SCANNING');
                addServerLog(client.id, "▶️ FIM DA PAUSA DE 15 MIN. Retornando ciclo de 20s ativado.", 'info');
            }, client.pauseDuration);
        } else {
            // PAUSA ENTRE OPERAÇÕES (2 MINUTOS padrão para descanso)
            updateStatus(client, 'COOLDOWN');
            addServerLog(client.id, `✅ 1 Ciclo Concluído. Pausa de descanso rápida (2m) antes da próxima caça.`, 'info');
            setTimeout(() => {
                updateStatus(client, 'SCANNING');
                addServerLog(client.id, "Retornando da pausa pós-trade. Sniper Ativo.", 'info');
            }, 120000); // 2 minutos
        }

    } catch (e) {
        addServerLog(client.id, "Erro Venda: " + e.message, 'error');
        updateStatus(client, 'IDLE'); // Para em caso de erro crítico
    }
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

let globalPingCount = 0;

app.get('/status', (req, res) => {
    globalPingCount++;
    const requestedId = req.query.clientId ? parseInt(req.query.clientId) : null;
    let activeClient;
    if (requestedId && clients[requestedId - 1]) {
        activeClient = clients[requestedId - 1];
    } else {
        // Prioridade automática: Quem está em TRADE -> Quem está SCANNING -> Cliente 1
        activeClient = clients.find(c => c.status === 'IN_TRADE') ||
            clients.find(c => c.status === 'SCANNING') ||
            clients[0];
    }

    // Retorna os dados do cliente selecionado + o status resumido de TODOS (para o Hub)
    res.json({
        ...activeClient,
        viewingClientId: activeClient.id,
        allStats: clients.map(c => ({
            id: c.id,
            status: c.status,
            name: c.clientName,
            ops: c.operationsCount,
            profit: c.totalProfit,
            currentAsset: c.currentAsset,
            buyPrice: c.buyPrice,
            currentPrice: c.currentPrice || 0,
            targetPrice: c.targetPrice || 0,
            isInfinityLoop: c.isInfinityLoop || false,
            buyPercentage: c.buyPercentage || 1.0,
            apiKey: c.apiKey,
            apiSecret: c.apiSecret,
            balanceUSDT: c.balanceUSDT || 0
        })),
        logs: globalLogs, // Sempre retorna os logs globais
        top20: globalMarket.top20,
        coinJumps: globalMarket.coinJumps,
        maxJump: globalMarket.maxJump,
        countdownRemaining: globalMarket.countdownRemaining,
        pingCount: globalPingCount
    });
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
