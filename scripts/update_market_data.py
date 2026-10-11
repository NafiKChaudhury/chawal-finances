
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CACHE_FILE = DATA_DIR / "market-data.json"
TICKERS_FILE = DATA_DIR / "tickers.json"

# Small daily fallback cache. Normal lookups query Yahoo Finance on demand,
# so a symbol does not need to be listed here before it can be used.
DEFAULT_TICKERS = ["AAPL", "RY.TO", "HYLD.TO"]


def load_tickers():
    if TICKERS_FILE.exists():
        with TICKERS_FILE.open(encoding="utf-8") as f:
            configured = json.load(f)
        if not isinstance(configured, list):
            raise ValueError("tickers.json must contain a list")
        tickers = configured
    else:
        tickers = DEFAULT_TICKERS

    return sorted({
        str(t).strip().upper()
        for t in tickers
        if isinstance(t, str) and t.strip()
    })


def safe_number(value):
    try:
        number = float(value)
        if number != number or number in (
            float("inf"), float("-inf")
        ):
            return None
        return number
    except (TypeError, ValueError):
        return None


def iso_date(value):
    if value is None:
        return None
    try:
        return value.date().isoformat()
    except AttributeError:
        return str(value)[:10]


def get_stock_data(symbol):
    ticker = yf.Ticker(symbol)
    history = ticker.history(period="5d", auto_adjust=False)

    if history.empty:
        raise ValueError("No recent price data available")

    closes = history["Close"].dropna()
    if closes.empty:
        raise ValueError("No valid closing price")

    price = safe_number(closes.iloc[-1])
    if price is None:
        raise ValueError("Invalid closing price")

    info = ticker.get_info() or {}
    dividends = ticker.dividends

    recent_dividends = []
    if not dividends.empty:
        for date, amount in dividends.tail(12).items():
            recent_dividends.append({
                "date": iso_date(date),
                "amount": safe_number(amount)
            })

    last_dividend = (
        recent_dividends[-1]
        if recent_dividends
        else None
    )

    return {
        "symbol": symbol,
        "name": info.get("shortName")
                or info.get("longName")
                or symbol,
        "currency": (
            info.get("currency")
            or ("CAD" if symbol.endswith((".TO", ".V"))
                else None)
        ),
        "price": price,
        "price_date": iso_date(closes.index[-1]),
        "dividend_rate": safe_number(
            info.get("dividendRate")
        ),
        "last_dividend": last_dividend,
        "dividend_history": recent_dividends,
        "next_dividend_date": None,
        "source": "Yahoo Finance via yfinance",
        "retrieved_at": datetime.now(
            timezone.utc
        ).isoformat()
    }


def get_usd_cad():
    history = yf.Ticker("CAD=X").history(period="5d")
    if history.empty:
        raise ValueError("USD/CAD rate unavailable")

    closes = history["Close"].dropna()
    if closes.empty:
        raise ValueError("No valid USD/CAD rate")

    rate = safe_number(closes.iloc[-1])
    if rate is None or rate <= 0:
        raise ValueError("Invalid USD/CAD rate")

    return {
        "rate": rate,
        "date": iso_date(closes.index[-1])
    }


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    previous = {}
    if CACHE_FILE.exists():
        with CACHE_FILE.open(encoding="utf-8") as f:
            previous = json.load(f)

    previous_stocks = previous.get("stocks", {})
    stocks = {}

    tickers = load_tickers()
    print(f"Refreshing {len(tickers)} securities")

    for symbol in tickers:
        try:
            stocks[symbol] = get_stock_data(symbol)
            print(f"OK: {symbol}")
        except Exception as exc:
            print(f"FAILED: {symbol}: {exc}")
            if symbol in previous_stocks:
                stocks[symbol] = {
                    **previous_stocks[symbol],
                    "stale": True
                }

    try:
        usd_cad = get_usd_cad()
    except Exception as exc:
        print(f"USD/CAD refresh failed: {exc}")
        usd_cad = previous.get("usd_cad")

    output = {
        "updated_at": datetime.now(
            timezone.utc
        ).isoformat(),
        "stocks": stocks,
        "usd_cad": usd_cad
    }

    with CACHE_FILE.open(
        "w", encoding="utf-8"
    ) as f:
        json.dump(output, f, indent=2)

    print(f"Saved {CACHE_FILE}")


if __name__ == "__main__":
    main()
