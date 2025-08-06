/*
 * Robust RSI14 implementation that matches TradingView (Wilder's method)
 * and helper utilities for preparing candle closes from Binance and OANDA responses.
 *
 * Usage (Browser / Apps-Script):
 *   import { prepareBinanceCloses, prepareOandaCloses, rsi14 } from './fixed_rsi.js';
 */

// --- CONSTANTS ----------------------------------------------------------------
export const RSI_PERIOD = 14;

// --- TYPE HELPERS -------------------------------------------------------------
/**
 * Binance kline index mapping for reference
 *  0 openTime, 1 open, 2 high, 3 low, 4 close, 5 volume,
 *  6 closeTime, 7 quoteAssetVolume, 8 trades, 9 baseVol, 10 quoteVol, 11 ignore
 */

// --- DATA NORMALISATION -------------------------------------------------------

/**
 * Returns an array of **closed** candle close prices in chronological order
 * (oldest → newest) from the raw Binance REST /api/v3/klines response.
 *
 * The Binance endpoint always returns candles in chronological order BUT it does
 * include the very last candle that is *still forming*. We must therefore drop
 * that candle when its closeTime is still in the future relative to `Date.now()`.
 *
 * @param {Array<Array>} klineData Raw /klines response
 * @returns {number[]} Close prices (oldest → newest) without the current forming candle
 */
export function prepareBinanceCloses(klineData) {
  if (!Array.isArray(klineData)) return [];
  const now = Date.now();
  const closed = klineData.filter(k => k[6] <= now); // 6 = closeTime (ms)
  return closed.map(k => parseFloat(k[4])); // 4 = close
}

/**
 * Returns an array of close prices (oldest → newest) from an OANDA candles
 * payload (already filtered for price=M & completed candles). OANDA delivers
 * the newest candle first, so we simply reverse after filtering.
 *
 * @param {Array<Object>} candles Array from OANDA response
 * @returns {number[]} Close prices (oldest → newest)
 */
export function prepareOandaCloses(candles) {
  if (!Array.isArray(candles)) return [];
  return candles
    .filter(c => c.complete)              // keep only completed candles
    .reverse()                            // newest → oldest  →  oldest → newest
    .map(c => parseFloat(c.mid.c));
}

// --- RSI CALCULATION ----------------------------------------------------------

/**
 * Wilder's RSI implementation for a series of closes.
 * The function expects data in chronological order (oldest first) and returns
 * the RSI for the **last** close in the sequence.
 *
 * @param {number[]} closes Close prices, oldest → newest. Must be >= period+1 in length.
 * @param {number} period RSI period (defaults to 14)
 * @returns {number|null} RSI value between 0‒100 or `null` when not enough data.
 */
export function rsi14(closes, period = RSI_PERIOD) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;

  let gainSum = 0;
  let lossSum = 0;

  // 1. seed with the first `period` differences -------------------------------
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff; else lossSum -= diff; // diff negative ⇒ loss
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  // 2. Wilder's smoothing for the remaining candles ---------------------------
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100; // keep overbought edge-case
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}