/**
 * Google Apps Script backend for Crypto & Forex Dashboard + LINE bot
 * -------------------------------------------------------------------------
 * Deploy as a Web App with:
 *   Execute as:      Me
 *   Who has access:  Anyone, even anonymous (or anyone within domain)
 *
 * index.html uses the templating syntax <?= ... ?> to receive sensitive
 * credentials from here.  Nothing else is exposed on the client.
 *
 * In addition, the script can be used as a webhook endpoint for LINE to send a
 * Flex Message with the latest market data.  All heavy API calls are performed
 * server-side to avoid CORS issues.
 */

// === GLOBAL CONFIGURATION =====================================================
const LINE_CHANNEL_ACCESS_TOKEN = 'YOUR_LINE_CHANNEL_ACCESS_TOKEN_HERE';
const OANDA_ACCOUNT_ID          = 'YOUR_OANDA_ACCOUNT_ID_HERE';
const OANDA_API_KEY             = 'YOUR_OANDA_REST_API_KEY_HERE';

// Symbols to track -------------------------------------------------------------
const OANDA_SYMBOLS  = ['XAU_USD','WTICO_USD','USD_CHF','USD_THB'];
const BINANCE_SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','ADAUSDT','XRPUSDT','BNBUSDT','DOGEUSDT','SHIBUSDT','GALAUSDT','ZILUSDT','PEPEUSDT','TRUMPUSDT','SUIUSDT','UNIUSDT','LTCUSDT','AVAXUSDT'];

const SYMBOLS_TO_TRACK = [...OANDA_SYMBOLS, ...BINANCE_SYMBOLS];

// API endpoints ----------------------------------------------------------------
const BINANCE_API_URL = 'https://api.binance.com/api/v3';
const OANDA_API_URL   = 'https://api-fxtrade.oanda.com/v3';

// Misc constants ---------------------------------------------------------------
const RSI_PERIOD   = 14;
const KLINE_LIMIT  = 100;   // number of candles requested for RSI
const OANDA_TIME_FRAMES  = { H1:'H1', H4:'H4', D:'D', W:'W' };
const BINANCE_TIME_FRAMES = { H1:'1h', H4:'4h', D:'1d', W:'1w' };

/**
 * Util ‑ Serve HTML template ---------------------------------------------------
 */
function doGet(e) {
  const t = HtmlService.createTemplateFromFile('index');
  // expose secrets ONLY to template (they become literal strings in HTML)
  t.OANDA_ACCOUNT_ID = OANDA_ACCOUNT_ID;
  t.OANDA_API_KEY    = OANDA_API_KEY;

  return t.evaluate()
          .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
          .setTitle('Crypto & Forex Dashboard');
}

/**
 * include helper so we could split html/JS/CSS if needed
 */
// eslint-disable-next-line no-unused-vars
function include(filename) { return HtmlService.createHtmlOutputFromFile(filename).getContent(); }

// === LINE BOT WEBHOOK =========================================================

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (!body.events || body.events.length === 0) return HtmlService.createHtmlOutput('No event');

    const event      = body.events[0];
    const replyToken = event.replyToken;

    // assemble fresh market data (server-side avoids CORS + keeps secret keys)
    const marketData = fetchAllMarketData();
    const flexMsg    = createFlexMessage(marketData);

    replyToLine(replyToken, [flexMsg]);

  } catch (err) {
    console.error('doPost error', err);
  }
  return HtmlService.createHtmlOutput('OK');
}

function replyToLine(replyToken, messages) {
  const url = 'https://api.line.me/v2/bot/message/reply';
  const payload = { replyToken, messages };
  const options = {
    method      : 'post',
    contentType : 'application/json',
    payload     : JSON.stringify(payload),
    headers     : { Authorization: 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN },
    muteHttpExceptions: true
  };
  const res = UrlFetchApp.fetch(url, options);
  console.log('LINE reply status', res.getResponseCode());
}

// === MARKET DATA FETCHING =====================================================

function fetchAllMarketData() {
  const result = {};
  SYMBOLS_TO_TRACK.forEach(s => result[s] = emptyMarketRow());

  // OANDA first ---------------------------------------------------------------
  OANDA_SYMBOLS.forEach(sym => {
    try {
      result[sym] = { ...result[sym], ...fetchOandaData(sym) };
      Utilities.sleep(200); // safeguard against rate-limit
    } catch (err) {
      console.error('OANDA error', sym, err);
      result[sym].error         = true;
      result[sym].errorMessage  = err.toString();
    }
  });

  // Binance -------------------------------------------------------------------
  BINANCE_SYMBOLS.forEach(sym => {
    try {
      result[sym] = { ...result[sym], ...fetchBinanceData(sym) };
      Utilities.sleep(80);
    } catch (err) {
      console.error('Binance error', sym, err);
      result[sym].error         = true;
      result[sym].errorMessage  = err.toString();
    }
  });

  return result;
}

function emptyMarketRow() {
  return {
    price         : null,
    percentChange : null,
    ytdChange     : null,
    rsi           : { H1:null, H4:null, D:null, W:null },
    error         : false,
    errorMessage  : ''
  };
}

// --- Binance ------------------------------------------------------------------
function fetchBinanceData(symbol) {
  try {
    // 24h ticker
    const ticker = getJson(`${BINANCE_API_URL}/ticker/24hr?symbol=${symbol}`);
    const price  = parseFloat(ticker.lastPrice);
    const pct    = parseFloat(ticker.priceChangePercent);

    // YTD change --------------------------------------------------------------
    const startYearTs = new Date(new Date().getFullYear(), 0, 1).getTime();
    let ytd = null;
    try {
      const yearK = getJson(`${BINANCE_API_URL}/klines?symbol=${symbol}&interval=1d&startTime=${startYearTs}&limit=1`);
      if (yearK.length) {
        const startPrice = parseFloat(yearK[0][4]);
        ytd = (price - startPrice) / startPrice * 100;
      }
    } catch (_) {}

    // RSI values --------------------------------------------------------------
    const rsiVals = { H1:null, H4:null, D:null, W:null };
    Object.entries(BINANCE_TIME_FRAMES).forEach(([tfKey, interval]) => {
      try {
        const klines = getJson(`${BINANCE_API_URL}/klines?symbol=${symbol}&interval=${interval}&limit=${KLINE_LIMIT+1}`);
        const closes = prepareBinanceCloses(klines);
        rsiVals[tfKey] = calculateRSI(closes, RSI_PERIOD);
      } catch (err) {
        console.error('RSI binance', symbol, tfKey, err);
      }
    });

    return { price, percentChange:pct, ytdChange:ytd, rsi:rsiVals, error:false };
  } catch (err) {
    return { error:true, errorMessage:err.toString() };
  }
}

// --- OANDA --------------------------------------------------------------------
function fetchOandaData(symbol) {
  const headers = { Authorization: `Bearer ${OANDA_API_KEY}` };
  try {
    // price -------------------------------------------------------------------
    const priceJson = getJson(`${OANDA_API_URL}/accounts/${OANDA_ACCOUNT_ID}/pricing?instruments=${symbol}`, headers);
    if (!priceJson.prices || !priceJson.prices.length) throw new Error('price unavailable');
    const ask   = parseFloat(priceJson.prices[0].asks[0].price);
    const bid   = parseFloat(priceJson.prices[0].bids[0].price);
    const price = (ask + bid) / 2;

    // 24h change --------------------------------------------------------------
    let pct = 0;
    try {
      const daily = getJson(`${OANDA_API_URL}/instruments/${symbol}/candles?price=M&granularity=D&count=2`, headers);
      if (daily.candles && daily.candles.length > 1) {
        const prevClose = parseFloat(daily.candles.find(c => c.complete).mid.c);
        pct = (price - prevClose) / prevClose * 100;
      }
    } catch (_) {}

    // YTD change --------------------------------------------------------------
    let ytd = null;
    try {
      const startIso = new Date(new Date().getFullYear(), 0, 1).toISOString();
      const ytdJson  = getJson(`${OANDA_API_URL}/instruments/${symbol}/candles?price=M&granularity=D&from=${startIso}&count=1`, headers);
      if (ytdJson.candles && ytdJson.candles.length && ytdJson.candles[0].complete) {
        const p0 = parseFloat(ytdJson.candles[0].mid.c);
        ytd = (price - p0) / p0 * 100;
      }
    } catch (_) {}

    // RSI values --------------------------------------------------------------
    const rsiVals = { H1:null, H4:null, D:null, W:null };
    Object.entries(OANDA_TIME_FRAMES).forEach(([tfKey, gran]) => {
      try {
        const json = getJson(`${OANDA_API_URL}/instruments/${symbol}/candles?price=M&granularity=${gran}&count=${KLINE_LIMIT+1}`, headers);
        const closes = prepareOandaCloses(json.candles);
        rsiVals[tfKey] = calculateRSI(closes, RSI_PERIOD);
      } catch (err) {
        console.error('RSI oanda', symbol, tfKey, err);
      }
    });

    return { price, percentChange:pct, ytdChange:ytd, rsi:rsiVals, error:false };
  } catch (err) {
    return { error:true, errorMessage:err.toString() };
  }
}

// === Helper functions =========================================================
function getJson(url, headers) {
  const options = { muteHttpExceptions:true, headers }; // headers may be undefined
  const resp = UrlFetchApp.fetch(url, options);
  if (resp.getResponseCode() !== 200) throw new Error(resp.getContentText());
  return JSON.parse(resp.getContentText());
}

// Prepare closes --------------------------------------------------------------
function prepareBinanceCloses(klines) {
  if (!Array.isArray(klines)) return [];
  const now = Date.now();
  return klines.filter(k => k[6] <= now).map(k => parseFloat(k[4]));
}
function prepareOandaCloses(candles) {
  if (!Array.isArray(candles)) return [];
  return candles.filter(c => c.complete).reverse().map(c => parseFloat(c.mid.c));
}

// RSI -------------------------------------------------------------------------
function calculateRSI(closes, period) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff; else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// === LINE FLEX MESSAGE ========================================================
function createFlexMessage(marketData) {
  // Build rows ---------------------------------------------------------------
  const bodyRows = [];
  SYMBOLS_TO_TRACK.forEach((sym, idx) => {
    const d = marketData[sym];
    bodyRows.push(...buildFlexRow(sym, d));
    if (idx < SYMBOLS_TO_TRACK.length - 1) bodyRows.push({ type:'separator', margin:'sm' });
  });

  const headerRow = {
    type : 'box', layout:'horizontal', margin:'md', contents:[
      { type:'text', text:'Symbol', weight:'bold', size:'xs', color:'#555555', flex:3 },
      { type:'text', text:'Price',  weight:'bold', size:'xs', color:'#555555', align:'end', flex:3 },
      { type:'text', text:'H1',     weight:'bold', size:'xs', color:'#555555', align:'center', flex:1 },
      { type:'text', text:'H4',     weight:'bold', size:'xs', color:'#555555', align:'center', flex:1 },
      { type:'text', text:'D',      weight:'bold', size:'xs', color:'#555555', align:'center', flex:1 },
      { type:'text', text:'W',      weight:'bold', size:'xs', color:'#555555', align:'center', flex:1 }
    ]
  };

  return {
    type:'flex', altText:'Market Report', contents:{
      type:'bubble',
      header:{ type:'box', layout:'vertical', contents:[
        { type:'text', text:'Market Report & RSI', weight:'bold', color:'#FFFFFF', size:'lg' },
        { type:'text', text:'Real-time prices with RSI14', color:'#FFFFFF', size:'xs', margin:'xs' }
      ], backgroundColor:'#006cff', paddingAll:'12px' },
      body:{ type:'box', layout:'vertical', spacing:'sm', contents:[ headerRow, { type:'separator', margin:'md' }, ...bodyRows ] },
      footer:{ type:'box', layout:'vertical', contents:[
        { type:'text', text:`อัปเดต: ${Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM HH:mm')}`, size:'xxs', color:'#aaaaaa' },
        { type:'text', text:'RSI >70 = overbought, <30 = oversold', size:'xxs', color:'#666666', margin:'xs' }
      ], paddingTop:'6px' }
    }
  };
}

function buildFlexRow(sym, d) {
  let priceTxt, priceColor;
  const rsiText = tf => d && !d.error && d.rsi[tf] !== null ? `${Math.round(d.rsi[tf])}` : '-';
  const rsiColor = val => {
    if (val === null) return '#666666';
    if (val > 70) return '#2ECC71';
    if (val < 30) return '#E74C3C';
    return '#666666';
  };
  if (d && !d.error) {
    priceTxt   = formatPrice(d.price, getSource(sym));
    priceColor = d.percentChange >= 0 ? '#2ECC71' : '#E74C3C';
  } else {
    priceTxt   = 'ERR';
    priceColor = '#E74C3C';
  }

  return [{
    type:'box', layout:'horizontal', margin:'sm', contents:[
      { type:'text', text:sym.replace('_','/'), size:'xs', flex:3, gravity:'center', weight:'bold' },
      { type:'box', layout:'vertical', flex:3, contents:[
          { type:'text', text:priceTxt, size:'xs', weight:'bold', align:'end', color:priceColor },
          { type:'text', text:formatPercentChange(d.percentChange), size:'xxs', align:'end', color:priceColor }
        ] },
      ...(['H1','H4','D','W'].map(tf => ({
        type:'text', text:rsiText(tf), size:'xs', weight:'bold', align:'center', flex:1, gravity:'center', color:rsiColor(d.rsi[tf])
      })) )
    ]
  }];
}

// --- tiny helpers -------------------------------------------------------------
function getSource(sym) { return sym.includes('_') ? 'OANDA' : 'Binance'; }
function formatPrice(p, src) {
  if (p === null || isNaN(p)) return 'N/A';
  const max = src === 'Binance' && p < 1 ? 8 : 4;
  return Utilities.formatString('%.' + max + 'f', p);
}
function formatPercentChange(pc) {
  if (pc === null || isNaN(pc)) return 'N/A';
  const sign = pc >= 0 ? '+' : '';
  return sign + Utilities.formatString('%.2f', pc) + '%';
}