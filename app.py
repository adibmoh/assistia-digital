# -*- coding: utf-8 -*-
"""
Top 5 Best + Worst Open Movers + Last Hour
--------------------------
Standalone Streamlit dashboard for the existing Trading Advisor folder.

Ranking rules:
    day_change = (latest_regular_session_price / previous_regular_close - 1) * 100
    since_open = (latest_regular_session_price / regular_session_open - 1) * 100

Data sources:
- Polygon/Massive minute aggregates (same POLYGON_API_KEY as the advisor)
- yfinance minute data

The app only uses regular US market session bars (09:30-16:00 America/New_York).
Premarket / after-hours bars are intentionally excluded from the ranking.
"""

from __future__ import annotations

import os
import re
import time
from html import escape
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, asdict
from datetime import datetime, time as dt_time, timedelta
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple
from zoneinfo import ZoneInfo

import pandas as pd
import requests
import streamlit as st
import yfinance as yf


ROOT = Path(__file__).resolve().parent
ENV_PATH = ROOT / ".env.scheduler"
WATCHLIST_PATH = ROOT / "top5_watchlist.txt"
NY = ZoneInfo("America/New_York")
ZURICH = ZoneInfo("Europe/Zurich")
REGULAR_OPEN = dt_time(9, 30)
REGULAR_CLOSE = dt_time(16, 0)
DEFAULT_BASE_URL = "https://api.polygon.io"

DEFAULT_TICKERS = [
    "NVDA", "AMD", "AVGO", "MU", "MRVL", "ARM", "QCOM", "INTC", "TSM", "ASML",
    "AMAT", "LRCX", "KLAC", "ON", "NXPI", "ADI", "TXN", "SMCI", "WDC", "STX",
    "XOM", "CVX", "COP", "OXY", "SLB", "VLO", "MPC", "PSX", "LNG",
    "MSFT", "ORCL", "ADBE", "CRM", "NOW", "SNOW", "DDOG", "PLTR", "NET", "CRWD",
    "PANW", "ZS", "APP", "SHOP", "AAPL", "DELL", "HPQ", "HPE", "IBM", "ANET",
    "NTAP", "SNDK", "SPCX", "TSLA", "RIVN", "NIO", "LI", "BYDDY", "GM", "F",
    "GOOGL", "META", "AMZN",
]


# Market/sector context used only by the Advisor layer.
# The regular-session pricing/ranking engine remains unchanged.
CONTEXT_SYMBOLS = ("SPY", "QQQ", "SOXX", "XLE", "IGV", "XLY")

SECTOR_ETF_BY_TICKER = {
    # Semiconductors / semiconductor equipment / storage / AI hardware
    "NVDA": "SOXX", "AMD": "SOXX", "AVGO": "SOXX", "MU": "SOXX",
    "MRVL": "SOXX", "ARM": "SOXX", "QCOM": "SOXX", "INTC": "SOXX",
    "TSM": "SOXX", "ASML": "SOXX", "AMAT": "SOXX", "LRCX": "SOXX",
    "KLAC": "SOXX", "ON": "SOXX", "NXPI": "SOXX", "ADI": "SOXX",
    "TXN": "SOXX", "SMCI": "SOXX", "WDC": "SOXX", "STX": "SOXX",
    "SNDK": "SOXX",

    # Energy
    "XOM": "XLE", "CVX": "XLE", "COP": "XLE", "OXY": "XLE",
    "SLB": "XLE", "VLO": "XLE", "MPC": "XLE", "PSX": "XLE", "LNG": "XLE",

    # Software / cyber / cloud
    "MSFT": "IGV", "ORCL": "IGV", "ADBE": "IGV", "CRM": "IGV",
    "NOW": "IGV", "SNOW": "IGV", "DDOG": "IGV", "PLTR": "IGV",
    "NET": "IGV", "CRWD": "IGV", "PANW": "IGV", "ZS": "IGV",
    "APP": "IGV", "SHOP": "IGV",

    # Consumer / autos / EV
    "TSLA": "XLY", "RIVN": "XLY", "NIO": "XLY", "LI": "XLY",
    "BYDDY": "XLY", "GM": "XLY", "F": "XLY", "AMZN": "XLY",

    # Large-cap tech / hardware / internet: QQQ is the cleaner context.
    "AAPL": "QQQ", "DELL": "QQQ", "HPQ": "QQQ", "HPE": "QQQ",
    "IBM": "QQQ", "ANET": "QQQ", "NTAP": "QQQ",
    "GOOGL": "QQQ", "META": "QQQ",

    # Fallback candidates / ETFs / unusual names
    "SPCX": "SPY",
}



LANG = "en"

I18N = {
    "en": {
        "page_title": "Trading Advisor — compact",
        "hero_desc": "Top/Bottom since 09:30 ET · last hour · short-term Buy/Sell momentum signals. Polygon/Massive primary.",
        "settings": "Settings",
        "device_lang": "Device language",
        "stock_list": "Stock list",
        "stock_help": "One stock per line, or separated by commas.",
        "save": "💾 Save",
        "refresh": "🔄 Refresh",
        "saved": "List saved for this instance. On Cloud, edit top5_watchlist.txt in GitHub to make it permanent.",
        "tickers": "stocks in the list",
        "cache": "45 s cache to avoid overloading data providers.",
        "empty": "The list is empty.",
        "before_open": "The ranking is designed for the regular US session. Before 09:30 ET, the app does not use pre-market data to calculate performance since the open.",
        "loading": "Reading yfinance and Polygon/Massive…",
        "no_data": "No regular-session data available for today.",
        "source_last": "Latest source data",
        "unavailable": "unavailable",
        "age": "age",
        "min": "min",
        "key_detected": "key detected",
        "key_missing": "key missing",
        "poly_data": "Polygon tickers with data",
        "yf_data": "yfinance tickers with data",
        "ranked": "Ranked stocks",
        "latest_data": "Latest data",
        "buy_title": "⚡ Top 5 Buy Now — momentum in recent minutes",
        "sell_title": "🔻 Top 5 Sell Now — bearish momentum in recent minutes",
        "buy_none": "No stock currently meets the positive 5 min + 15 min momentum criteria with data less than 5 minutes old.",
        "sell_none": "No stock currently meets the negative 5 min + 15 min momentum criteria with data less than 5 minutes old.",
        "buy_caption": "Technical signal: score = 55% 5-min momentum + 30% 15-min momentum + 15% 60-min momentum. This is not a buy order or a guarantee of performance.",
        "sell_caption": "Bearish technical signal: score = 55% 5-min momentum + 30% 15-min momentum + 15% 60-min momentum, ranked from most negative upward. This is not a sell order or a guarantee of future decline.",
        "hour_top": "⏱️ Top 5 — last hour",
        "hour_top_first": "⏱️ Top 5 — since open (first hour)",
        "hour_bottom": "⏱️📉 Bottom 5 — last hour",
        "hour_bottom_first": "⏱️📉 Bottom 5 — since open (first hour)",
        "day_top": "🚀 Top 5 — today's performance",
        "day_bottom": "📉 Bottom 5 — today's performance",
        "hour_none": "Not enough regular-session data yet to calculate recent performance.",
        "first_hour": "During the first hour of trading, the last-hour window starts at the 09:30 ET open.",
        "full_rank": "Full ranking — best to worst",
        "rank": "Rank",
        "since_open": "% since open",
        "day_change": "% day",
        "previous_close": "Previous close",
        "last_hour": "% last hour",
        "open": "Open",
        "current": "Current price",
        "last_data": "Latest data",
        "gap": "P-Y gap",
        "diagnostic": "Data-source diagnostics",
        "diag_text": "Rankings use Polygon/Massive when a regular-session bar is available; otherwise yfinance is used as fallback. The P-Y gap column helps identify disagreement between providers.",
        "key_yes": "yes",
        "key_no": "no",
        "poly_no_data": "Polygon/Massive — tickers without usable data",
        "yf_no_data": "yfinance — tickers without usable data",
        "definitions": "Definitions: % day = (latest regular price / previous regular-session close − 1) × 100. % since open = (latest regular price / 09:30 ET open − 1) × 100. 5 min / 15 min = very short-term change; % last hour = change between the latest price and the reference price about 60 minutes earlier. During the first hour, the reference is the 09:30 ET open. Pre-market and after-hours are excluded. Buy/Sell signals are technical momentum indicators, not orders or investment recommendations.",
        "signal": "Signal",
        "score": "Score",
        "ref": "Ref.",
        "market_closed_today": "Regular market closed today",
        "before_regular": "Before regular open",
        "market_closed": "Regular market closed",
        "closed_title": "US market is closed",
        "closed_message": "Regular US market hours are 09:30–16:00 ET, Monday to Friday, excluding market holidays.",
        "closed_news_only": "Recent news is shown while the market is closed. If pre-market quotes are available, a pre-market ranking is shown at the end.",
        "premarket_title": "🌅 Pre-market ranking — best to worst",
        "premarket_none": "No pre-market quotes are currently available.",
        "premarket_caption": "Pre-market change is measured versus the previous regular-session close. Extended-hours quotes can be less liquid and more volatile than regular-session prices.",
        "premarket_change": "% pre-market",
        "premarket_prev_close": "Previous close",
        "premarket_price": "Pre-market price",
        "premarket_time": "Latest pre-market data",
        "afterhours_title": "🌙 After-hours ranking — best to worst",
        "afterhours_none": "No after-hours quotes are currently available.",
        "afterhours_caption": "After-hours change is measured versus the regular-session close. Extended-hours quotes can be less liquid and more volatile than regular-session prices.",
        "afterhours_change": "% after-hours",
        "afterhours_close": "Regular close",
        "afterhours_price": "After-hours price",
        "afterhours_time": "Latest after-hours data",
        "market_open": "Regular market open",
        "news_title": "📰 Key news",
        "news_loading": "Checking recent market-moving news for your stocks…",
        "news_none": "No potentially market-moving news found for your watchlist in the recent window.",
        "news_caption": "Recent Yahoo Finance headlines for your watchlist. Earnings, guidance, regulation/politics, legal issues, deals, analyst actions and rumor-like reports are prioritized. Headlines are not independently verified.",
        "news_rumor": "RUMOR / UNVERIFIED",
        "news_earnings": "Earnings / guidance",
        "news_politics": "Politics / regulation",
        "news_legal": "Legal / investigation",
        "news_deal": "Deal / contract",
        "news_analyst": "Analyst action",
        "news_corporate": "Corporate event",
        "news_other": "Potential impact",
        "news_source": "Source",
        "news_age_hours": "h ago",
        "news_window": "Scanning roughly the last 36 hours",
        "news_useful_caption": "Only the most relevant recent catalysts for your watchlist.",
        "news_impact_high": "HIGH",
        "news_impact_medium": "MEDIUM",
        "news_direction_positive": "positive",
        "news_direction_negative": "negative",
        "news_direction_neutral": "unclear",
        "ai_title": "🧠 AI Market Analysis — Buy / Sell",
        "ai_caption": "Multi-horizon analysis using 5m, 15m, 1h and day trends, relative strength vs market/sector, volume, source agreement, recent news and signal persistence. Signal strength is not a probability of profit.",
        "ai_stale": "No directional analysis: market data is stale or insufficient.",
        "ai_buy": "BUY",
        "ai_strong_buy": "STRONG BUY",
        "ai_sell": "SELL",
        "ai_strong_sell": "STRONG SELL",
        "ai_watch": "WATCH",
        "ai_strength": "Signal strength",
        "ai_reasons": "Reasons",
        "ai_warnings": "Warnings",
        "ai_volume": "Recent volume",
        "ai_news": "News",
        "ai_no_news": "No directional news catalyst detected",
        "ai_fresh": "Fresh data",
        "ai_source_agree": "Polygon/yfinance broadly agree",
        "ai_source_disagree": "Polygon/yfinance disagreement",
        "ai_extended": "Price is already extended; chase risk is elevated",
        "ai_rumor": "Rumor-like headline lowers confidence",
        "ai_top_candidates": "Top directional candidates",
        "ai_no_reco": "No recommendation right now.",
        "ai_method": "Method: short-term trend + day trend + relative strength + volume + news + source quality. Relative strength is capped so it cannot override price action. Persistence adjusts evidence quality, not direction.",

        "stale_error": "⚠️ ERROR: Market data is stale. Latest source data is {age:.1f} minutes old (limit: 5 minutes).",
    },
    "fr": {
        "page_title": "Trading Advisor — compact",
        "hero_desc": "Top/Bottom depuis 09:30 ET · dernière heure · signaux Buy/Sell de momentum court terme. Polygon/Massive prioritaire.",
        "settings": "Paramètres",
        "device_lang": "Langue de l’appareil",
        "stock_list": "Stock list",
        "stock_help": "Une action par ligne, ou séparées par virgules.",
        "save": "💾 Sauver",
        "refresh": "🔄 Actualiser",
        "saved": "Liste sauvée pour cette instance. Sur le Cloud, modifie top5_watchlist.txt dans GitHub pour la rendre permanente.",
        "tickers": "titres dans la liste",
        "cache": "Cache 45 s pour éviter de surcharger les fournisseurs.",
        "empty": "La liste est vide.",
        "before_open": "Le classement est prévu pour la session régulière US. Avant 09:30 ET, l'application n'utilise pas le pré-market pour calculer la performance depuis l'ouverture.",
        "loading": "Lecture de yfinance et Polygon/Massive…",
        "no_data": "Aucune donnée de session régulière disponible pour aujourd'hui.",
        "source_last": "Dernière donnée source",
        "unavailable": "indisponible",
        "age": "âge",
        "min": "min",
        "key_detected": "clé détectée",
        "key_missing": "clé absente",
        "poly_data": "Tickers Polygon avec données",
        "yf_data": "Tickers yfinance avec données",
        "ranked": "Titres classés",
        "latest_data": "Dernière donnée",
        "buy_title": "⚡ Top 5 Buy Now — momentum dernières minutes",
        "sell_title": "🔻 Top 5 Sell Now — momentum baissier dernières minutes",
        "buy_none": "Aucun titre ne remplit actuellement les critères de momentum positif 5 min + 15 min avec une donnée de moins de 5 minutes.",
        "sell_none": "Aucun titre ne remplit actuellement les critères de momentum négatif 5 min + 15 min avec une donnée de moins de 5 minutes.",
        "buy_caption": "Signal technique : score = 55% momentum 5 min + 30% momentum 15 min + 15% momentum 60 min. Ce n'est pas un ordre d'achat ni une garantie de performance.",
        "sell_caption": "Signal technique baissier : score = 55% momentum 5 min + 30% momentum 15 min + 15% momentum 60 min, trié du plus négatif au moins négatif. Ce n'est pas un ordre de vente ni une garantie de baisse future.",
        "hour_top": "⏱️ Top 5 — dernière heure",
        "hour_top_first": "⏱️ Top 5 — depuis l’ouverture (première heure)",
        "hour_bottom": "⏱️📉 Bottom 5 — dernière heure",
        "hour_bottom_first": "⏱️📉 Bottom 5 — depuis l’ouverture (première heure)",
        "day_top": "🚀 Top 5 — performance du jour",
        "day_bottom": "📉 Bottom 5 — performance du jour",
        "hour_none": "Pas encore assez de données régulières pour calculer la performance récente.",
        "first_hour": "Pendant la première heure de séance, la fenêtre dernière heure part de l'ouverture à 09:30 ET.",
        "full_rank": "Classement complet — du meilleur au pire",
        "rank": "Rang",
        "since_open": "% depuis ouverture",
        "day_change": "% jour",
        "previous_close": "Clôture précédente",
        "last_hour": "% dernière heure",
        "open": "Ouverture",
        "current": "Prix actuel",
        "last_data": "Dernière donnée",
        "gap": "Écart P-Y",
        "diagnostic": "Diagnostic des sources",
        "diag_text": "Les classements utilisent Polygon/Massive lorsqu'une bougie régulière est disponible ; sinon yfinance prend le relais. La colonne Écart P-Y permet de repérer un désaccord entre fournisseurs.",
        "key_yes": "oui",
        "key_no": "non",
        "poly_no_data": "Polygon/Massive — titres sans donnée exploitable",
        "yf_no_data": "yfinance — titres sans donnée exploitable",
        "definitions": "Définitions : % jour = (dernier prix régulier / clôture régulière précédente − 1) × 100. % depuis ouverture = (dernier prix régulier / ouverture 09:30 ET − 1) × 100. 5 min / 15 min = variation très court terme ; % dernière heure = variation entre le dernier prix et le prix de référence environ 60 minutes plus tôt. Pendant la première heure, la référence est l'ouverture 09:30 ET. Le pré-market et l'after-hours sont exclus. Les signaux Buy/Sell sont des indicateurs techniques de momentum, pas des ordres ni des recommandations d'investissement.",
        "signal": "Signal",
        "score": "Score",
        "ref": "Réf.",
        "market_closed_today": "Marché régulier fermé aujourd'hui",
        "before_regular": "Avant ouverture régulière",
        "market_closed": "Marché régulier fermé",
        "closed_title": "Le marché américain est fermé",
        "closed_message": "Les heures normales du marché américain sont 09:30–16:00 ET, du lundi au vendredi, hors jours fériés de marché.",
        "closed_news_only": "Pendant la fermeture du marché, les actualités récentes sont affichées. Si des cours pré-market sont disponibles, un classement pré-market apparaît à la fin.",
        "premarket_title": "🌅 Classement pré-market — du meilleur au pire",
        "premarket_none": "Aucune cotation pré-market n'est disponible actuellement.",
        "premarket_caption": "La variation pré-market est calculée par rapport à la clôture de la séance régulière précédente. Les cours hors séance peuvent être moins liquides et plus volatils.",
        "premarket_change": "% pré-market",
        "premarket_prev_close": "Clôture précédente",
        "premarket_price": "Prix pré-market",
        "premarket_time": "Dernière donnée pré-market",
        "afterhours_title": "🌙 Classement after-hours — du meilleur au pire",
        "afterhours_none": "Aucune cotation after-hours n'est disponible actuellement.",
        "afterhours_caption": "La variation after-hours est calculée par rapport à la clôture de la séance régulière. Les cours hors séance peuvent être moins liquides et plus volatils.",
        "afterhours_change": "% after-hours",
        "afterhours_close": "Clôture régulière",
        "afterhours_price": "Prix after-hours",
        "afterhours_time": "Dernière donnée after-hours",
        "market_open": "Marché régulier ouvert",
        "news_title": "📰 Actualités pouvant impacter votre liste",
        "news_loading": "Recherche des actualités récentes pouvant impacter vos actions…",
        "news_none": "Aucune actualité potentiellement importante trouvée récemment pour votre liste.",
        "news_caption": "Titres récents de Yahoo Finance liés à votre liste. Résultats, guidance, politique/réglementation, juridique, opérations, analystes et rumeurs sont prioritaires. Les titres ne sont pas vérifiés indépendamment.",
        "news_rumor": "RUMEUR / NON VÉRIFIÉE",
        "news_earnings": "Résultats / guidance",
        "news_politics": "Politique / réglementation",
        "news_legal": "Juridique / enquête",
        "news_deal": "Opération / contrat",
        "news_analyst": "Avis analyste",
        "news_corporate": "Événement société",
        "news_other": "Impact potentiel",
        "news_source": "Source",
        "news_age_hours": "h",
        "news_window": "Analyse d'environ les 36 dernières heures",
        "news_useful_caption": "Seulement les catalyseurs récents les plus pertinents pour votre liste.",
        "news_impact_high": "FORT",
        "news_impact_medium": "MOYEN",
        "news_direction_positive": "positif",
        "news_direction_negative": "négatif",
        "news_direction_neutral": "incertain",
        "ai_title": "🧠 Analyse marché IA — Acheter / Vendre",
        "ai_caption": "Analyse multi-horizon utilisant 5 min, 15 min, 1 h et jour, la force relative au marché/secteur, le volume, l’accord des sources, les actualités et la persistance du signal. La force du signal n’est pas une probabilité de gain.",
        "ai_stale": "Pas d'analyse directionnelle : données de marché trop anciennes ou insuffisantes.",
        "ai_buy": "ACHAT",
        "ai_strong_buy": "ACHAT FORT",
        "ai_sell": "VENTE",
        "ai_strong_sell": "VENTE FORTE",
        "ai_watch": "SURVEILLER",
        "ai_strength": "Force du signal",
        "ai_reasons": "Raisons",
        "ai_warnings": "Alertes",
        "ai_volume": "Volume récent",
        "ai_news": "Actualités",
        "ai_no_news": "Aucun catalyseur directionnel détecté dans les actualités",
        "ai_fresh": "Données fraîches",
        "ai_source_agree": "Polygon/yfinance sont globalement d'accord",
        "ai_source_disagree": "Désaccord Polygon/yfinance",
        "ai_extended": "Le prix est déjà fortement étendu ; risque de poursuite tardive",
        "ai_rumor": "Une rumeur réduit la confiance",
        "ai_top_candidates": "Meilleurs candidats directionnels",
        "ai_no_reco": "Aucune recommandation pour le moment.",
        "ai_method": "Méthode : tendance court terme + tendance du jour + force relative + volume + actualités + qualité des sources. La force relative est plafonnée pour ne pas dominer le mouvement du prix. La persistance ajuste la qualité du signal, pas sa direction.",

        "stale_error": "⚠️ ERREUR : les données de marché ne sont pas fraîches. La dernière donnée source date de {age:.1f} minutes (limite : 5 minutes).",
    },
    "de": {
        "page_title": "Trading Advisor — kompakt",
        "hero_desc": "Top/Bottom seit 09:30 ET · letzte Stunde · kurzfristige Buy/Sell-Momentum-Signale. Polygon/Massive primär.",
        "settings": "Einstellungen", "device_lang": "Gerätesprache", "stock_list": "Aktienliste",
        "stock_help": "Eine Aktie pro Zeile oder durch Kommas getrennt.", "save": "💾 Speichern", "refresh": "🔄 Aktualisieren",
        "saved": "Liste für diese Instanz gespeichert. In der Cloud top5_watchlist.txt in GitHub ändern, um sie dauerhaft zu speichern.",
        "tickers": "Aktien in der Liste", "cache": "45-Sekunden-Cache zur Entlastung der Datenanbieter.", "empty": "Die Liste ist leer.",
        "before_open": "Das Ranking ist für die reguläre US-Sitzung vorgesehen. Vor 09:30 ET werden Pre-Market-Daten nicht für die Performance seit Eröffnung verwendet.",
        "loading": "yfinance und Polygon/Massive werden gelesen…", "no_data": "Heute sind keine Daten der regulären Sitzung verfügbar.",
        "source_last": "Neueste Quelldaten", "unavailable": "nicht verfügbar", "age": "Alter", "min": "Min.",
        "key_detected": "Schlüssel erkannt", "key_missing": "Schlüssel fehlt", "poly_data": "Polygon-Ticker mit Daten", "yf_data": "yfinance-Ticker mit Daten",
        "ranked": "Gerankte Aktien", "latest_data": "Neueste Daten",
        "buy_title": "⚡ Top 5 Buy Now — Momentum der letzten Minuten", "sell_title": "🔻 Top 5 Sell Now — negatives Momentum der letzten Minuten",
        "buy_none": "Derzeit erfüllt keine Aktie die positiven 5-Min.- und 15-Min.-Momentumkriterien mit Daten jünger als 5 Minuten.",
        "sell_none": "Derzeit erfüllt keine Aktie die negativen 5-Min.- und 15-Min.-Momentumkriterien mit Daten jünger als 5 Minuten.",
        "buy_caption": "Technisches Signal: Score = 55% 5-Min.-Momentum + 30% 15-Min.-Momentum + 15% 60-Min.-Momentum. Kein Kaufauftrag und keine Performance-Garantie.",
        "sell_caption": "Negatives technisches Signal mit derselben 55/30/15-Gewichtung. Kein Verkaufsauftrag und keine Garantie für weitere Kursverluste.",
        "hour_top": "⏱️ Top 5 — letzte Stunde", "hour_bottom": "⏱️📉 Bottom 5 — letzte Stunde",
        "day_top": "🚀 Top 5 — Tagesperformance", "day_bottom": "📉 Bottom 5 — Tagesperformance",
        "hour_none": "Noch nicht genügend reguläre Sitzungsdaten für die jüngste Performance.",
        "first_hour": "Während der ersten Handelsstunde beginnt das Stundenfenster bei der Eröffnung um 09:30 ET.",
        "full_rank": "Gesamtranking — beste bis schlechteste", "rank": "Rang", "since_open": "% seit Eröffnung", "last_hour": "% letzte Stunde",
        "open": "Eröffnung", "current": "Aktueller Preis", "last_data": "Neueste Daten", "gap": "P-Y-Differenz",
        "diagnostic": "Datenquellen-Diagnose", "diag_text": "Polygon/Massive wird verwendet, wenn eine reguläre Kerze verfügbar ist; andernfalls dient yfinance als Fallback.",
        "key_yes": "ja", "key_no": "nein", "poly_no_data": "Polygon/Massive — Ticker ohne nutzbare Daten", "yf_no_data": "yfinance — Ticker ohne nutzbare Daten",
        "definitions": "Definitionen: % seit Eröffnung basiert auf dem letzten regulären Preis relativ zur 09:30-ET-Eröffnung. 5/15 Min. zeigen sehr kurzfristige Änderungen; letzte Stunde nutzt einen Referenzpreis etwa 60 Minuten zuvor. Pre-Market und After-Hours sind ausgeschlossen. Buy/Sell-Signale sind technische Momentum-Indikatoren, keine Orders oder Anlageempfehlungen.",
        "signal": "Signal", "score": "Score", "ref": "Ref.",
        "market_closed_today": "Regulärer Markt heute geschlossen", "before_regular": "Vor regulärer Eröffnung", "market_closed": "Regulärer Markt geschlossen", "market_open": "Regulärer Markt geöffnet", "stale_error": "⚠️ FEHLER: Die Marktdaten sind veraltet. Die neuesten Quelldaten sind {age:.1f} Minuten alt (Limit: 5 Minuten).",
    },
    "es": {
        "page_title": "Trading Advisor — compacto", "hero_desc": "Top/Bottom desde 09:30 ET · última hora · señales Buy/Sell de momentum a corto plazo. Polygon/Massive prioritario.",
        "settings": "Configuración", "device_lang": "Idioma del dispositivo", "stock_list": "Lista de acciones", "stock_help": "Una acción por línea o separadas por comas.",
        "save": "💾 Guardar", "refresh": "🔄 Actualizar", "saved": "Lista guardada para esta instancia. En Cloud, edita top5_watchlist.txt en GitHub para hacerla permanente.",
        "tickers": "acciones en la lista", "cache": "Caché de 45 s para no sobrecargar los proveedores.", "empty": "La lista está vacía.",
        "before_open": "El ranking está pensado para la sesión regular de EE. UU. Antes de 09:30 ET no se usa el pre-market para calcular el rendimiento desde la apertura.",
        "loading": "Leyendo yfinance y Polygon/Massive…", "no_data": "No hay datos de sesión regular disponibles para hoy.",
        "source_last": "Último dato de fuente", "unavailable": "no disponible", "age": "antigüedad", "min": "min",
        "key_detected": "clave detectada", "key_missing": "clave ausente", "poly_data": "Tickers Polygon con datos", "yf_data": "Tickers yfinance con datos",
        "ranked": "Acciones clasificadas", "latest_data": "Último dato",
        "buy_title": "⚡ Top 5 Buy Now — momentum de los últimos minutos", "sell_title": "🔻 Top 5 Sell Now — momentum bajista de los últimos minutos",
        "buy_none": "Ninguna acción cumple ahora los criterios positivos de 5 min + 15 min con datos de menos de 5 minutos.",
        "sell_none": "Ninguna acción cumple ahora los criterios negativos de 5 min + 15 min con datos de menos de 5 minutos.",
        "buy_caption": "Señal técnica: 55% momentum 5 min + 30% 15 min + 15% 60 min. No es una orden de compra ni garantía de rendimiento.",
        "sell_caption": "Señal técnica bajista con la misma ponderación 55/30/15. No es una orden de venta ni garantía de caída futura.",
        "hour_top": "⏱️ Top 5 — última hora", "hour_bottom": "⏱️📉 Bottom 5 — última hora",
        "day_top": "🚀 Top 5 — rendimiento del día", "day_bottom": "📉 Bottom 5 — rendimiento del día",
        "hour_none": "Aún no hay suficientes datos de sesión regular para calcular el rendimiento reciente.",
        "first_hour": "Durante la primera hora, la ventana de una hora comienza en la apertura de 09:30 ET.",
        "full_rank": "Clasificación completa — mejor a peor", "rank": "Rango", "since_open": "% desde apertura", "last_hour": "% última hora",
        "open": "Apertura", "current": "Precio actual", "last_data": "Último dato", "gap": "Diferencia P-Y",
        "diagnostic": "Diagnóstico de fuentes", "diag_text": "Se usa Polygon/Massive cuando hay una vela regular disponible; si no, yfinance actúa como respaldo.",
        "key_yes": "sí", "key_no": "no", "poly_no_data": "Polygon/Massive — tickers sin datos utilizables", "yf_no_data": "yfinance — tickers sin datos utilizables",
        "definitions": "Definiciones: % desde apertura compara el último precio regular con la apertura de 09:30 ET. 5/15 min son variaciones muy cortas; última hora usa un precio de referencia de unos 60 minutos antes. Se excluyen pre-market y after-hours. Las señales Buy/Sell son indicadores técnicos de momentum, no órdenes ni recomendaciones de inversión.",
        "signal": "Señal", "score": "Puntuación", "ref": "Ref.",
        "market_closed_today": "Mercado regular cerrado hoy", "before_regular": "Antes de la apertura regular", "market_closed": "Mercado regular cerrado", "market_open": "Mercado regular abierto", "stale_error": "⚠️ ERROR: Los datos de mercado no están actualizados. El último dato tiene {age:.1f} minutos (límite: 5 minutos).",
    },
    "ar": {
        "page_title": "Trading Advisor — مدمج", "hero_desc": "أفضل/أسوأ منذ 09:30 ET · آخر ساعة · إشارات زخم Buy/Sell قصيرة الأجل. Polygon/Massive هو المصدر الأساسي.",
        "settings": "الإعدادات", "device_lang": "لغة الجهاز", "stock_list": "قائمة الأسهم", "stock_help": "سهم واحد في كل سطر أو مفصولة بفواصل.",
        "save": "💾 حفظ", "refresh": "🔄 تحديث", "saved": "تم حفظ القائمة لهذه النسخة. على Cloud عدّل top5_watchlist.txt في GitHub لجعلها دائمة.",
        "tickers": "أسهم في القائمة", "cache": "ذاكرة مؤقتة 45 ثانية لتخفيف الحمل على مزودي البيانات.", "empty": "القائمة فارغة.",
        "before_open": "الترتيب مخصص للجلسة الأمريكية العادية. قبل 09:30 ET لا تُستخدم بيانات ما قبل السوق لحساب الأداء منذ الافتتاح.",
        "loading": "جارٍ قراءة yfinance وPolygon/Massive…", "no_data": "لا تتوفر بيانات جلسة عادية لليوم.",
        "source_last": "أحدث بيانات المصدر", "unavailable": "غير متاح", "age": "العمر", "min": "دقيقة",
        "key_detected": "تم اكتشاف المفتاح", "key_missing": "المفتاح غير موجود", "poly_data": "رموز Polygon ذات البيانات", "yf_data": "رموز yfinance ذات البيانات",
        "ranked": "الأسهم المرتبة", "latest_data": "أحدث البيانات",
        "buy_title": "⚡ أفضل 5 Buy Now — زخم الدقائق الأخيرة", "sell_title": "🔻 أفضل 5 Sell Now — زخم هابط في الدقائق الأخيرة",
        "buy_none": "لا يوجد سهم يحقق حاليًا شروط الزخم الإيجابي 5 دقائق + 15 دقيقة ببيانات أحدث من 5 دقائق.",
        "sell_none": "لا يوجد سهم يحقق حاليًا شروط الزخم السلبي 5 دقائق + 15 دقيقة ببيانات أحدث من 5 دقائق.",
        "buy_caption": "إشارة فنية بوزن 55% لـ5 دقائق + 30% لـ15 دقيقة + 15% لـ60 دقيقة. ليست أمر شراء ولا ضمانًا للأداء.",
        "sell_caption": "إشارة فنية هابطة بنفس أوزان 55/30/15. ليست أمر بيع ولا ضمانًا لمزيد من الانخفاض.",
        "hour_top": "⏱️ أفضل 5 — آخر ساعة", "hour_bottom": "⏱️📉 أسوأ 5 — آخر ساعة",
        "day_top": "🚀 أفضل 5 — أداء اليوم", "day_bottom": "📉 أسوأ 5 — أداء اليوم",
        "hour_none": "لا توجد بعد بيانات جلسة عادية كافية لحساب الأداء الأخير.",
        "first_hour": "خلال الساعة الأولى يبدأ نطاق الساعة من افتتاح 09:30 ET.",
        "full_rank": "الترتيب الكامل — من الأفضل إلى الأسوأ", "rank": "الترتيب", "since_open": "% منذ الافتتاح", "last_hour": "% آخر ساعة",
        "open": "الافتتاح", "current": "السعر الحالي", "last_data": "أحدث البيانات", "gap": "فارق P-Y",
        "diagnostic": "تشخيص مصادر البيانات", "diag_text": "يُستخدم Polygon/Massive عند توفر شمعة جلسة عادية، وإلا يُستخدم yfinance كبديل.",
        "key_yes": "نعم", "key_no": "لا", "poly_no_data": "Polygon/Massive — رموز بلا بيانات قابلة للاستخدام", "yf_no_data": "yfinance — رموز بلا بيانات قابلة للاستخدام",
        "definitions": "التعريفات: الأداء منذ الافتتاح يقارن أحدث سعر عادي بافتتاح 09:30 ET. 5/15 دقيقة تغيّر قصير جدًا؛ آخر ساعة تستخدم سعرًا مرجعيًا قبل نحو 60 دقيقة. يتم استبعاد ما قبل السوق وما بعده. إشارات Buy/Sell مؤشرات زخم فنية وليست أوامر أو توصيات استثمارية.",
        "signal": "إشارة", "score": "النتيجة", "ref": "مرجع",
        "market_closed_today": "السوق العادي مغلق اليوم", "before_regular": "قبل الافتتاح العادي", "market_closed": "السوق العادي مغلق", "market_open": "السوق العادي مفتوح", "stale_error": "⚠️ خطأ: بيانات السوق قديمة. أحدث بيانات المصدر عمرها {age:.1f} دقيقة (الحد: 5 دقائق).",
    },
    "zh": {
        "page_title": "Trading Advisor — 紧凑版", "hero_desc": "09:30 ET 开盘以来 Top/Bottom · 最近一小时 · 短期 Buy/Sell 动量信号。Polygon/Massive 优先。",
        "settings": "设置", "device_lang": "设备语言", "stock_list": "股票列表", "stock_help": "每行一只股票，或用逗号分隔。",
        "save": "💾 保存", "refresh": "🔄 刷新", "saved": "列表已保存到此实例。Cloud 上请在 GitHub 修改 top5_watchlist.txt 以永久保存。",
        "tickers": "只股票", "cache": "45 秒缓存，避免数据供应商过载。", "empty": "列表为空。",
        "before_open": "排名针对美国常规交易时段。09:30 ET 之前不会使用盘前数据计算开盘以来表现。",
        "loading": "正在读取 yfinance 和 Polygon/Massive…", "no_data": "今天没有可用的常规交易时段数据。",
        "source_last": "最新源数据", "unavailable": "不可用", "age": "数据年龄", "min": "分钟",
        "key_detected": "已检测到密钥", "key_missing": "缺少密钥", "poly_data": "有 Polygon 数据的股票", "yf_data": "有 yfinance 数据的股票",
        "ranked": "已排名股票", "latest_data": "最新数据",
        "buy_title": "⚡ Buy Now 前 5 — 最近几分钟动量", "sell_title": "🔻 Sell Now 前 5 — 最近几分钟下行动量",
        "buy_none": "当前没有股票同时满足 5 分钟和 15 分钟正动量且数据新鲜度小于 5 分钟。",
        "sell_none": "当前没有股票同时满足 5 分钟和 15 分钟负动量且数据新鲜度小于 5 分钟。",
        "buy_caption": "技术信号：55%×5分钟 + 30%×15分钟 + 15%×60分钟。不是买入指令，也不保证表现。",
        "sell_caption": "下行技术信号采用相同 55/30/15 权重。不是卖出指令，也不保证未来继续下跌。",
        "hour_top": "⏱️ 前 5 — 最近一小时", "hour_bottom": "⏱️📉 后 5 — 最近一小时",
        "day_top": "🚀 前 5 — 今日表现", "day_bottom": "📉 后 5 — 今日表现",
        "hour_none": "常规交易数据暂不足以计算最近表现。", "first_hour": "交易第一小时内，一小时窗口从 09:30 ET 开盘开始。",
        "full_rank": "完整排名 — 从最好到最差", "rank": "排名", "since_open": "% 开盘以来", "last_hour": "% 最近一小时",
        "open": "开盘价", "current": "当前价格", "last_data": "最新数据", "gap": "P-Y 差异",
        "diagnostic": "数据源诊断", "diag_text": "有常规交易数据时优先使用 Polygon/Massive，否则使用 yfinance 作为备用。",
        "key_yes": "是", "key_no": "否", "poly_no_data": "Polygon/Massive — 无可用数据股票", "yf_no_data": "yfinance — 无可用数据股票",
        "definitions": "定义：开盘以来表现将最新常规交易价格与 09:30 ET 开盘价比较。5/15 分钟为极短期变化；最近一小时使用约 60 分钟前的参考价。盘前和盘后均排除。Buy/Sell 是技术动量指标，不是交易指令或投资建议。",
        "signal": "信号", "score": "评分", "ref": "参考",
        "market_closed_today": "今日常规市场休市", "before_regular": "常规开盘前", "market_closed": "常规市场已收盘", "market_open": "常规市场开放", "stale_error": "⚠️ 错误：市场数据已过期。最新源数据距今 {age:.1f} 分钟（上限：5 分钟）。",
    },
    "hi": {
        "page_title": "Trading Advisor — कॉम्पैक्ट", "hero_desc": "09:30 ET से Top/Bottom · पिछला घंटा · शॉर्ट-टर्म Buy/Sell मोमेंटम संकेत। Polygon/Massive प्राथमिक।",
        "settings": "सेटिंग्स", "device_lang": "डिवाइस भाषा", "stock_list": "स्टॉक सूची", "stock_help": "हर पंक्ति में एक स्टॉक या कॉमा से अलग करें।",
        "save": "💾 सेव", "refresh": "🔄 रिफ्रेश", "saved": "सूची इस इंस्टेंस के लिए सेव हुई। Cloud पर स्थायी करने के लिए GitHub में top5_watchlist.txt संपादित करें।",
        "tickers": "स्टॉक सूची में", "cache": "डेटा प्रदाताओं पर भार कम करने के लिए 45 सेकंड कैश।", "empty": "सूची खाली है।",
        "before_open": "रैंकिंग नियमित US सत्र के लिए है। 09:30 ET से पहले प्री-मार्केट डेटा से ओपन के बाद का प्रदर्शन नहीं निकाला जाता।",
        "loading": "yfinance और Polygon/Massive पढ़े जा रहे हैं…", "no_data": "आज के लिए नियमित सत्र डेटा उपलब्ध नहीं है।",
        "source_last": "नवीनतम स्रोत डेटा", "unavailable": "उपलब्ध नहीं", "age": "आयु", "min": "मिनट",
        "key_detected": "कुंजी मिली", "key_missing": "कुंजी नहीं मिली", "poly_data": "डेटा वाले Polygon टिकर", "yf_data": "डेटा वाले yfinance टिकर",
        "ranked": "रैंक किए गए स्टॉक", "latest_data": "नवीनतम डेटा",
        "buy_title": "⚡ Top 5 Buy Now — हाल की मिनटों का मोमेंटम", "sell_title": "🔻 Top 5 Sell Now — हाल की मिनटों का नकारात्मक मोमेंटम",
        "buy_none": "अभी कोई स्टॉक 5 मिनट + 15 मिनट सकारात्मक मोमेंटम और 5 मिनट से कम पुराने डेटा की शर्तें पूरी नहीं करता।",
        "sell_none": "अभी कोई स्टॉक 5 मिनट + 15 मिनट नकारात्मक मोमेंटम और 5 मिनट से कम पुराने डेटा की शर्तें पूरी नहीं करता।",
        "buy_caption": "तकनीकी संकेत: 55% 5-मिनट + 30% 15-मिनट + 15% 60-मिनट मोमेंटम। यह खरीद आदेश या प्रदर्शन की गारंटी नहीं है।",
        "sell_caption": "नकारात्मक तकनीकी संकेत समान 55/30/15 भार के साथ। यह बिक्री आदेश या आगे गिरावट की गारंटी नहीं है।",
        "hour_top": "⏱️ Top 5 — पिछला घंटा", "hour_bottom": "⏱️📉 Bottom 5 — पिछला घंटा",
        "day_top": "🚀 Top 5 — आज का प्रदर्शन", "day_bottom": "📉 Bottom 5 — आज का प्रदर्शन",
        "hour_none": "हाल का प्रदर्शन निकालने के लिए अभी पर्याप्त नियमित सत्र डेटा नहीं है।",
        "first_hour": "ट्रेडिंग के पहले घंटे में एक-घंटे की विंडो 09:30 ET ओपन से शुरू होती है।",
        "full_rank": "पूरा रैंकिंग — सबसे अच्छा से सबसे खराब", "rank": "रैंक", "since_open": "% ओपन से", "last_hour": "% पिछला घंटा",
        "open": "ओपन", "current": "वर्तमान कीमत", "last_data": "नवीनतम डेटा", "gap": "P-Y अंतर",
        "diagnostic": "डेटा स्रोत डायग्नोस्टिक", "diag_text": "नियमित बार उपलब्ध होने पर Polygon/Massive उपयोग होता है; अन्यथा yfinance बैकअप है।",
        "key_yes": "हाँ", "key_no": "नहीं", "poly_no_data": "Polygon/Massive — उपयोगी डेटा बिना टिकर", "yf_no_data": "yfinance — उपयोगी डेटा बिना टिकर",
        "definitions": "परिभाषाएँ: ओपन से % नवीनतम नियमित कीमत की तुलना 09:30 ET ओपन से करता है। 5/15 मिनट बहुत अल्पकालिक बदलाव हैं; पिछला घंटा लगभग 60 मिनट पहले की संदर्भ कीमत से तुलना करता है। प्री-मार्केट और आफ्टर-आवर्स बाहर हैं। Buy/Sell तकनीकी मोमेंटम संकेत हैं, आदेश या निवेश सलाह नहीं।",
        "signal": "संकेत", "score": "स्कोर", "ref": "संदर्भ",
        "market_closed_today": "आज नियमित बाजार बंद", "before_regular": "नियमित खुलने से पहले", "market_closed": "नियमित बाजार बंद", "market_open": "नियमित बाजार खुला", "stale_error": "⚠️ त्रुटि: मार्केट डेटा ताज़ा नहीं है। नवीनतम स्रोत डेटा {age:.1f} मिनट पुराना है (सीमा: 5 मिनट)।",
    },
}

def tr(key: str) -> str:
    return I18N.get(LANG, I18N["en"]).get(key, I18N["en"].get(key, key))

# -------------------------------------------------------------------
# Market-moving news scanner
# -------------------------------------------------------------------

NEWS_KEYWORDS = {
    "earnings": [
        "earnings", "quarterly", "results", "revenue", "sales", "eps", "profit",
        "loss", "guidance", "forecast", "outlook", "margin", "estimates",
        "résultats", "bénéfice", "chiffre d'affaires",
    ],
    "politics": [
        "tariff", "tariffs", "sanction", "sanctions", "export ban", "export control",
        "regulation", "regulator", "government", "administration", "congress",
        "senate", "white house", "trade war", "china", "taiwan", "eu commission",
        "antitrust", "ftc", "doj", "sec", "policy", "political",
    ],
    "legal": [
        "lawsuit", "sued", "court", "judge", "investigation", "investigates",
        "probe", "subpoena", "fraud", "settlement", "class action", "charges",
    ],
    "deal": [
        "acquisition", "acquire", "merger", "buyout", "takeover", "deal",
        "partnership", "partners with", "contract", "order", "supplier",
        "investment", "stake", "joint venture",
    ],
    "analyst": [
        "upgrade", "downgrade", "price target", "initiates", "coverage",
        "overweight", "underweight", "buy rating", "sell rating",
    ],
    "corporate": [
        "ceo", "cfo", "resign", "resignation", "appointed", "recall",
        "cyberattack", "cyber attack", "outage", "data breach", "bankruptcy",
        "restructuring", "layoffs", "job cuts", "production halt", "factory",
    ],
}

RUMOR_WORDS = [
    "rumor", "rumour", "reportedly", "sources say", "people familiar",
    "considering", "exploring", "in talks", "talks with", "may acquire",
    "could acquire", "said to be", "unconfirmed", "speculation",
]

NEWS_CATEGORY_WEIGHT = {
    "earnings": 5,
    "politics": 5,
    "legal": 5,
    "deal": 4,
    "corporate": 4,
    "analyst": 3,
    "other": 1,
}

def _parse_news_timestamp(value) -> Optional[datetime]:
    if value is None:
        return None
    try:
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(float(value), tz=ZoneInfo("UTC")).astimezone(NY)
        ts = pd.Timestamp(value)
        if ts.tzinfo is None:
            ts = ts.tz_localize("UTC")
        return ts.to_pydatetime().astimezone(NY)
    except Exception:
        return None

def _normalize_news_item(raw: dict, ticker: str) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None

    content = raw.get("content") if isinstance(raw.get("content"), dict) else {}
    title = (content.get("title") or raw.get("title") or "").strip()
    if not title:
        return None

    summary = (
        content.get("summary")
        or content.get("description")
        or raw.get("summary")
        or ""
    ).strip()

    provider = content.get("provider") if isinstance(content.get("provider"), dict) else {}
    publisher = (
        provider.get("displayName")
        or raw.get("publisher")
        or raw.get("provider")
        or "Yahoo Finance"
    )

    canonical = content.get("canonicalUrl") if isinstance(content.get("canonicalUrl"), dict) else {}
    clickthrough = content.get("clickThroughUrl") if isinstance(content.get("clickThroughUrl"), dict) else {}
    link = (
        canonical.get("url")
        or clickthrough.get("url")
        or raw.get("link")
        or raw.get("url")
        or ""
    )

    published = _parse_news_timestamp(
        content.get("pubDate")
        or content.get("displayTime")
        or raw.get("providerPublishTime")
        or raw.get("pubDate")
    )

    combined = f"{title} {summary}".lower()

    categories = [
        category
        for category, words in NEWS_KEYWORDS.items()
        if any(word in combined for word in words)
    ]
    is_rumor = any(word in combined for word in RUMOR_WORDS)

    if not categories and not is_rumor:
        return None

    primary_category = max(
        categories or ["other"],
        key=lambda c: NEWS_CATEGORY_WEIGHT.get(c, 1),
    )

    return {
        "ticker": ticker,
        "title": title,
        "publisher": str(publisher),
        "link": str(link),
        "published": published,
        "category": primary_category,
        "is_rumor": is_rumor,
    }

@st.cache_data(ttl=300, show_spinner=False)
def fetch_watchlist_news(tickers: Tuple[str, ...], max_age_hours: int = 36) -> List[dict]:
    now = datetime.now(NY)
    cutoff = now - timedelta(hours=max_age_hours)

    def fetch_one(ticker: str) -> List[dict]:
        try:
            obj = yf.Ticker(ticker)
            try:
                raw_items = obj.get_news(count=6, tab="news")
            except Exception:
                raw_items = obj.news

            out = []
            for raw in (raw_items or []):
                item = _normalize_news_item(raw, ticker)
                if not item:
                    continue
                if item["published"] is not None and item["published"] < cutoff:
                    continue
                out.append(item)
            return out
        except Exception:
            return []

    all_items: List[dict] = []
    workers = min(12, max(1, len(tickers)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(fetch_one, ticker) for ticker in tickers]
        for future in as_completed(futures):
            try:
                all_items.extend(future.result())
            except Exception:
                pass

    # Deduplicate syndicated articles and merge tickers.
    dedup: Dict[str, dict] = {}
    for item in all_items:
        key = (item.get("link") or re.sub(r"\W+", "", item["title"].lower()))[:500]
        if key in dedup:
            ticker_set = set(dedup[key].get("tickers", [dedup[key]["ticker"]]))
            ticker_set.add(item["ticker"])
            dedup[key]["tickers"] = sorted(ticker_set)
            dedup[key]["is_rumor"] = dedup[key]["is_rumor"] or item["is_rumor"]
        else:
            item["tickers"] = [item["ticker"]]
            dedup[key] = item

    items = list(dedup.values())

    def rank_key(item: dict):
        published = item.get("published")
        age_hours = 999.0
        if published is not None:
            age_hours = max(0.0, (now - published).total_seconds() / 3600.0)
        importance = NEWS_CATEGORY_WEIGHT.get(item.get("category", "other"), 1)
        if item.get("is_rumor"):
            importance += 1
        recency_bonus = max(0.0, 2.0 - age_hours / 12.0)
        return importance + recency_bonus

    items.sort(key=rank_key, reverse=True)
    return items[:20]

def news_category_label(category: str) -> str:
    keys = {
        "earnings": "news_earnings",
        "politics": "news_politics",
        "legal": "news_legal",
        "deal": "news_deal",
        "analyst": "news_analyst",
        "corporate": "news_corporate",
        "other": "news_other",
    }
    return tr(keys.get(category, "news_other"))

def _news_direction(title: str) -> Tuple[str, str]:
    lower = (title or "").lower()
    pos = sum(1 for word in POSITIVE_NEWS_WORDS if word in lower)
    neg = sum(1 for word in NEGATIVE_NEWS_WORDS if word in lower)
    if pos > neg:
        return "↑", tr("news_direction_positive")
    if neg > pos:
        return "↓", tr("news_direction_negative")
    return "•", tr("news_direction_neutral")


def _current_move_map(frame: Optional[pd.DataFrame], phase: str) -> Dict[str, float]:
    if frame is None or frame.empty or "ticker" not in frame.columns:
        return {}

    if phase == "premarket":
        move_col = "premarket_change_pct"
    elif phase == "afterhours":
        move_col = "afterhours_change_pct"
    else:
        move_col = "move_pct"

    if move_col not in frame.columns:
        return {}

    out: Dict[str, float] = {}
    for _, row in frame.iterrows():
        try:
            value = row.get(move_col)
            if value is None or pd.isna(value):
                continue
            out[str(row["ticker"])] = float(value)
        except Exception:
            continue
    return out


def _headline_direction_sign(title: str) -> int:
    arrow, _direction = _news_direction(title)
    if arrow == "↑":
        return 1
    if arrow == "↓":
        return -1
    return 0


def _useful_news(
    items: List[dict],
    now_et: datetime,
    limit: int = 7,
    current_moves: Optional[Dict[str, float]] = None,
    phase: str = "regular",
) -> List[dict]:
    """
    Select decision-useful news with CURRENT PRICE ACTION as the primary reality check.

    A headline that agrees with a meaningful current move is promoted.
    A headline that contradicts the current move is demoted and explicitly labeled.
    Old contradictory context is not allowed to dominate Key News.
    """
    current_moves = current_moves or {}
    ranked: List[dict] = []

    for item in items:
        category = item.get("category", "other")
        if category == "other" and not item.get("is_rumor"):
            continue

        published = item.get("published")
        age_h = 36.0
        if published is not None:
            try:
                age_h = max(0.0, (now_et - published).total_seconds() / 3600.0)
            except Exception:
                pass

        title = str(item.get("title") or "")
        arrow, direction_text = _news_direction(title)
        news_sign = _headline_direction_sign(title)

        tickers = item.get("tickers") or [item.get("ticker", "")]
        primary = str(tickers[0]) if tickers else ""
        current_move = current_moves.get(primary)
        move_sign = 0
        if current_move is not None:
            if current_move >= 0.35:
                move_sign = 1
            elif current_move <= -0.35:
                move_sign = -1

        importance = float(NEWS_CATEGORY_WEIGHT.get(category, 1))

        # Much stronger freshness preference than before.
        if age_h <= 1:
            recency = 5.0
        elif age_h <= 3:
            recency = 4.0
        elif age_h <= 6:
            recency = 2.5
        elif age_h <= 12:
            recency = 1.0
        else:
            recency = 0.0

        directional_bonus = 1.0 if news_sign != 0 else 0.0
        rumor_penalty = 1.0 if item.get("is_rumor") else 0.0

        reality_bonus = 0.0
        reality_status = "unknown"
        reality_text = ""

        if current_move is not None:
            phase_label = {
                "premarket": "premarket",
                "afterhours": "after-hours",
                "regular": "today",
            }.get(phase, "now")

            if move_sign == 0:
                reality_status = "neutral_move"
                reality_text = f"Current {phase_label}: {current_move:+.2f}%"
            elif news_sign == 0:
                reality_status = "price_only"
                reality_text = f"Current {phase_label}: {current_move:+.2f}%"
                # Neutral headline may still be useful, but price action is the truth.
                reality_bonus += 0.5
            elif news_sign == move_sign:
                reality_status = "aligned"
                reality_text = f"Matches current {phase_label} move {current_move:+.2f}%"
                reality_bonus += 4.0
            else:
                reality_status = "conflict"
                reality_text = (
                    f"Current {phase_label} is {current_move:+.2f}% — "
                    f"opposite to this headline's tone"
                )
                # Strong penalty, especially for older context.
                reality_bonus -= 6.0
                if age_h > 3:
                    reality_bonus -= 3.0
                if age_h > 12:
                    reality_bonus -= 2.0

        useful_score = (
            importance * 2.0
            + recency
            + directional_bonus
            + reality_bonus
            - rumor_penalty
        )

        candidate = dict(item)
        candidate["_useful_score"] = useful_score
        candidate["_direction_arrow"] = arrow
        candidate["_direction_text"] = direction_text
        candidate["_age_h"] = age_h
        candidate["_current_move"] = current_move
        candidate["_reality_status"] = reality_status
        candidate["_reality_text"] = reality_text
        ranked.append(candidate)

    ranked.sort(key=lambda x: x["_useful_score"], reverse=True)

    selected: List[dict] = []
    ticker_counts: Dict[str, int] = {}
    rumor_count = 0

    for item in ranked:
        tickers = item.get("tickers") or [item.get("ticker", "")]
        primary = str(tickers[0]) if tickers else ""
        already = ticker_counts.get(primary, 0)

        # Do not let an old contradictory article occupy scarce Key News space
        # unless it is genuinely high-impact.
        if (
            item.get("_reality_status") == "conflict"
            and float(item.get("_age_h", 36.0)) > 6.0
            and item.get("category") not in {"earnings", "politics", "legal"}
        ):
            continue

        high_category = item.get("category") in {"earnings", "politics", "legal"}
        if already >= 1 and not (already == 1 and high_category and item["_useful_score"] >= 11):
            continue

        if item.get("is_rumor"):
            if rumor_count >= 1 and item["_useful_score"] < 11:
                continue
            rumor_count += 1

        selected.append(item)
        ticker_counts[primary] = already + 1
        if len(selected) >= limit:
            break

    return selected



GLOBAL_MARKET_SYMBOLS = {
    "Nikkei 225": "^N225",
    "Hang Seng": "^HSI",
    "Euro Stoxx 50": "^STOXX50E",
    "DAX": "^GDAXI",
    "FTSE 100": "^FTSE",
    "S&P 500 futures": "ES=F",
    "Nasdaq futures": "NQ=F",
    "WTI oil": "CL=F",
    "Semiconductors": "SOXX",
    "Energy": "XLE",
    "Software": "IGV",
}


def _extract_symbol_frame(data: pd.DataFrame, symbol: str, symbol_count: int) -> Optional[pd.DataFrame]:
    if data is None or data.empty:
        return None
    try:
        if isinstance(data.columns, pd.MultiIndex):
            # yfinance may return either ticker-first or field-first MultiIndex.
            if symbol in data.columns.get_level_values(0):
                frame = data[symbol].copy()
            elif symbol in data.columns.get_level_values(-1):
                frame = data.xs(symbol, axis=1, level=-1).copy()
            else:
                return None
        else:
            frame = data.copy() if symbol_count == 1 else None
        return frame
    except Exception:
        return None


@st.cache_data(ttl=300, show_spinner=False)
def fetch_global_market_snapshot() -> Dict[str, dict]:
    """
    Lightweight global context for Key News.

    Uses yfinance daily bars so Asian/European indices, US futures and sector ETFs
    can be compared on the same simple current-vs-prior-close basis.
    Missing symbols are skipped rather than inferred.
    """
    symbols = list(GLOBAL_MARKET_SYMBOLS.values())
    try:
        data = yf.download(
            tickers=" ".join(symbols),
            period="5d",
            interval="1d",
            group_by="ticker",
            auto_adjust=False,
            prepost=True,
            progress=False,
            threads=True,
        )
    except Exception:
        return {}

    out: Dict[str, dict] = {}
    for name, symbol in GLOBAL_MARKET_SYMBOLS.items():
        frame = _extract_symbol_frame(data, symbol, len(symbols))
        if frame is None or frame.empty:
            continue
        try:
            closes = pd.to_numeric(frame.get("Close"), errors="coerce").dropna()
            if len(closes) < 2:
                continue
            current = float(closes.iloc[-1])
            previous = float(closes.iloc[-2])
            if current <= 0 or previous <= 0:
                continue
            move = (current / previous - 1.0) * 100.0
            out[name] = {
                "symbol": symbol,
                "price": current,
                "move_pct": move,
            }
        except Exception:
            continue

    return out


def _market_tone(move: Optional[float], strong: float = 1.0) -> str:
    if move is None:
        return "unavailable"
    if move >= strong:
        return "strong positive"
    if move >= 0.25:
        return "positive"
    if move <= -strong:
        return "strong negative"
    if move <= -0.25:
        return "negative"
    return "neutral"


def build_market_state_summary(
    snapshot: Dict[str, dict],
    now_et: datetime,
    current_frame: Optional[pd.DataFrame] = None,
    phase: str = "regular",
) -> dict:
    """Return simple natural-language market context for Key News."""
    if not snapshot:
        return {"headline": "Market context unavailable", "lines": []}

    def mv(name: str) -> Optional[float]:
        item = snapshot.get(name) or {}
        value = item.get("move_pct")
        return None if value is None else float(value)

    def simple_tone(values: List[float]) -> str:
        if not values:
            return "mixed"
        avg = sum(values) / len(values)
        if avg >= 0.35:
            return "positive"
        if avg <= -0.35:
            return "negative"
        return "mixed"

    local_t = now_et.time().replace(tzinfo=None)
    is_premarket = phase == "premarket" or local_t < REGULAR_OPEN
    is_afterhours = phase == "afterhours" or local_t >= REGULAR_CLOSE
    is_regular = not is_premarket and not is_afterhours
    lines: List[str] = []

    if is_premarket:
        asia_vals = [v for v in [mv("Nikkei 225"), mv("Hang Seng")] if v is not None]
        if asia_vals:
            tone = simple_tone(asia_vals)
            if tone == "positive":
                lines.append("Asian markets are mostly positive this morning.")
            elif tone == "negative":
                lines.append("Asian markets are under pressure this morning.")
            else:
                lines.append("Asian markets are mixed this morning.")

        europe_vals = [
            v for v in [mv("Euro Stoxx 50"), mv("DAX"), mv("FTSE 100")]
            if v is not None
        ]
        if europe_vals:
            tone = simple_tone(europe_vals)
            if tone == "positive":
                lines.append("European markets are mostly positive.")
            elif tone == "negative":
                lines.append("European markets are mostly lower.")
            else:
                lines.append("European markets are mixed.")

        es = mv("S&P 500 futures")
        nq = mv("Nasdaq futures")
        fut_vals = [v for v in [es, nq] if v is not None]
        if fut_vals:
            tone = simple_tone(fut_vals)
            if tone == "positive":
                lines.append("US futures are pointing higher before the open.")
            elif tone == "negative":
                lines.append("US futures are pointing lower before the open.")
            else:
                lines.append("US futures are little changed before the open.")

    semi = mv("Semiconductors")
    energy = mv("Energy")
    software = mv("Software")

    # Use the live semiconductor names from the current phase whenever possible.
    # This works in premarket, regular session, and after-hours.
    semi_context_value = semi
    semi_line_added = False

    phase_move_col = (
        "premarket_change_pct" if is_premarket else
        "afterhours_change_pct" if is_afterhours else
        "move_pct"
    )

    if (
        current_frame is not None
        and not current_frame.empty
        and "ticker" in current_frame.columns
        and phase_move_col in current_frame.columns
    ):
        semi_rows: List[Tuple[str, float]] = []
        for _, row in current_frame.iterrows():
            ticker = str(row.get("ticker") or "")
            if SECTOR_ETF_BY_TICKER.get(ticker) != "SOXX":
                continue
            try:
                value = row.get(phase_move_col)
                if value is None or pd.isna(value):
                    continue
                semi_rows.append((ticker, float(value)))
            except Exception:
                continue

        if len(semi_rows) >= 3:
            semi_moves = [v for _, v in semi_rows]
            semi_context_value = float(pd.Series(semi_moves).median())
            positive_share = sum(1 for v in semi_moves if v > 0) / len(semi_moves)
            negative_share = sum(1 for v in semi_moves if v < 0) / len(semi_moves)

            leader_ticker, leader_move = max(semi_rows, key=lambda x: x[1])
            leader_gap = leader_move - semi_context_value
            clear_relative_leader = leader_gap >= 1.00

            if is_premarket:
                strong_text = "Semiconductors are strong in premarket trading."
                weak_text = "Semiconductors are weak in premarket trading."
                mixed_text = "Semiconductors are mixed in premarket trading."
                weak_leader_text = (
                    f"Semiconductors are weak in premarket trading, "
                    f"but {leader_ticker} is holding up better than the group."
                )
                mixed_leader_text = (
                    f"Semiconductors are mixed in premarket trading, "
                    f"with {leader_ticker} showing clear relative strength."
                )
                strong_leader_text = (
                    f"Semiconductors are strong in premarket trading, "
                    f"with {leader_ticker} leading the group."
                )
            elif is_afterhours:
                strong_text = "Semiconductors are strong after hours."
                weak_text = "Semiconductors are weak after hours."
                mixed_text = "Semiconductors are mixed after hours."
                weak_leader_text = (
                    f"Semiconductors are weak after hours, "
                    f"but {leader_ticker} is holding up better than the group."
                )
                mixed_leader_text = (
                    f"Semiconductors are mixed after hours, "
                    f"with {leader_ticker} showing clear relative strength."
                )
                strong_leader_text = (
                    f"Semiconductors are strong after hours, "
                    f"with {leader_ticker} leading the group."
                )
            else:
                strong_text = "Semiconductors are strong today."
                weak_text = "Semiconductors are weak today."
                mixed_text = "Semiconductors are mixed today."
                weak_leader_text = (
                    f"Semiconductors are weak today, "
                    f"but {leader_ticker} is holding up better than the group."
                )
                mixed_leader_text = (
                    f"Semiconductors are mixed today, "
                    f"with {leader_ticker} showing clear relative strength."
                )
                strong_leader_text = (
                    f"Semiconductors are strong today, "
                    f"with {leader_ticker} leading the group."
                )

            if semi_context_value >= 0.35 and positive_share >= 0.55:
                lines.append(strong_leader_text if clear_relative_leader else strong_text)
            elif semi_context_value <= -0.35 and negative_share >= 0.55:
                lines.append(weak_leader_text if clear_relative_leader else weak_text)
            else:
                lines.append(mixed_leader_text if clear_relative_leader else mixed_text)

            semi_line_added = True

    # Fallback only outside premarket/after-hours live mode.
    if not semi_line_added and semi is not None:
        if is_regular:
            if semi >= 0.50:
                lines.append("Semiconductors are strong today.")
            elif semi <= -0.50:
                lines.append("Semiconductors are weak today.")

    if software is not None:
        if software >= 0.50:
            lines.append("Software stocks are showing strength.")
        elif software <= -0.50:
            lines.append("Software stocks are under pressure.")

    if energy is not None:
        if energy >= 0.50:
            lines.append("Energy stocks are strong today.")
        elif energy <= -0.50:
            lines.append("Energy stocks are weak today.")

    oil = mv("WTI oil")
    if oil is not None:
        if oil <= -0.50:
            lines.append("Oil is under pressure.")
        elif oil >= 0.50:
            lines.append("Oil prices are rising.")

    directional = [
        v for v in [
            mv("S&P 500 futures"),
            mv("Nasdaq futures"),
            semi_context_value if semi_line_added or is_regular else None,
            energy,
            software,
        ] if v is not None
    ]

    tone = simple_tone(directional) if directional else "mixed"
    if tone == "positive":
        headline = "Market tone is positive."
    elif tone == "negative":
        headline = "Market tone is cautious."
    else:
        headline = "Market tone is mixed."

    return {"headline": headline, "lines": lines[:6]}


def render_market_state_summary(
    now_et: datetime,
    current_frame: Optional[pd.DataFrame] = None,
    phase: str = "regular",
) -> None:
    snapshot = fetch_global_market_snapshot()
    summary = build_market_state_summary(
        snapshot,
        now_et,
        current_frame=current_frame,
        phase=phase,
    )

    headline = escape(summary.get("headline", "Market context"))
    lines = summary.get("lines") or []

    if not lines:
        return

    body = "<br>".join(f"• {escape(str(line))}" for line in lines)

    st.markdown(
        f"""
        <div style="
            padding:8px 10px;
            margin:4px 0 7px;
            border:1px solid rgba(96,165,250,.28);
            border-radius:9px;
            background:rgba(15,23,42,.60);
            line-height:1.30;
        ">
          <div style="font-size:.78rem;font-weight:800;">🌍 {headline}</div>
          <div style="font-size:.69rem;color:#dbeafe;margin-top:3px;">{body}</div>
        </div>
        """,
        unsafe_allow_html=True,
    )


def render_news_section(
    items: List[dict],
    now_et: datetime,
    current_frame: Optional[pd.DataFrame] = None,
    phase: str = "regular",
) -> None:
    st.markdown(
        f"""
        <div style="margin:8px 0 4px 0;">
          <div style="font-size:1rem;font-weight:800;line-height:1.15;">
            {tr("news_title")}
          </div>
          <div style="font-size:.68rem;color:#94a3b8;margin-top:2px;">
            {tr("news_useful_caption")}
          </div>
        </div>
        """,
        unsafe_allow_html=True,
    )

    # Start Key News with a concise market-state overview.
    render_market_state_summary(now_et, current_frame=current_frame, phase=phase)

    current_moves = _current_move_map(current_frame, phase)
    useful = _useful_news(
        items,
        now_et,
        limit=7,
        current_moves=current_moves,
        phase=phase,
    )
    if not useful:
        st.info(tr("news_none"))
        return

    for item in useful:
        tickers = ", ".join(item.get("tickers") or [item.get("ticker", "")])
        category = item.get("category", "other")
        category_text = news_category_label(category)

        importance = NEWS_CATEGORY_WEIGHT.get(category, 1)
        impact = tr("news_impact_high") if importance >= 5 else tr("news_impact_medium")

        arrow = item.get("_direction_arrow", "•")
        direction_text = item.get("_direction_text", tr("news_direction_neutral"))
        age_h = float(item.get("_age_h", 0.0))
        if age_h < 1:
            age_text = "<1h"
        else:
            age_text = f"{age_h:.0f}h"

        rumor = f' · ⚠ {tr("news_rumor")}' if item.get("is_rumor") else ""
        publisher = escape(str(item.get("publisher", "")))
        title = escape(str(item.get("title", "")))
        link = item.get("link", "")
        reality_status = str(item.get("_reality_status") or "")
        reality_text = escape(str(item.get("_reality_text") or ""))
        current_move = item.get("_current_move")
        try:
            current_move_value = None if current_move is None or pd.isna(current_move) else float(current_move)
        except Exception:
            current_move_value = None

        if current_move_value is not None and current_move_value > 0:
            reality_color = "#86efac"
        elif current_move_value is not None and current_move_value < 0:
            reality_color = "#fca5a5"
        else:
            reality_color = "#dbeafe"

        meta = (
            f"<b>{escape(tickers)}</b> · {impact} · {escape(category_text)} · "
            f"{arrow} {escape(direction_text)} · {age_text} · {publisher}{escape(rumor)}"
        )

        if link:
            safe_url = escape(str(link), quote=True)
            headline = (
                f'<a href="{safe_url}" target="_blank" rel="noopener noreferrer" '
                f'style="color:inherit;text-decoration:none;font-weight:650;">{title}</a>'
            )
        else:
            headline = f'<span style="font-weight:650;">{title}</span>'

        st.markdown(
            f"""
            <div style="
                padding:6px 9px;
                margin:3px 0;
                border:1px solid rgba(148,163,184,.18);
                border-radius:8px;
                background:rgba(15,23,42,.42);
                line-height:1.22;
            ">
              <div style="font-size:.67rem;color:#94a3b8;">{meta}</div>
              <div style="font-size:.78rem;margin-top:2px;">{headline}</div>
              {
                f'<div style="font-size:.68rem;margin-top:3px;color:{reality_color};"><b>Current reality:</b> {reality_text}</div>'
                if reality_status == "aligned" and reality_text
                else (
                    f'<div style="font-size:.68rem;margin-top:3px;color:#fbbf24;"><b>Background only:</b> {reality_text}</div>'
                    if reality_status == "conflict" and reality_text
                    else (
                        f'<div style="font-size:.68rem;margin-top:3px;color:#dbeafe;"><b>Current move:</b> {reality_text}</div>'
                        if reality_text
                        else ""
                    )
                )
              }
            </div>
            """,
            unsafe_allow_html=True,
        )


POSITIVE_NEWS_WORDS = [
    "beats", "beat estimates", "raises guidance", "raise guidance", "record revenue",
    "record sales", "strong demand", "wins contract", "contract win", "approval",
    "approved", "upgrade", "upgraded", "price target raised", "partnership",
    "expands", "growth accelerates", "surges on", "profit rises", "revenue rises",
]
NEGATIVE_NEWS_WORDS = [
    "misses", "missed estimates", "cuts guidance", "cut guidance", "warning",
    "profit warning", "downgrade", "downgraded", "price target cut", "lawsuit",
    "investigation", "probe", "recall", "ban", "sanction", "tariff", "layoffs",
    "data breach", "cyberattack", "production halt", "revenue falls", "profit falls",
]

def directional_news_score(items: List[dict], ticker: str, now_et: datetime) -> Tuple[float, List[str], bool]:
    score = 0.0
    reasons: List[str] = []
    rumor_seen = False

    related = [
        item for item in items
        if ticker in (item.get("tickers") or [item.get("ticker")])
    ]

    for item in related:
        title = str(item.get("title") or "")
        lower = title.lower()
        published = item.get("published")
        age_h = 24.0
        if published is not None:
            try:
                age_h = max(0.0, (now_et - published).total_seconds() / 3600.0)
            except Exception:
                pass

        # Fresh headlines matter more; decay after roughly half a day.
        freshness = max(0.25, 1.0 - min(age_h, 36.0) / 48.0)

        pos_hits = sum(1 for word in POSITIVE_NEWS_WORDS if word in lower)
        neg_hits = sum(1 for word in NEGATIVE_NEWS_WORDS if word in lower)
        delta = (pos_hits - neg_hits) * 4.0 * freshness

        category = item.get("category")
        if category in {"earnings", "legal", "politics", "deal", "corporate"} and (pos_hits or neg_hits):
            delta *= 1.15

        if item.get("is_rumor"):
            rumor_seen = True
            delta *= 0.55

        score += delta

        if delta >= 2.0 and len(reasons) < 2:
            reasons.append(f'+ news: {title[:90]}')
        elif delta <= -2.0 and len(reasons) < 2:
            reasons.append(f'- news: {title[:90]}')

    return max(-15.0, min(15.0, score)), reasons, rumor_seen


def _clip(value: Optional[float], scale: float) -> float:
    if value is None or pd.isna(value) or scale <= 0:
        return 0.0
    return max(-1.0, min(1.0, float(value) / scale))


def build_ai_analysis(
    frame: pd.DataFrame,
    news_items: List[dict],
    now_et: datetime,
    is_open: bool,
    context: Optional[Dict[str, dict]] = None,
) -> pd.DataFrame:
    records: List[dict] = []

    for _, row in frame.iterrows():
        ticker = str(row["ticker"])
        last_ts = pd.Timestamp(row["last_time_et"]).to_pydatetime()
        if last_ts.tzinfo is None:
            last_ts = last_ts.replace(tzinfo=NY)
        else:
            last_ts = last_ts.astimezone(NY)

        age_min = max(0.0, (now_et - last_ts).total_seconds() / 60.0)

        m5 = row.get("move_5m_pct")
        m15 = row.get("move_15m_pct")
        h1 = row.get("hour_move_pct")
        day = row.get("move_pct")
        vol_ratio = row.get("volume_ratio_5m")
        gap = row.get("source_gap_pct_points")
        rel_sector_day = row.get("rel_sector_day")
        rel_qqq_day = row.get("rel_qqq_day")
        rel_sector_hour = row.get("rel_sector_hour")
        sector_etf = str(row.get("sector_etf") or "SPY")
        vwap_distance_pct = row.get("vwap_distance_pct")
        atr_pct = row.get("atr_pct")
        rsi_14 = row.get("rsi_14")
        macd_hist_pct = row.get("macd_hist_pct")
        support_distance_pct = row.get("support_distance_pct")
        resistance_distance_pct = row.get("resistance_distance_pct")

        enough = all(pd.notna(v) for v in [m5, m15, h1, day])
        stale = bool(is_open and age_min > 5.0)

        if stale or not enough:
            records.append({
                "ticker": ticker,
                "label": "NO SIGNAL",
                "score": 0.0,
                "strength": 0,
                "age_min": age_min,
                "reasons": [],
                "warnings": [tr("ai_stale")],
                "volume_ratio_5m": vol_ratio,
                "news_score": 0.0,
                "sector_etf": sector_etf,
                "rel_sector_day": rel_sector_day,
                "rel_qqq_day": rel_qqq_day,
                "relative_bonus": 0.0,
                "m5": m5,
                "m15": m15,
                "h1": h1,
                "day": day,
                "source_gap_pct_points": gap,
                "vwap_distance_pct": vwap_distance_pct,
                "atr_pct": atr_pct,
                "rsi_14": rsi_14,
                "macd_hist_pct": macd_hist_pct,
                "support_distance_pct": support_distance_pct,
                "resistance_distance_pct": resistance_distance_pct,
            })
            continue

        # Directional core. Values are normalized so no single extreme move dominates.
        score = (
            25.0 * _clip(m5, 0.80)
            + 25.0 * _clip(m15, 1.50)
            + 15.0 * _clip(h1, 3.00)
            + 10.0 * _clip(day, 5.00)
        )

        reasons: List[str] = []
        warnings: List[str] = []

        # Trend alignment explanations.
        direction_votes = [
            1 if float(m5) > 0 else -1 if float(m5) < 0 else 0,
            1 if float(m15) > 0 else -1 if float(m15) < 0 else 0,
            1 if float(h1) > 0 else -1 if float(h1) < 0 else 0,
            1 if float(day) > 0 else -1 if float(day) < 0 else 0,
        ]
        vote_sum = sum(direction_votes)
        if vote_sum >= 3:
            reasons.append(
                f"<b>5m</b>&nbsp;{float(m5):+.2f}%"
                f"&nbsp;&nbsp;&nbsp;<b>15m</b>&nbsp;{float(m15):+.2f}%"
                f"&nbsp;&nbsp;&nbsp;<b>1h</b>&nbsp;{float(h1):+.2f}%"
                f"&nbsp;&nbsp;&nbsp;<b>Day</b>&nbsp;{float(day):+.2f}%"
                f"&nbsp;&nbsp;· broadly bullish"
            )
        elif vote_sum <= -3:
            reasons.append(
                f"<b>5m</b>&nbsp;{float(m5):+.2f}%"
                f"&nbsp;&nbsp;&nbsp;<b>15m</b>&nbsp;{float(m15):+.2f}%"
                f"&nbsp;&nbsp;&nbsp;<b>1h</b>&nbsp;{float(h1):+.2f}%"
                f"&nbsp;&nbsp;&nbsp;<b>Day</b>&nbsp;{float(day):+.2f}%"
                f"&nbsp;&nbsp;· broadly bearish"
            )
        else:
            reasons.append(
                f"<b>5m</b>&nbsp;{float(m5):+.2f}%"
                f"&nbsp;&nbsp;&nbsp;<b>15m</b>&nbsp;{float(m15):+.2f}%"
                f"&nbsp;&nbsp;&nbsp;<b>1h</b>&nbsp;{float(h1):+.2f}%"
                f"&nbsp;&nbsp;&nbsp;<b>Day</b>&nbsp;{float(day):+.2f}%"
                f"&nbsp;&nbsp;· mixed horizons"
            )

        # Relative strength: compare the stock to its sector ETF and QQQ.
        # This can confirm/penalize an existing setup, but it is capped so it
        # cannot dominate the short-term price action.
        relative_bonus = 0.0
        if rel_sector_day is not None and pd.notna(rel_sector_day):
            relative_bonus += 4.0 * _clip(float(rel_sector_day), 3.0)
        if rel_qqq_day is not None and pd.notna(rel_qqq_day):
            relative_bonus += 2.0 * _clip(float(rel_qqq_day), 3.0)
        if rel_sector_hour is not None and pd.notna(rel_sector_hour):
            relative_bonus += 2.0 * _clip(float(rel_sector_hour), 2.0)

        relative_bonus = max(-8.0, min(8.0, relative_bonus))
        score += relative_bonus

        if rel_sector_day is not None and pd.notna(rel_sector_day):
            rs = float(rel_sector_day)
            if rs >= 0.50:
                reasons.append(f"Outperforming {sector_etf} by {rs:+.2f} pt today")
            elif rs <= -0.50:
                reasons.append(f"Underperforming {sector_etf} by {rs:+.2f} pt today")

        # Broad-market regime is informational rather than a direct trigger.
        if context:
            spy = context.get("SPY") or {}
            qqq = context.get("QQQ") or {}
            spy_day = spy.get("move_pct")
            qqq_day = qqq.get("move_pct")
            if spy_day is not None and qqq_day is not None:
                if float(spy_day) < -1.0 and float(qqq_day) < -1.0 and score > 0:
                    warnings.append("Broad market is strongly risk-off")
                elif float(spy_day) > 1.0 and float(qqq_day) > 1.0 and score < 0:
                    warnings.append("Broad market is strongly risk-on")

        # Volume confirms direction; it never creates direction by itself.
        if vol_ratio is not None and pd.notna(vol_ratio):
            vr = float(vol_ratio)
            if vr >= 1.25:
                dominant = 1.0 if (float(m5) + float(m15)) > 0 else -1.0
                volume_boost = min(10.0, max(0.0, (vr - 1.0) / 1.5 * 10.0))
                score += dominant * volume_boost
                reasons.append(f"Recent 5m volume is {vr:.2f}× intraday baseline")
            elif vr < 0.60:
                warnings.append(f"Recent volume is light ({vr:.2f}× baseline)")

        # News/catalyst contribution.
        news_score, news_reasons, rumor_seen = directional_news_score(news_items, ticker, now_et)
        score += news_score
        reasons.extend(news_reasons)

        # Source quality influences confidence more than direction.
        source_quality = 10.0
        if gap is not None and pd.notna(gap):
            abs_gap = abs(float(gap))
            if abs_gap <= 0.20:
                reasons.append(tr("ai_source_agree"))
            elif abs_gap >= 0.75:
                source_quality -= min(8.0, abs_gap * 3.0)
                warnings.append(f'{tr("ai_source_disagree")}: {abs_gap:.2f} pt')

        # Avoid blindly chasing highly extended moves.
        extension_penalty = 0.0
        if abs(float(h1)) >= 6.0 or abs(float(day)) >= 10.0:
            extension_penalty = min(12.0, max(abs(float(h1)) - 5.0, abs(float(day)) - 8.0))
            if score > 0:
                score -= extension_penalty
            elif score < 0:
                score += extension_penalty
            warnings.append(tr("ai_extended"))

        if rumor_seen:
            source_quality -= 5.0
            warnings.append(tr("ai_rumor"))

        score = max(-100.0, min(100.0, score))

        if score >= 58:
            label = tr("ai_strong_buy")
        elif score >= 28:
            label = tr("ai_buy")
        elif score <= -58:
            label = tr("ai_strong_sell")
        elif score <= -28:
            label = tr("ai_sell")
        else:
            label = tr("ai_watch")

        # "Strength" is evidence agreement, not probability.
        completeness = 85.0
        if row.get("polygon_ok") and row.get("yfinance_ok"):
            completeness += 10.0
        if vol_ratio is not None and pd.notna(vol_ratio):
            completeness += 5.0

        strength = abs(score) * 0.75 + source_quality * 1.5
        strength = min(completeness, max(20.0, strength))
        if label == tr("ai_watch"):
            strength = min(strength, 60.0)

        records.append({
            "ticker": ticker,
            "label": label,
            "score": score,
            "strength": int(round(strength)),
            "age_min": age_min,
            "reasons": reasons[:4],
            "warnings": warnings[:3],
            "volume_ratio_5m": vol_ratio,
            "news_score": news_score,
            "sector_etf": sector_etf,
            "rel_sector_day": rel_sector_day,
            "rel_qqq_day": rel_qqq_day,
            "relative_bonus": relative_bonus,
            "m5": m5,
            "m15": m15,
            "h1": h1,
            "day": day,
            "source_gap_pct_points": gap,
            "vwap_distance_pct": vwap_distance_pct,
            "atr_pct": atr_pct,
            "rsi_14": rsi_14,
            "macd_hist_pct": macd_hist_pct,
            "support_distance_pct": support_distance_pct,
            "resistance_distance_pct": resistance_distance_pct,
        })

    result = pd.DataFrame(records)
    if not result.empty:
        result["abs_score"] = result["score"].abs()
        result = result.sort_values(["abs_score", "strength"], ascending=[False, False])
    return result






def infer_likely_driver(
    direction: int,
    day: float,
    m5: float,
    m15: float,
    h1: float,
    rel_sector: float,
    rel_qqq: Optional[float],
    vol: Optional[float],
    vwap_dist: Optional[float],
    news_score: float,
    sector_etf: str,
) -> Tuple[str, str]:
    """
    Explain the most likely CURRENT driver from observable market evidence.

    This is an interpretation layer, not a causal claim. It never changes scores.
    """
    sector_day = day - rel_sector
    qqq_day = None if rel_qqq is None else day - rel_qqq

    # A clear fresh news signal takes priority.
    if direction * news_score > 0:
        return (
            "Fresh catalyst / news",
            "Recent news is aligned with the current price direction.",
        )

    # Reversal / profit-taking pattern: day still opposite to the very recent move.
    if direction < 0 and day > 0.50 and m5 < 0 and m15 < 0 and h1 < 0:
        return (
            "Possible profit-taking / reversal",
            "The stock is still up on the day, but short-term momentum has turned bearish.",
        )
    if direction > 0 and day < -0.50 and m5 > 0 and m15 > 0 and h1 > 0:
        return (
            "Possible rebound / short-covering",
            "The stock is still down on the day, but short-term momentum has turned bullish.",
        )

    # Broad-market + sector pressure/support.
    if direction < 0:
        if qqq_day is not None and qqq_day <= -0.50 and sector_day <= -0.50:
            return (
                "Broad market / sector weakness",
                f"Both the broader tech market and {sector_etf} are weak, reinforcing the selloff.",
            )
        if sector_day <= -0.50 and rel_sector > -1.0:
            return (
                "Sector weakness",
                f"{sector_etf} is weak today, so part of the move appears sector-driven.",
            )
    else:
        if qqq_day is not None and qqq_day >= 0.50 and sector_day >= 0.50:
            return (
                "Broad market / sector strength",
                f"Both the broader tech market and {sector_etf} are strong, supporting the move.",
            )
        if sector_day >= 0.50 and rel_sector < 1.0:
            return (
                "Sector strength",
                f"{sector_etf} is strong today, so part of the move appears sector-driven.",
            )

    # Strong relative under/over-performance suggests stock-specific flow.
    if direction < 0 and rel_sector <= -1.0:
        detail_parts = [f"underperforming {sector_etf} by {abs(rel_sector):.2f} pt"]
        if vwap_dist is not None and vwap_dist < 0:
            detail_parts.append(f"{abs(vwap_dist):.2f}% below VWAP")
        if vol is not None and vol >= 1.0:
            detail_parts.append(f"volume {vol:.2f}× baseline")
        return (
            "Stock-specific technical selling pressure",
            "The stock is " + ", ".join(detail_parts) + ", with no fresh negative news identified.",
        )

    if direction > 0 and rel_sector >= 1.0:
        detail_parts = [f"outperforming {sector_etf} by {rel_sector:.2f} pt"]
        if vwap_dist is not None and vwap_dist > 0:
            detail_parts.append(f"{vwap_dist:.2f}% above VWAP")
        if vol is not None and vol >= 1.0:
            detail_parts.append(f"volume {vol:.2f}× baseline")
        return (
            "Stock-specific buying pressure",
            "The stock is " + ", ".join(detail_parts) + ", with no fresh positive news identified.",
        )

    # Generic technical continuation when price structure is clear.
    if direction < 0 and vwap_dist is not None and vwap_dist < 0:
        return (
            "Technical momentum",
            "Short-term momentum is bearish and price is below VWAP; no clear fresh news catalyst was found.",
        )
    if direction > 0 and vwap_dist is not None and vwap_dist > 0:
        return (
            "Technical momentum",
            "Short-term momentum is bullish and price is above VWAP; no clear fresh news catalyst was found.",
        )

    return (
        "No clear catalyst identified",
        "The move is real, but the available news and market context do not identify a clear driver yet.",
    )




def classify_signal_profile(
    direction: int,
    news_score: float,
    persistence_count: int,
    support_dist: Optional[float],
    resistance_dist: Optional[float],
    atr_pct: Optional[float],
    vwap_dist: Optional[float],
    vol: Optional[float],
) -> Tuple[str, str, str, str]:
    """
    Descriptive layer only:
    - Signal basis: CATALYST-BACKED vs MOMENTUM-DRIVEN
    - Catalyst: Positive / Negative / None confirmed
    - Reversal risk: LOWER / MEDIUM / HIGH

    It does not modify conviction, direction, ranking, or any market calculation.
    """
    aligned_catalyst = direction * news_score > 0

    if aligned_catalyst:
        signal_basis = "CATALYST-BACKED"
        catalyst = "Positive" if direction > 0 else "Negative"
    else:
        signal_basis = "MOMENTUM-DRIVEN"
        catalyst = "None confirmed"

    obstacle_dist = resistance_dist if direction > 0 else support_dist

    risk_points = 0

    # No confirmed catalyst makes a short-term signal easier to reverse.
    if not aligned_catalyst:
        risk_points += 2

    # Very young signals have less persistence evidence.
    if persistence_count <= 1:
        risk_points += 1

    # Nearby support for SELL / resistance for BUY materially raises snap-back risk.
    if obstacle_dist is not None:
        if obstacle_dist < 0.20:
            risk_points += 3
        elif obstacle_dist < 0.50:
            risk_points += 1

    # Weak participation makes continuation less trustworthy.
    if vol is not None and vol < 0.80:
        risk_points += 1

    # Extreme distance from VWAP relative to ATR can mean an extended move.
    if (
        atr_pct is not None
        and atr_pct > 0
        and vwap_dist is not None
        and abs(vwap_dist) / atr_pct > 4.0
    ):
        risk_points += 2

    if risk_points >= 5:
        reversal_risk = "HIGH"
    elif risk_points >= 2:
        reversal_risk = "MEDIUM"
    else:
        reversal_risk = "LOWER"

    if reversal_risk == "HIGH":
        risk_detail = "The setup may reverse quickly; nearby price structure and/or missing catalyst reduce continuation confidence."
    elif reversal_risk == "MEDIUM":
        risk_detail = "Momentum is valid, but continuation is not fully protected by catalyst and price structure."
    else:
        risk_detail = "The setup has better continuation support, but reversal risk is never zero."

    return signal_basis, catalyst, reversal_risk, risk_detail


def build_conviction_ranking(analysis: pd.DataFrame) -> pd.DataFrame:
    """Comprehensive short-term continuation ranking; conviction != probability."""
    if analysis.empty:
        return pd.DataFrame()

    rows: List[dict] = []

    for _, item in analysis.iterrows():
        label = str(item.get("label") or "")
        score = float(item.get("score") or 0.0)
        if label not in {tr("ai_buy"), tr("ai_strong_buy"), tr("ai_sell"), tr("ai_strong_sell")}:
            continue

        direction = 1 if score > 0 else -1
        ticker = str(item["ticker"])

        def num(name):
            v = item.get(name)
            return None if v is None or pd.isna(v) else float(v)

        m5, m15, h1, day = num("m5"), num("m15"), num("h1"), num("day")
        rel_sector, rel_qqq = num("rel_sector_day"), num("rel_qqq_day")
        vol, news_score = num("volume_ratio_5m"), num("news_score")
        gap = num("source_gap_pct_points")
        vwap_dist, atr_pct = num("vwap_distance_pct"), num("atr_pct")
        rsi, macd_hist = num("rsi_14"), num("macd_hist_pct")
        support_dist, resistance_dist = num("support_distance_pct"), num("resistance_distance_pct")
        age_min = float(item.get("age_min") or 0.0)
        persistence = str(item.get("persistence") or "")
        persistence_count = int(item.get("persistence_count") or 0)

        if any(v is None for v in [m5, m15, h1, day, rel_sector]):
            continue

        # Mandatory qualification: self-relative momentum.
        # BUY:  5m > 15m > 1h, with current 5m positive.
        # SELL: 5m < 15m < 1h, with current 5m negative.
        #
        # This allows genuine turnarounds to qualify even when the 1h window
        # still reflects the previous direction.
        if direction > 0:
            self_momentum_ok = (m5 > m15 > h1) and (m5 > 0)
        else:
            self_momentum_ok = (m5 < m15 < h1) and (m5 < 0)

        if not self_momentum_ok:
            continue

        # Directional improvement magnitude versus the stock's own 1h state.
        self_momentum_score = direction * (m5 - h1)
        self_latest_step = direction * (m5 - m15)

        if direction*rel_sector <= 0 or age_min > 5.0:
            continue

        conviction = 0.0
        aligned = 0
        total = 0
        reasons, penalties = [], []
        factor_details: List[dict] = []

        def add_factor(name: str, status: str, detail: str) -> None:
            factor_details.append({
                "name": name,
                "status": status,
                "detail": detail,
            })

        # Self-relative momentum — 20
        total += 1; aligned += 1; conviction += 20.0
        reasons.append(
            "self momentum improving" if direction > 0 else "self momentum deteriorating"
        )
        add_factor(
            "Momentum 5m/15m/1h", "aligned",
            (
                f"{m5:+.2f}% > {m15:+.2f}% > {h1:+.2f}%"
                if direction > 0
                else f"{m5:+.2f}% < {m15:+.2f}% < {h1:+.2f}%"
            )
        )

        # Sector + QQQ relative strength — 15
        total += 1
        rs_points = min(10.0, abs(rel_sector)/2.5*10.0)
        conviction += rs_points; aligned += 1
        qqq_ok = rel_qqq is not None and direction*rel_qqq > 0
        if qqq_ok:
            conviction += min(5.0, abs(rel_qqq)/2.5*5.0)
        reasons.append(f"sector RS {rel_sector:+.2f} pt")
        qqq_text = "—" if rel_qqq is None else f"{rel_qqq:+.2f} pt"
        add_factor(
            "Relative strength", "aligned",
            f"Sector {rel_sector:+.2f} pt · QQQ {qqq_text}"
        )

        # Volume — 10
        total += 1
        if vol is not None:
            if vol >= 1.0:
                conviction += min(10.0, 5.0 + (vol-1.0)*5.0); aligned += 1
                reasons.append(f"volume {vol:.2f}×")
                add_factor("Volume", "aligned", f"{vol:.2f}× baseline")
            elif vol < 0.70:
                conviction -= 5.0; penalties.append(f"light volume {vol:.2f}×")
                add_factor("Volume", "conflict", f"{vol:.2f}× baseline")
            else:
                add_factor("Volume", "neutral", f"{vol:.2f}× baseline")
        else:
            add_factor("Volume", "missing", "unavailable")

        # VWAP — 10
        total += 1
        if vwap_dist is not None:
            if direction*vwap_dist > 0:
                conviction += min(10.0, 5.0 + min(abs(vwap_dist), 2.5)*2.0); aligned += 1
                reasons.append(f"{'above' if direction>0 else 'below'} VWAP {vwap_dist:+.2f}%")
                add_factor("VWAP", "aligned", f"{vwap_dist:+.2f}%")
            else:
                conviction -= 6.0; penalties.append("VWAP conflicts")
                add_factor("VWAP", "conflict", f"{vwap_dist:+.2f}%")
        else:
            add_factor("VWAP", "missing", "unavailable")

        # MACD — 8
        total += 1
        if macd_hist is not None:
            if direction*macd_hist > 0:
                conviction += min(8.0, 4.0 + abs(macd_hist)*200.0); aligned += 1
                add_factor("MACD", "aligned", f"hist {macd_hist:+.4f}%")
            else:
                conviction -= 3.0; penalties.append("MACD conflicts")
                add_factor("MACD", "conflict", f"hist {macd_hist:+.4f}%")
        else:
            add_factor("MACD", "missing", "unavailable")

        # RSI — 7
        total += 1
        if rsi is not None:
            if direction > 0 and 52 <= rsi <= 72:
                conviction += 7.0; aligned += 1
                add_factor("RSI", "aligned", f"{rsi:.0f}")
            elif direction < 0 and 28 <= rsi <= 48:
                conviction += 7.0; aligned += 1
                add_factor("RSI", "aligned", f"{rsi:.0f}")
            elif direction > 0 and rsi > 80:
                conviction -= 4.0; penalties.append(f"RSI overextended {rsi:.0f}")
                add_factor("RSI", "conflict", f"{rsi:.0f} overextended")
            elif direction < 0 and rsi < 20:
                conviction -= 4.0; penalties.append(f"RSI oversold {rsi:.0f}")
                add_factor("RSI", "conflict", f"{rsi:.0f} oversold")
            else:
                add_factor("RSI", "neutral", f"{rsi:.0f}")
        else:
            add_factor("RSI", "missing", "unavailable")

        # Persistence — 10
        total += 1
        if persistence_count >= 2:
            p = min(10.0, 5.0 + 2.0*(persistence_count-2))
            if persistence == "STRENGTHENING": p = min(10.0, p+2.0)
            if persistence == "WEAKENING": p = max(0.0, p-2.0)
            conviction += p; aligned += 1
            reasons.append(f"{persistence.lower()} ×{persistence_count}")
            add_factor("Persistence", "aligned", f"{persistence} ×{persistence_count}")
        else:
            add_factor("Persistence", "neutral", f"{persistence or 'NEW'} ×{persistence_count}")

        # Day trend — 6
        total += 1
        if direction*day > 0:
            conviction += min(6.0, 2.0 + abs(day)/2.0); aligned += 1
            add_factor("Day trend", "aligned", f"{day:+.2f}%")
        else:
            conviction -= 4.0; penalties.append("day trend conflicts")
            add_factor("Day trend", "conflict", f"{day:+.2f}%")

        # News — 6
        total += 1
        news_score = news_score or 0.0
        if direction*news_score > 0:
            conviction += min(6.0, abs(news_score)/2.0); aligned += 1
            add_factor("News", "aligned", f"score {news_score:+.1f}")
        elif direction*news_score < 0:
            conviction -= min(5.0, abs(news_score)/2.0); penalties.append("news conflicts")
            add_factor("News", "conflict", f"score {news_score:+.1f}")
        else:
            add_factor("News", "neutral", "no directional catalyst")

        # Provider agreement — 4
        total += 1
        if gap is None:
            conviction += 1.0
            add_factor("Provider agreement", "missing", "single source")
        elif abs(gap) <= 0.20:
            conviction += 4.0; aligned += 1
            add_factor("Provider agreement", "aligned", f"gap {abs(gap):.2f} pt")
        elif abs(gap) >= 0.75:
            conviction -= min(4.0, abs(gap)*2.0); penalties.append(f"provider gap {abs(gap):.2f} pt")
            add_factor("Provider agreement", "conflict", f"gap {abs(gap):.2f} pt")
        else:
            add_factor("Provider agreement", "neutral", f"gap {abs(gap):.2f} pt")

        # Room to support/resistance — 4
        total += 1
        if direction > 0 and resistance_dist is not None:
            if resistance_dist >= 0.50:
                conviction += min(4.0, resistance_dist*2.0); aligned += 1
                add_factor("Support / resistance", "aligned", f"resistance {resistance_dist:.2f}% away")
            elif resistance_dist < 0.20:
                conviction -= 4.0; penalties.append("near resistance")
                add_factor("Support / resistance", "conflict", f"resistance only {resistance_dist:.2f}% away")
            else:
                add_factor("Support / resistance", "neutral", f"resistance {resistance_dist:.2f}% away")
        elif direction < 0 and support_dist is not None:
            if support_dist >= 0.50:
                conviction += min(4.0, support_dist*2.0); aligned += 1
                add_factor("Support / resistance", "aligned", f"support {support_dist:.2f}% away")
            elif support_dist < 0.20:
                conviction -= 4.0; penalties.append("near support")
                add_factor("Support / resistance", "conflict", f"support only {support_dist:.2f}% away")
            else:
                add_factor("Support / resistance", "neutral", f"support {support_dist:.2f}% away")
        else:
            add_factor("Support / resistance", "missing", "unavailable")

        # ATR-normalized extension.
        if atr_pct is not None and atr_pct > 0 and vwap_dist is not None:
            atr_units = abs(vwap_dist)/atr_pct
            if atr_units > 4.0:
                conviction -= min(10.0, (atr_units-4.0)*2.0)
                penalties.append(f"extended {atr_units:.1f} ATR from VWAP")

        likely_driver, likely_driver_detail = infer_likely_driver(
            direction=direction,
            day=day,
            m5=m5,
            m15=m15,
            h1=h1,
            rel_sector=rel_sector,
            rel_qqq=rel_qqq,
            vol=vol,
            vwap_dist=vwap_dist,
            news_score=news_score,
            sector_etf=str(item.get("sector_etf") or "sector"),
        )

        signal_basis, catalyst_status, reversal_risk, reversal_risk_detail = classify_signal_profile(
            direction=direction,
            news_score=news_score,
            persistence_count=persistence_count,
            support_dist=support_dist,
            resistance_dist=resistance_dist,
            atr_pct=atr_pct,
            vwap_dist=vwap_dist,
            vol=vol,
        )

        conviction = max(0.0, min(100.0, conviction))
        tier = (
            "HIGH CONVICTION" if conviction >= 80 else
            "CONFIRMED" if conviction >= 65 else
            "DEVELOPING" if conviction >= 50 else "LOW"
        )

        rows.append({
            "ticker": ticker, "direction": "BUY" if direction > 0 else "SELL",
            "label": label, "conviction": round(conviction,1), "tier": tier,
            "score": score, "strength": int(item.get("strength") or 0),
            "confirmation_count": aligned, "confirmation_total": total,
            "m5": m5, "m15": m15, "h1": h1, "day": day,
            "self_momentum_score": self_momentum_score,
            "self_latest_step": self_latest_step,
            "sector_etf": item.get("sector_etf"), "rel_sector_day": rel_sector,
            "rel_qqq_day": rel_qqq, "volume_ratio_5m": vol,
            "persistence": persistence, "persistence_count": persistence_count,
            "vwap_distance_pct": vwap_dist, "atr_pct": atr_pct, "rsi_14": rsi,
            "macd_hist_pct": macd_hist, "support_distance_pct": support_dist,
            "resistance_distance_pct": resistance_dist,
            "reasons": reasons[:5], "penalties": penalties[:4],
            "factor_details": factor_details,
            "likely_driver": likely_driver,
            "likely_driver_detail": likely_driver_detail,
            "signal_basis": signal_basis,
            "catalyst_status": catalyst_status,
            "reversal_risk": reversal_risk,
            "reversal_risk_detail": reversal_risk_detail,
        })

    if not rows:
        return pd.DataFrame()
    result = pd.DataFrame(rows)
    return result.sort_values(
        [
            "direction",
            "self_momentum_score",
            "self_latest_step",
            "conviction",
            "confirmation_count",
            "strength",
        ],
        ascending=[True, False, False, False, False, False],
    ).reset_index(drop=True)




def annotate_conviction_dynamics(conviction: pd.DataFrame) -> pd.DataFrame:
    """
    Track conviction quality from refresh to refresh in the current Streamlit session.

    This does not alter conviction, direction, or ranking. It only labels whether
    evidence quality is strengthening, stable, or fading.
    """
    if conviction.empty:
        return conviction

    state_key = "_advisor_conviction_history_v1"
    history = st.session_state.get(state_key, {})
    updated: Dict[str, dict] = {}
    result = conviction.copy()

    health_values = []
    delta_values = []
    tier_change_values = []

    tier_rank = {
        "LOW": 0,
        "DEVELOPING": 1,
        "CONFIRMED": 2,
        "HIGH CONVICTION": 3,
    }

    for _, row in result.iterrows():
        ticker = str(row["ticker"])
        direction = str(row["direction"])
        current = float(row["conviction"])
        current_tier = str(row["tier"])
        current_confirm = int(row.get("confirmation_count") or 0)

        prev = history.get(ticker)
        if not prev or prev.get("direction") != direction:
            health = "NEW"
            delta = 0.0
            tier_change = ""
        else:
            prev_conviction = float(prev.get("conviction", current))
            prev_tier = str(prev.get("tier", current_tier))
            prev_confirm = int(prev.get("confirmation_count", current_confirm))

            delta = current - prev_conviction
            confirm_delta = current_confirm - prev_confirm

            if delta >= 5.0 or confirm_delta >= 2:
                health = "STRENGTHENING"
            elif delta <= -5.0 or confirm_delta <= -2:
                health = "FADING"
            else:
                health = "STABLE"

            tier_diff = tier_rank.get(current_tier, 0) - tier_rank.get(prev_tier, 0)
            if tier_diff > 0:
                tier_change = f"UPGRADE {prev_tier} → {current_tier}"
            elif tier_diff < 0:
                tier_change = f"DOWNGRADE {prev_tier} → {current_tier}"
            else:
                tier_change = ""

        updated[ticker] = {
            "direction": direction,
            "conviction": current,
            "tier": current_tier,
            "confirmation_count": current_confirm,
        }

        health_values.append(health)
        delta_values.append(delta)
        tier_change_values.append(tier_change)

    st.session_state[state_key] = updated
    result["health"] = health_values
    result["conviction_delta"] = delta_values
    result["tier_change"] = tier_change_values
    return result


def render_top_conviction(conviction: pd.DataFrame) -> None:
    section_title("AssitAI Recommendation")

    if conviction.empty:
        st.info("No high-quality momentum or bearish setup right now.")
        return

    buys = conviction[
        (conviction["direction"] == "BUY")
        & (conviction["conviction"] >= 50)
    ].sort_values(
        ["self_momentum_score", "self_latest_step", "conviction"],
        ascending=[False, False, False],
    )

    sells = conviction[
        (conviction["direction"] == "SELL")
        & (conviction["conviction"] >= 50)
    ].sort_values(
        ["self_momentum_score", "self_latest_step", "conviction"],
        ascending=[False, False, False],
    )

    col1, col2 = st.columns(2)

    def render_one(container, frame: pd.DataFrame, title: str, icon: str, bullish: bool):
        with container:
            st.markdown(
                f'<div class="ta-section-title" style="margin-top:2px !important;">{icon} {title}</div>',
                unsafe_allow_html=True,
            )
            if frame.empty:
                st.info("No qualifying setup right now.")
                return

            top = frame.iloc[0]
            runner = frame.iloc[1] if len(frame) > 1 else None

            health = str(top.get("health") or "NEW")
            delta = float(top.get("conviction_delta") or 0.0)
            tier_change = str(top.get("tier_change") or "")

            factors = top.get("factor_details") or []
            factor_lines = []
            status_icon = {
                "aligned": "✅",
                "neutral": "➖",
                "conflict": "⚠️",
                "missing": "◻️",
            }
            for factor in factors:
                icon_f = status_icon.get(str(factor.get("status")), "•")
                factor_lines.append(
                    f"{icon_f} <b>{factor.get('name')}</b>: {factor.get('detail')}"
                )
            factors_html = "<br>".join(factor_lines)

            if health == "STRENGTHENING":
                health_icon = "📈"
                health_text = f"STRENGTHENING {delta:+.1f} pts"
            elif health == "FADING":
                health_icon = "📉"
                health_text = f"FADING {delta:+.1f} pts"
            elif health == "STABLE":
                health_icon = "➖"
                health_text = f"STABLE {delta:+.1f} pts"
            else:
                health_icon = "🆕"
                health_text = "NEW"

            move_class = "up" if bullish else "down"
            tier = str(top["tier"])
            reasons = " · ".join(str(x) for x in (top.get("reasons") or [])[:3])
            penalties = " · ".join(str(x) for x in (top.get("penalties") or [])[:2])

            html = f"""
            <div class="mover-card {'buy-card' if bullish else 'sell-card'}" style="min-height:auto;">
              <div class="rank">#{1} · {tier}</div>
              <div class="ticker">{top['ticker']} — {top['label']}</div>
              <div class="move {move_class}">Conviction {float(top['conviction']):.0f}/100</div>
              <div class="mini-row"><b>Confirmation</b>&nbsp;{int(top['confirmation_count'])}/{int(top['confirmation_total'])} factors aligned</div>
              <div class="mini-row"><b>Signal health</b>&nbsp;{health_icon} {health_text}</div>
              <div class="mini-row"><b>Signal basis</b>&nbsp;{top.get('signal_basis') or 'MOMENTUM-DRIVEN'}</div>
              <div class="mini-row"><b>Catalyst</b>&nbsp;{top.get('catalyst_status') or 'None confirmed'}</div>
              <div class="mini-row"><b>Reversal risk</b>&nbsp;{top.get('reversal_risk') or 'MEDIUM'}</div>
              <div class="small" style="margin-top:5px;line-height:1.45;">
                <b>11 confirmation factors</b><br>{factors_html}
              </div>
              <div class="mini-row">
                <b>5m</b>&nbsp;{float(top['m5']):+.2f}%&nbsp;&nbsp;&nbsp;
                <b>15m</b>&nbsp;{float(top['m15']):+.2f}%&nbsp;&nbsp;&nbsp;
                <b>1h</b>&nbsp;{float(top['h1']):+.2f}%&nbsp;&nbsp;&nbsp;
                <b>Day</b>&nbsp;{float(top['day']):+.2f}%
              </div>
              <div class="mini-row">
                <b>Self momentum</b>&nbsp;
                {(
                    f"{float(top['m5']):+.2f}% > {float(top['m15']):+.2f}% > {float(top['h1']):+.2f}%"
                    if bullish
                    else f"{float(top['m5']):+.2f}% < {float(top['m15']):+.2f}% < {float(top['h1']):+.2f}%"
                )}
              </div>
              <div class="mini-row">
                <b>Rel. {top['sector_etf']}</b>&nbsp;{float(top['rel_sector_day']):+.2f} pt
                &nbsp;&nbsp;&nbsp;<b>Vol</b>&nbsp;{('—' if pd.isna(top['volume_ratio_5m']) else f"{float(top['volume_ratio_5m']):.2f}×")}
                &nbsp;&nbsp;&nbsp;<b>Persistence</b>&nbsp;{top['persistence'] or 'NEW'} ×{int(top['persistence_count'])}
              </div>
              <div class="mini-row">
                <b>VWAP</b>&nbsp;{('—' if pd.isna(top['vwap_distance_pct']) else f"{float(top['vwap_distance_pct']):+.2f}%")}
                &nbsp;&nbsp;&nbsp;<b>RSI</b>&nbsp;{('—' if pd.isna(top['rsi_14']) else f"{float(top['rsi_14']):.0f}")}
                &nbsp;&nbsp;&nbsp;<b>ATR</b>&nbsp;{('—' if pd.isna(top['atr_pct']) else f"{float(top['atr_pct']):.2f}%")}
              </div>
            """
            likely_driver = str(top.get("likely_driver") or "")
            likely_driver_detail = str(top.get("likely_driver_detail") or "")
            if likely_driver:
                html += (
                    f'<div class="small" style="margin-top:5px;color:#dbeafe;">'
                    f'<b>Likely driver:</b> {likely_driver}'
                    f'{(" · " + likely_driver_detail) if likely_driver_detail else ""}'
                    f'</div>'
                )
            reversal_risk_detail = str(top.get("reversal_risk_detail") or "")
            if reversal_risk_detail:
                html += (
                    f'<div class="small" style="margin-top:3px;color:#fbbf24;">'
                    f'<b>Reversal risk:</b> {reversal_risk_detail}'
                    f'</div>'
                )
            if reasons:
                html += f'<div class="small" style="margin-top:4px;"><b>Why #1:</b> {reasons}</div>'
            if tier_change:
                html += f'<div class="small" style="margin-top:2px;color:#fbbf24;"><b>{tier_change}</b></div>'
            if penalties:
                html += f'<div class="small" style="margin-top:2px;color:#fbbf24;"><b>Watch:</b> {penalties}</div>'
            html += "</div>"
            st.markdown(html, unsafe_allow_html=True)

            if runner is not None:
                gap = float(top["conviction"]) - float(runner["conviction"])
                st.caption(
                    f"Runner-up: {runner['ticker']} {float(runner['conviction']):.0f}/100"
                    f" · lead {gap:.0f} pts"
                )

    render_one(col1, buys, "TOP MOMENTUM", "🚀", True)
    render_one(col2, sells, "TOP BEARISH", "🐻", False)

    st.caption(
        "Conviction measures agreement of independent evidence, not probability of profit. "
        "Signal health compares the current conviction and confirmation count with the previous refresh: "
        "STRENGTHENING, STABLE, or FADING."
    )


def render_ai_analysis(analysis: pd.DataFrame) -> None:
    st.markdown(
        f"""
        <div style="margin:0 0 4px 0;">
          <div style="font-size:1.05rem;font-weight:800;line-height:1.15;">
            {tr("ai_title")}
          </div>
          <div style="font-size:.68rem;color:#94a3b8;line-height:1.25;margin-top:2px;">
            {tr("ai_caption")}
          </div>
        </div>
        """,
        unsafe_allow_html=True,
    )

    if analysis.empty:
        st.info(tr("ai_no_reco"))
        return

    actionable = analysis[
        analysis["label"].isin([
            tr("ai_buy"),
            tr("ai_strong_buy"),
            tr("ai_sell"),
            tr("ai_strong_sell"),
        ])
    ].copy()

    if actionable.empty:
        st.info(tr("ai_no_reco"))
        return

    actionable = actionable.sort_values(
        ["abs_score", "strength"], ascending=[False, False]
    ).head(6)

    for _, item in actionable.iterrows():
        score = float(item["score"])
        strength = int(item["strength"])
        icon = "🟢" if score > 0 else "🔴"
        persistence = str(item.get("persistence") or "")
        persistence_count = int(item.get("persistence_count") or 0)
        persistence_text = (
            f" · {persistence} ×{persistence_count}"
            if persistence and persistence_count > 0
            else ""
        )

        reasons = item.get("reasons") or []
        warnings = item.get("warnings") or []

        reason_text = " · ".join(str(x) for x in reasons[:2]) if reasons else ""
        warning_text = " · ".join(str(x) for x in warnings[:1]) if warnings else ""

        html = f"""
        <div style="
            padding:7px 10px;
            margin:4px 0;
            border:1px solid rgba(148,163,184,.22);
            border-radius:9px;
            background:rgba(15,23,42,.58);
            line-height:1.25;
        ">
          <div style="font-size:.88rem;font-weight:820;">
            {icon} {item['ticker']} — {item['label']}
            <span style="font-size:.68rem;color:#cbd5e1;font-weight:650;">
              · {tr("ai_strength")} {strength}/100 · score {score:+.1f}{persistence_text}
            </span>
          </div>
        """
        if reason_text:
            html += f"""
          <div style="font-size:.69rem;color:#dbeafe;margin-top:2px;">
            {tr("ai_reasons")}: {reason_text}
          </div>
            """
        if warning_text:
            html += f"""
          <div style="font-size:.67rem;color:#fbbf24;margin-top:1px;">
            {tr("ai_warnings")}: {warning_text}
          </div>
            """
        html += "</div>"

        st.markdown(html, unsafe_allow_html=True)

    st.caption(tr("ai_method"))



@dataclass
class QuoteResult:
    ticker: str
    open_price: float
    last_price: float
    move_pct: float  # true day change vs previous regular-session close
    last_time_et: datetime
    source: str
    previous_close: Optional[float] = None
    since_open_pct: Optional[float] = None
    hour_start_price: Optional[float] = None
    hour_move_pct: Optional[float] = None
    hour_start_time_et: Optional[datetime] = None
    move_5m_pct: Optional[float] = None
    move_15m_pct: Optional[float] = None
    ref_5m_time_et: Optional[datetime] = None
    ref_15m_time_et: Optional[datetime] = None
    volume_ratio_5m: Optional[float] = None
    session_volume: Optional[float] = None
    vwap: Optional[float] = None
    vwap_distance_pct: Optional[float] = None
    atr_pct: Optional[float] = None
    rsi_14: Optional[float] = None
    macd_hist_pct: Optional[float] = None
    support_price: Optional[float] = None
    resistance_price: Optional[float] = None
    support_distance_pct: Optional[float] = None
    resistance_distance_pct: Optional[float] = None


def load_env_file(path: Path) -> None:
    """Load KEY=VALUE pairs without overriding variables already set in Windows/CMD."""
    if not path.exists():
        return
    try:
        for raw in path.read_text(encoding="utf-8-sig").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    except Exception:
        pass


def get_setting(name: str, default: str = "") -> str:
    """Read a setting from Windows/Linux env first, then Streamlit Cloud secrets."""
    env_value = os.getenv(name)
    if env_value is not None and str(env_value).strip():
        return str(env_value).strip()
    try:
        secret_value = st.secrets.get(name, default)
        if secret_value is not None:
            return str(secret_value).strip()
    except Exception:
        pass
    return default


def normalize_tickers(text: str) -> List[str]:
    parts = re.split(r"[\s,;]+", text.upper().strip())
    out: List[str] = []
    seen = set()
    for item in parts:
        t = item.strip()
        if not t or t in seen:
            continue
        if re.fullmatch(r"[A-Z0-9.\-]{1,15}", t):
            seen.add(t)
            out.append(t)
    return out


def load_watchlist() -> List[str]:
    if WATCHLIST_PATH.exists():
        try:
            items = normalize_tickers(WATCHLIST_PATH.read_text(encoding="utf-8-sig"))
            if items:
                return items
        except Exception:
            pass
    return DEFAULT_TICKERS.copy()


def save_watchlist(tickers: Iterable[str]) -> None:
    WATCHLIST_PATH.write_text("\n".join(tickers) + "\n", encoding="utf-8")


def is_regular_session_timestamp(ts: datetime, session_date) -> bool:
    local = ts.astimezone(NY)
    return (
        local.date() == session_date
        and REGULAR_OPEN <= local.time().replace(tzinfo=None) < REGULAR_CLOSE
    )



def _polygon_extended_bars(
    ticker: str,
    api_key: str,
    base_url: str,
    now_et: datetime,
) -> List[Tuple[datetime, dict]]:
    if not api_key:
        return []
    symbol = polygon_symbol(ticker)
    start_date = (now_et.date() - timedelta(days=7)).isoformat()
    end_date = now_et.date().isoformat()
    url = (
        f"{base_url.rstrip('/')}/v2/aggs/ticker/{symbol}/range/1/minute/"
        f"{start_date}/{end_date}"
    )
    try:
        response = requests.get(
            url,
            params={"adjusted": "true", "sort": "asc", "limit": "50000"},
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=12,
        )
        if response.status_code != 200:
            return []
        payload = response.json()
        if payload.get("status") not in {"OK", "DELAYED"}:
            return []
        out: List[Tuple[datetime, dict]] = []
        for bar in payload.get("results") or []:
            ts_ms = bar.get("t")
            if ts_ms is None:
                continue
            ts_et = datetime.fromtimestamp(
                float(ts_ms) / 1000.0, tz=ZoneInfo("UTC")
            ).astimezone(NY)
            out.append((ts_et, bar))
        return out
    except Exception:
        return []


def _previous_regular_close_from_polygon(
    parsed: List[Tuple[datetime, dict]],
    before_date,
) -> Optional[float]:
    prior = [
        (ts, bar)
        for ts, bar in parsed
        if ts.date() < before_date
        and REGULAR_OPEN <= ts.time().replace(tzinfo=None) < REGULAR_CLOSE
    ]
    if not prior:
        return None
    prev_date = prior[-1][0].date()
    prev_session = [(ts, bar) for ts, bar in prior if ts.date() == prev_date]
    try:
        close = float(prev_session[-1][1].get("c"))
        return close if close > 0 else None
    except Exception:
        return None


@st.cache_data(ttl=45, show_spinner=False)
def fetch_premarket_ranking(
    tickers: Tuple[str, ...],
    api_key: str = "",
    base_url: str = DEFAULT_BASE_URL,
) -> pd.DataFrame:
    now_et = datetime.now(NY)
    rows: List[dict] = []

    def polygon_one(ticker: str) -> Optional[dict]:
        parsed = _polygon_extended_bars(ticker, api_key, base_url, now_et)
        if not parsed:
            return None
        pre = [
            (ts, bar)
            for ts, bar in parsed
            if ts.date() == now_et.date()
            and dt_time(4, 0) <= ts.time().replace(tzinfo=None) < REGULAR_OPEN
        ]
        if not pre:
            return None
        prev_close = _previous_regular_close_from_polygon(parsed, now_et.date())
        if prev_close is None:
            return None
        latest_ts, bar = pre[-1]
        try:
            price = float(bar.get("c"))
        except Exception:
            return None
        if price <= 0:
            return None

        closes = []
        volumes = []
        for _ts, _bar in pre:
            try:
                closes.append(float(_bar.get("c")))
            except Exception:
                closes.append(float("nan"))
            try:
                volumes.append(float(_bar.get("v") or 0.0))
            except Exception:
                volumes.append(0.0)

        def recent_move(minutes: int) -> Optional[float]:
            if len(closes) < 2:
                return None
            ref_idx = max(0, len(closes) - 1 - minutes)
            ref = closes[ref_idx]
            if not pd.notna(ref) or ref <= 0:
                return None
            return (price / ref - 1.0) * 100.0

        vol_ratio = None
        if len(volumes) >= 10:
            recent_vol = sum(volumes[-5:])
            baseline_slice = volumes[max(0, len(volumes)-35):-5]
            if baseline_slice:
                baseline_5m = (sum(baseline_slice) / len(baseline_slice)) * 5.0
                if baseline_5m > 0:
                    vol_ratio = recent_vol / baseline_5m

        return {
            "ticker": ticker,
            "premarket_change_pct": (price / prev_close - 1.0) * 100.0,
            "premarket_move_5m_pct": recent_move(5),
            "premarket_move_15m_pct": recent_move(15),
            "premarket_volume_ratio_5m": vol_ratio,
            "previous_close": prev_close,
            "premarket_price": price,
            "premarket_time_et": latest_ts,
            "source": "Polygon/Massive",
        }

    def yf_one(ticker: str) -> Optional[dict]:
        try:
            hist = yf.Ticker(ticker).history(
                period="5d", interval="1m", prepost=True,
                auto_adjust=False, actions=False,
            )
            if hist is None or hist.empty:
                return None
            frame = hist.copy()
            idx = pd.DatetimeIndex(frame.index)
            if idx.tz is None:
                idx = idx.tz_localize("UTC")
            frame.index = idx.tz_convert(NY)

            pre_mask = [
                ts.date() == now_et.date()
                and dt_time(4, 0) <= ts.time().replace(tzinfo=None) < REGULAR_OPEN
                for ts in frame.index
            ]
            pre = frame.loc[pre_mask]
            pre_close = pd.to_numeric(pre.get("Close"), errors="coerce").dropna()
            if pre_close.empty:
                return None

            prior = frame[frame.index.date < now_et.date()].copy()
            reg_mask = [
                REGULAR_OPEN <= ts.time().replace(tzinfo=None) < REGULAR_CLOSE
                for ts in prior.index
            ]
            prior_reg = prior.loc[reg_mask]
            prior_close = pd.to_numeric(prior_reg.get("Close"), errors="coerce").dropna()
            if prior_close.empty:
                return None
            prev_date = prior_reg.loc[prior_close.index].index[-1].date()
            prev_session = prior_reg[prior_reg.index.date == prev_date]
            prev_closes = pd.to_numeric(prev_session.get("Close"), errors="coerce").dropna()
            if prev_closes.empty:
                return None

            price = float(pre_close.iloc[-1])
            prev_close = float(prev_closes.iloc[-1])
            ts = pd.Timestamp(pre_close.index[-1]).to_pydatetime()

            pre_frame = pre.loc[pre_close.index].copy()
            pre_vol = pd.to_numeric(pre_frame.get("Volume"), errors="coerce").fillna(0.0)

            def recent_move(minutes: int) -> Optional[float]:
                if len(pre_close) < 2:
                    return None
                ref_idx = max(0, len(pre_close) - 1 - minutes)
                ref = float(pre_close.iloc[ref_idx])
                if ref <= 0:
                    return None
                return (price / ref - 1.0) * 100.0

            vol_ratio = None
            if len(pre_vol) >= 10:
                recent_vol = float(pre_vol.iloc[-5:].sum())
                baseline = pre_vol.iloc[max(0, len(pre_vol)-35):-5]
                if not baseline.empty:
                    baseline_5m = float(baseline.mean()) * 5.0
                    if baseline_5m > 0:
                        vol_ratio = recent_vol / baseline_5m

            return {
                "ticker": ticker,
                "premarket_change_pct": (price / prev_close - 1.0) * 100.0,
                "premarket_move_5m_pct": recent_move(5),
                "premarket_move_15m_pct": recent_move(15),
                "premarket_volume_ratio_5m": vol_ratio,
                "previous_close": prev_close,
                "premarket_price": price,
                "premarket_time_et": ts,
                "source": "yfinance",
            }
        except Exception:
            return None

    def fetch_one(ticker: str) -> Optional[dict]:
        return polygon_one(ticker) or yf_one(ticker)

    workers = min(10, max(1, len(tickers)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(fetch_one, ticker) for ticker in tickers]
        for future in as_completed(futures):
            try:
                item = future.result()
                if item:
                    rows.append(item)
            except Exception:
                pass

    if not rows:
        return pd.DataFrame()

    return (
        pd.DataFrame(rows)
        .sort_values(["premarket_change_pct", "ticker"], ascending=[False, True])
        .reset_index(drop=True)
    )




def build_premarket_recommendations(
    frame: pd.DataFrame,
    news_items: List[dict],
    now_et: datetime,
) -> pd.DataFrame:
    """
    Premarket-only decision-support model.

    Deliberately separate from the regular-session AI engine.
    Uses current premarket move, 5m/15m premarket momentum, sector-relative
    strength, premarket volume, freshness, and fresh directional catalysts.
    """
    if frame is None or frame.empty:
        return pd.DataFrame()

    work = frame.copy()

    # Premarket sector medians from the same live universe.
    sector_medians: Dict[str, float] = {}
    for sector in set(SECTOR_ETF_BY_TICKER.values()):
        vals = []
        for _, row in work.iterrows():
            ticker = str(row.get("ticker") or "")
            if SECTOR_ETF_BY_TICKER.get(ticker) != sector:
                continue
            v = row.get("premarket_change_pct")
            if v is not None and pd.notna(v):
                vals.append(float(v))
        if vals:
            sector_medians[sector] = float(pd.Series(vals).median())

    rows: List[dict] = []
    for _, row in work.iterrows():
        ticker = str(row.get("ticker") or "")
        move = row.get("premarket_change_pct")
        m5 = row.get("premarket_move_5m_pct")
        m15 = row.get("premarket_move_15m_pct")
        vol = row.get("premarket_volume_ratio_5m")
        ts = row.get("premarket_time_et")

        if move is None or pd.isna(move):
            continue
        move = float(move)
        m5 = None if m5 is None or pd.isna(m5) else float(m5)
        m15 = None if m15 is None or pd.isna(m15) else float(m15)
        vol = None if vol is None or pd.isna(vol) else float(vol)

        try:
            dt = pd.Timestamp(ts).to_pydatetime()
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=NY)
            else:
                dt = dt.astimezone(NY)
            age_min = max(0.0, (now_et - dt).total_seconds() / 60.0)
        except Exception:
            age_min = 999.0

        news_score, news_reasons, rumor = directional_news_score(news_items, ticker, now_et)

        sector = SECTOR_ETF_BY_TICKER.get(ticker, "SPY")
        sector_med = sector_medians.get(sector)
        rel_sector = None if sector_med is None else move - sector_med

        # Direction is established by the actual premarket move.
        if move >= 0.35:
            direction = 1
        elif move <= -0.35:
            direction = -1
        else:
            direction = 0

        score = 0.0
        aligned = 0
        checks = 0
        reasons: List[str] = []
        warnings: List[str] = []

        if direction == 0:
            rows.append({
                "ticker": ticker,
                "signal": "WAIT FOR OPEN",
                "score": 0.0,
                "conviction": 0,
                "basis": "MOMENTUM-DRIVEN",
                "catalyst": "None confirmed",
                "reversal_risk": "HIGH",
                "move": move, "m5": m5, "m15": m15,
                "rel_sector": rel_sector, "sector": sector, "vol": vol,
                "age_min": age_min,
                "reasons": ["Premarket move is not directional enough yet."],
                "warnings": [],
            })
            continue

        # 1) Total premarket move — 20
        checks += 1
        score += min(20.0, 6.0 + abs(move) * 3.0)
        aligned += 1
        reasons.append(f"premarket {move:+.2f}%")

        # 2) Recent momentum — 20
        checks += 1
        recent_ok = (
            m5 is not None and m15 is not None
            and direction * m5 > 0 and direction * m15 > 0
        )
        if recent_ok:
            score += min(20.0, 8.0 + abs(m5)*5.0 + abs(m15)*2.0)
            aligned += 1
            reasons.append(f"5m {m5:+.2f}% · 15m {m15:+.2f}%")
        else:
            score -= 6.0
            warnings.append("recent premarket momentum is not fully aligned")

        # 3) Sector relative strength — 15
        checks += 1
        if rel_sector is not None:
            if direction * rel_sector > 0:
                score += min(15.0, 6.0 + abs(rel_sector)*3.0)
                aligned += 1
                reasons.append(f"vs {sector} {rel_sector:+.2f} pt")
            elif abs(rel_sector) >= 0.75:
                score -= 6.0
                warnings.append(f"underperforming signal direction vs {sector}")

        # 4) Premarket volume — 15
        checks += 1
        if vol is not None:
            if vol >= 1.20:
                score += min(15.0, 8.0 + (vol-1.2)*4.0)
                aligned += 1
                reasons.append(f"volume {vol:.2f}×")
            elif vol >= 0.85:
                score += 4.0
            else:
                score -= 5.0
                warnings.append(f"light premarket volume {vol:.2f}×")
        else:
            warnings.append("premarket volume confirmation unavailable")

        # 5) Catalyst — 25 (intentionally heavier than regular technical micro-signals)
        checks += 1
        aligned_catalyst = direction * news_score > 0
        conflicting_catalyst = direction * news_score < 0
        if aligned_catalyst:
            score += min(25.0, 12.0 + abs(news_score))
            aligned += 1
            reasons.append("fresh catalyst aligned")
        elif conflicting_catalyst:
            score -= min(15.0, 6.0 + abs(news_score))
            warnings.append("fresh news conflicts with price direction")
        else:
            warnings.append("no confirmed directional catalyst")

        # 6) Freshness — 5
        checks += 1
        if age_min <= 5.0:
            score += 5.0
            aligned += 1
        elif age_min <= 10.0:
            score += 2.0
        else:
            score -= 8.0
            warnings.append(f"premarket quote is {age_min:.0f} min old")

        score = max(0.0, min(100.0, score))

        # Conservative gating.
        if age_min > 10.0:
            signal = "WAIT FOR OPEN"
        elif score >= 58 and recent_ok:
            signal = "PREMARKET BUY" if direction > 0 else "PREMARKET SELL"
        elif score >= 48 and aligned_catalyst and recent_ok:
            signal = "PREMARKET BUY" if direction > 0 else "PREMARKET SELL"
        else:
            signal = "WAIT FOR OPEN"

        basis = "CATALYST-BACKED" if aligned_catalyst else "MOMENTUM-DRIVEN"
        catalyst = (
            "Positive" if aligned_catalyst and direction > 0 else
            "Negative" if aligned_catalyst and direction < 0 else
            "Conflicting" if conflicting_catalyst else
            "None confirmed"
        )

        # Reversal risk: descriptive only.
        risk_pts = 0
        if not aligned_catalyst:
            risk_pts += 2
        if not recent_ok:
            risk_pts += 2
        if vol is None or vol < 0.85:
            risk_pts += 1
        if abs(move) >= 5.0:
            risk_pts += 1
        if rumor:
            risk_pts += 1

        reversal_risk = "HIGH" if risk_pts >= 4 else "MEDIUM" if risk_pts >= 2 else "LOWER"

        rows.append({
            "ticker": ticker,
            "signal": signal,
            "score": round(score, 1),
            "conviction": int(round(score)),
            "basis": basis,
            "catalyst": catalyst,
            "reversal_risk": reversal_risk,
            "move": move,
            "m5": m5,
            "m15": m15,
            "rel_sector": rel_sector,
            "sector": sector,
            "vol": vol,
            "age_min": age_min,
            "reasons": reasons[:4],
            "warnings": warnings[:3],
        })

    if not rows:
        return pd.DataFrame()

    result = pd.DataFrame(rows)
    rank_order = {"PREMARKET BUY": 0, "PREMARKET SELL": 0, "WAIT FOR OPEN": 1}
    result["_wait_rank"] = result["signal"].map(rank_order).fillna(1)
    result = result.sort_values(
        ["_wait_rank", "conviction", "ticker"],
        ascending=[True, False, True],
    ).drop(columns=["_wait_rank"]).reset_index(drop=True)
    return result


def render_premarket_recommendation(recs: pd.DataFrame) -> None:
    st.markdown(
        '<div class="ta-section-title">AssitAI Premarket Recommendation</div>',
        unsafe_allow_html=True,
    )

    if recs is None or recs.empty:
        st.info("No reliable premarket recommendation right now.")
        return

    actionable = recs[recs["signal"].isin(["PREMARKET BUY", "PREMARKET SELL"])].copy()

    if actionable.empty:
        best = recs.sort_values("conviction", ascending=False).iloc[0]
        st.info(
            f"WAIT FOR OPEN — no premarket setup is strong enough yet. "
            f"Best observed: {best['ticker']} {int(best['conviction'])}/100."
        )
        return

    buys = actionable[actionable["signal"] == "PREMARKET BUY"].sort_values(
        "conviction", ascending=False
    )
    sells = actionable[actionable["signal"] == "PREMARKET SELL"].sort_values(
        "conviction", ascending=False
    )

    cols = st.columns(2)

    def card(container, frame: pd.DataFrame, title: str):
        with container:
            st.markdown(f"**{title}**")
            if frame.empty:
                st.caption("No qualifying setup.")
                return
            top = frame.iloc[0]
            reasons = " · ".join(str(x) for x in (top.get("reasons") or []))
            warnings = " · ".join(str(x) for x in (top.get("warnings") or []))
            m5 = "—" if pd.isna(top.get("m5")) else f"{float(top['m5']):+.2f}%"
            m15 = "—" if pd.isna(top.get("m15")) else f"{float(top['m15']):+.2f}%"
            rel = "—" if pd.isna(top.get("rel_sector")) else f"{float(top['rel_sector']):+.2f} pt"
            vol = "—" if pd.isna(top.get("vol")) else f"{float(top['vol']):.2f}×"

            html = f"""
            <div class="mover-card">
              <div class="ticker">{top['ticker']} — {top['signal']}</div>
              <div class="move {'up' if top['signal']=='PREMARKET BUY' else 'down'}">
                Premarket conviction {int(top['conviction'])}/100
              </div>
              <div class="mini-row"><b>Signal basis</b>&nbsp;{top['basis']}</div>
              <div class="mini-row"><b>Catalyst</b>&nbsp;{top['catalyst']}</div>
              <div class="mini-row"><b>Reversal risk</b>&nbsp;{top['reversal_risk']}</div>
              <div class="mini-row">
                <b>Pre-market</b>&nbsp;{float(top['move']):+.2f}%&nbsp;&nbsp;
                <b>5m</b>&nbsp;{m5}&nbsp;&nbsp;
                <b>15m</b>&nbsp;{m15}
              </div>
              <div class="mini-row">
                <b>Rel. {top['sector']}</b>&nbsp;{rel}&nbsp;&nbsp;
                <b>Vol</b>&nbsp;{vol}
              </div>
              <div class="small" style="margin-top:4px;"><b>Why:</b> {reasons}</div>
            """
            if warnings:
                html += f'<div class="small" style="margin-top:2px;color:#fbbf24;"><b>Watch:</b> {warnings}</div>'
            html += "</div>"
            st.markdown(html, unsafe_allow_html=True)

    card(cols[0], buys, "TOP PREMARKET BUY")
    card(cols[1], sells, "TOP PREMARKET SELL")

    st.caption(
        "Premarket conviction measures evidence agreement, not probability of profit. "
        "Premarket signals are more fragile because liquidity and spreads can differ from regular trading."
    )


def render_premarket_ranking(frame: pd.DataFrame) -> None:
    st.subheader(tr("premarket_title"))
    st.caption(tr("premarket_caption"))

    if frame.empty:
        st.info(tr("premarket_none"))
        return

    display = frame.copy()
    display.insert(0, tr("rank"), range(1, len(display) + 1))
    display[tr("premarket_change")] = display["premarket_change_pct"].map(
        lambda x: f"{x:+.2f}%"
    )
    display["Pre-market $"] = (display["premarket_price"] - display["previous_close"]).map(
        lambda x: "—" if pd.isna(x) else f"${x:+,.2f}"
    )
    display[tr("premarket_prev_close")] = display["previous_close"].map(
        lambda x: f"${x:.2f}"
    )
    display[tr("premarket_price")] = display["premarket_price"].map(
        lambda x: f"${x:.2f}"
    )
    display[tr("premarket_time")] = display["premarket_time_et"].map(
        lambda x: pd.Timestamp(x).strftime("%d/%m/%Y %H:%M:%S ET")
    )

    st.dataframe(
        display[
            [
                tr("rank"),
                "ticker",
                tr("premarket_change"),
                "Pre-market $",
                tr("premarket_prev_close"),
                tr("premarket_price"),
                tr("premarket_time"),
                "source",
            ]
        ].rename(columns={"ticker": "Ticker", "source": "Source"}),
        use_container_width=True,
        hide_index=True,
    )



@st.cache_data(ttl=45, show_spinner=False)
def fetch_afterhours_ranking(
    tickers: Tuple[str, ...],
    api_key: str = "",
    base_url: str = DEFAULT_BASE_URL,
) -> pd.DataFrame:
    now_et = datetime.now(NY)
    rows: List[dict] = []

    def polygon_one(ticker: str) -> Optional[dict]:
        parsed = _polygon_extended_bars(ticker, api_key, base_url, now_et)
        if not parsed:
            return None

        regular = [
            (ts, bar)
            for ts, bar in parsed
            if ts.date() == now_et.date()
            and REGULAR_OPEN <= ts.time().replace(tzinfo=None) < REGULAR_CLOSE
        ]
        after = [
            (ts, bar)
            for ts, bar in parsed
            if ts.date() == now_et.date()
            and REGULAR_CLOSE <= ts.time().replace(tzinfo=None) < dt_time(20, 0)
        ]
        if not regular or not after:
            return None
        try:
            regular_close = float(regular[-1][1].get("c"))
            latest_ts, latest_bar = after[-1]
            price = float(latest_bar.get("c"))
        except Exception:
            return None
        if regular_close <= 0 or price <= 0:
            return None

        return {
            "ticker": ticker,
            "afterhours_change_pct": (price / regular_close - 1.0) * 100.0,
            "regular_close": regular_close,
            "afterhours_price": price,
            "afterhours_time_et": latest_ts,
            "source": "Polygon/Massive",
        }

    def yf_one(ticker: str) -> Optional[dict]:
        try:
            hist = yf.Ticker(ticker).history(
                period="5d", interval="1m", prepost=True,
                auto_adjust=False, actions=False,
            )
            if hist is None or hist.empty:
                return None
            frame = hist.copy()
            idx = pd.DatetimeIndex(frame.index)
            if idx.tz is None:
                idx = idx.tz_localize("UTC")
            frame.index = idx.tz_convert(NY)

            reg_mask = [
                ts.date() == now_et.date()
                and REGULAR_OPEN <= ts.time().replace(tzinfo=None) < REGULAR_CLOSE
                for ts in frame.index
            ]
            after_mask = [
                ts.date() == now_et.date()
                and REGULAR_CLOSE <= ts.time().replace(tzinfo=None) < dt_time(20, 0)
                for ts in frame.index
            ]
            regular = frame.loc[reg_mask]
            after = frame.loc[after_mask]
            reg_close = pd.to_numeric(regular.get("Close"), errors="coerce").dropna()
            after_close = pd.to_numeric(after.get("Close"), errors="coerce").dropna()
            if reg_close.empty or after_close.empty:
                return None
            regular_close = float(reg_close.iloc[-1])
            price = float(after_close.iloc[-1])
            ts = pd.Timestamp(after_close.index[-1]).to_pydatetime()
            return {
                "ticker": ticker,
                "afterhours_change_pct": (price / regular_close - 1.0) * 100.0,
                "regular_close": regular_close,
                "afterhours_price": price,
                "afterhours_time_et": ts,
                "source": "yfinance",
            }
        except Exception:
            return None

    def fetch_one(ticker: str) -> Optional[dict]:
        return polygon_one(ticker) or yf_one(ticker)

    workers = min(10, max(1, len(tickers)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(fetch_one, ticker) for ticker in tickers]
        for future in as_completed(futures):
            try:
                item = future.result()
                if item:
                    rows.append(item)
            except Exception:
                pass

    if not rows:
        return pd.DataFrame()

    return (
        pd.DataFrame(rows)
        .sort_values(["afterhours_change_pct", "ticker"], ascending=[False, True])
        .reset_index(drop=True)
    )


def render_afterhours_ranking(frame: pd.DataFrame) -> None:
    st.subheader(tr("afterhours_title"))
    st.caption(tr("afterhours_caption"))

    if frame.empty:
        st.info(tr("afterhours_none"))
        return

    display = frame.copy()
    display.insert(0, tr("rank"), range(1, len(display) + 1))
    display[tr("afterhours_change")] = display["afterhours_change_pct"].map(
        lambda x: f"{x:+.2f}%"
    )
    display["After-hours $"] = (display["afterhours_price"] - display["regular_close"]).map(
        lambda x: "—" if pd.isna(x) else f"${x:+,.2f}"
    )
    display[tr("afterhours_close")] = display["regular_close"].map(
        lambda x: f"${x:.2f}"
    )
    display[tr("afterhours_price")] = display["afterhours_price"].map(
        lambda x: f"${x:.2f}"
    )
    display[tr("afterhours_time")] = display["afterhours_time_et"].map(
        lambda x: pd.Timestamp(x).strftime("%d/%m/%Y %H:%M:%S ET")
    )

    st.dataframe(
        display[
            [
                tr("rank"),
                "ticker",
                tr("afterhours_change"),
                "After-hours $",
                tr("afterhours_close"),
                tr("afterhours_price"),
                tr("afterhours_time"),
                "source",
            ]
        ].rename(columns={"ticker": "Ticker", "source": "Source"}),
        use_container_width=True,
        hide_index=True,
    )


def market_status(now_et: datetime) -> Tuple[str, bool]:
    try:
        import pandas_market_calendars as mcal

        nyse = mcal.get_calendar("NYSE")
        sched = nyse.schedule(start_date=now_et.date(), end_date=now_et.date())
        if sched.empty:
            return tr("market_closed_today"), False
        market_open = sched.iloc[0]["market_open"].to_pydatetime().astimezone(NY)
        market_close = sched.iloc[0]["market_close"].to_pydatetime().astimezone(NY)
        if now_et < market_open:
            return f'{tr("before_regular")} ({market_open:%H:%M} ET)', False
        if now_et >= market_close:
            return f'{tr("market_closed")} ({market_close:%H:%M} ET)', False
        return tr("market_open"), True
    except Exception:
        if now_et.weekday() >= 5:
            return tr("market_closed_today"), False
        t = now_et.time().replace(tzinfo=None)
        if t < REGULAR_OPEN:
            return f'{tr("before_regular")} (09:30 ET)', False
        if t > REGULAR_CLOSE:
            return f'{tr("market_closed")} (16:00 ET)', False
        return tr("market_open"), True


def polygon_symbol(ticker: str) -> str:
    # Polygon US equities commonly uses dots for share classes where Yahoo uses dashes.
    return ticker.replace("-", ".")


def calculate_last_hour_move(
    bars: List[Tuple[datetime, float, float]],
) -> Tuple[Optional[float], Optional[float], Optional[datetime]]:
    """Return reference price, % move, and reference time for the trailing hour.

    Each item is (timestamp_et, open_price, close_price). During the first hour of
    the regular session, the reference is the 09:30 opening price. After one hour,
    the reference is the latest available close at or before T-60 minutes.
    """
    if not bars:
        return None, None, None

    latest_ts, _latest_open, latest_close = bars[-1]
    first_ts, first_open, _first_close = bars[0]
    if latest_close <= 0 or first_open <= 0:
        return None, None, None

    target = latest_ts - timedelta(hours=1)
    if target <= first_ts:
        ref_price = first_open
        ref_time = first_ts
    else:
        eligible = [(ts, close) for ts, _open, close in bars if ts <= target and close > 0]
        if eligible:
            ref_time, ref_price = eligible[-1]
        else:
            ref_price = first_open
            ref_time = first_ts

    if ref_price <= 0:
        return None, None, None
    move_pct = (latest_close / ref_price - 1.0) * 100.0
    return float(ref_price), float(move_pct), ref_time


def calculate_trailing_move(
    bars: List[Tuple[datetime, float, float]], minutes: int
) -> Tuple[Optional[float], Optional[datetime]]:
    """Return % move from approximately N minutes ago to the latest close.

    During the first N minutes after 09:30 ET, the session opening price is used.
    """
    if not bars:
        return None, None
    latest_ts, _latest_open, latest_close = bars[-1]
    first_ts, first_open, _first_close = bars[0]
    if latest_close <= 0 or first_open <= 0:
        return None, None

    target = latest_ts - timedelta(minutes=minutes)
    if target <= first_ts:
        ref_price = first_open
        ref_time = first_ts
    else:
        eligible = [(ts, close) for ts, _op, close in bars if ts <= target and close > 0]
        if eligible:
            ref_time, ref_price = eligible[-1]
        else:
            ref_price = first_open
            ref_time = first_ts

    if ref_price <= 0:
        return None, None
    return float((latest_close / ref_price - 1.0) * 100.0), ref_time



def calculate_volume_ratio_5m(volume_values: List[float]) -> Tuple[Optional[float], Optional[float]]:
    clean = [float(v) for v in volume_values if v is not None and pd.notna(v) and float(v) >= 0]
    if not clean:
        return None, None
    session_volume = float(sum(clean))
    if len(clean) < 6:
        return None, session_volume

    recent = clean[-5:]
    baseline_pool = clean[:-5]
    if not baseline_pool:
        return None, session_volume

    # Prefer up to 30 preceding one-minute bars as the intraday baseline.
    baseline = baseline_pool[-30:]
    recent_avg = sum(recent) / len(recent)
    baseline_avg = sum(baseline) / len(baseline)
    if baseline_avg <= 0:
        return None, session_volume
    return recent_avg / baseline_avg, session_volume




def calculate_intraday_technicals(frame: pd.DataFrame, last_price: float) -> Dict[str, Optional[float]]:
    """Intraday confirmation indicators from regular-session 1-minute bars."""
    out = {
        "vwap": None, "vwap_distance_pct": None, "atr_pct": None,
        "rsi_14": None, "macd_hist_pct": None,
        "support_price": None, "resistance_price": None,
        "support_distance_pct": None, "resistance_distance_pct": None,
    }
    if frame is None or frame.empty or last_price <= 0:
        return out

    f = frame.copy()
    # Normalize column names.
    rename = {}
    for c in f.columns:
        lc = str(c).lower()
        if lc in {"o", "open"}: rename[c] = "Open"
        elif lc in {"h", "high"}: rename[c] = "High"
        elif lc in {"l", "low"}: rename[c] = "Low"
        elif lc in {"c", "close"}: rename[c] = "Close"
        elif lc in {"v", "volume"}: rename[c] = "Volume"
    f = f.rename(columns=rename)
    if "Close" not in f.columns:
        return out

    close = pd.to_numeric(f["Close"], errors="coerce")
    close_valid = close.dropna()
    if close_valid.empty:
        return out

    # VWAP.
    if all(c in f.columns for c in ["High", "Low", "Close", "Volume"]):
        high = pd.to_numeric(f["High"], errors="coerce")
        low = pd.to_numeric(f["Low"], errors="coerce")
        vol = pd.to_numeric(f["Volume"], errors="coerce").fillna(0.0)
        typical = (high + low + close) / 3.0
        cum_vol = vol.cumsum()
        vwap_series = (typical * vol).cumsum() / cum_vol.replace(0, pd.NA)
        valid = vwap_series.dropna()
        if not valid.empty:
            vwap = float(valid.iloc[-1])
            if vwap > 0:
                out["vwap"] = vwap
                out["vwap_distance_pct"] = (last_price / vwap - 1.0) * 100.0

    # ATR(14) on one-minute bars, normalized by price.
    if all(c in f.columns for c in ["High", "Low", "Close"]):
        high = pd.to_numeric(f["High"], errors="coerce")
        low = pd.to_numeric(f["Low"], errors="coerce")
        prev_close = close.shift(1)
        tr = pd.concat([
            high - low,
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ], axis=1).max(axis=1)
        atr = tr.rolling(14, min_periods=5).mean().dropna()
        if not atr.empty:
            out["atr_pct"] = float(atr.iloc[-1]) / last_price * 100.0

    # RSI(14), Wilder-style smoothing.
    delta = close_valid.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1/14, adjust=False, min_periods=14).mean()
    avg_loss = loss.ewm(alpha=1/14, adjust=False, min_periods=14).mean()
    rs = avg_gain / avg_loss.replace(0, pd.NA)
    rsi = (100.0 - 100.0 / (1.0 + rs)).dropna()
    if not rsi.empty:
        out["rsi_14"] = float(rsi.iloc[-1])

    # MACD histogram as % of current price.
    if len(close_valid) >= 26:
        ema12 = close_valid.ewm(span=12, adjust=False).mean()
        ema26 = close_valid.ewm(span=26, adjust=False).mean()
        macd = ema12 - ema26
        signal = macd.ewm(span=9, adjust=False).mean()
        hist = (macd - signal).dropna()
        if not hist.empty:
            out["macd_hist_pct"] = float(hist.iloc[-1]) / last_price * 100.0

    # Recent support/resistance: trailing 30 completed 1-minute bars.
    recent = f.iloc[:-1].tail(30) if len(f) > 1 else f.iloc[0:0]
    if not recent.empty:
        if "Low" in recent.columns:
            lows = pd.to_numeric(recent["Low"], errors="coerce").dropna()
            if not lows.empty:
                support = float(lows.min())
                if support > 0:
                    out["support_price"] = support
                    out["support_distance_pct"] = (last_price / support - 1.0) * 100.0
        if "High" in recent.columns:
            highs = pd.to_numeric(recent["High"], errors="coerce").dropna()
            if not highs.empty:
                resistance = float(highs.max())
                if resistance > 0:
                    out["resistance_price"] = resistance
                    out["resistance_distance_pct"] = (resistance / last_price - 1.0) * 100.0

    return out


def fetch_polygon_one(
    ticker: str,
    api_key: str,
    base_url: str,
    session_date,
    timeout: float = 12.0,
) -> Tuple[Optional[QuoteResult], Optional[str]]:
    symbol = polygon_symbol(ticker)
    date_str = session_date.isoformat()
    history_start = (session_date - timedelta(days=7)).isoformat()
    url = (
        f"{base_url.rstrip('/')}/v2/aggs/ticker/{symbol}/range/1/minute/"
        f"{history_start}/{date_str}"
    )
    params = {
        "adjusted": "true",
        "sort": "asc",
        "limit": "50000",
    }
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        response = requests.get(url, params=params, headers=headers, timeout=timeout)
        if response.status_code != 200:
            return None, f"HTTP {response.status_code}"
        payload = response.json()
        if payload.get("status") not in {"OK", "DELAYED"}:
            return None, str(payload.get("status") or "réponse invalide")
        bars = payload.get("results") or []
        regular = []
        prior_regular = []
        for bar in bars:
            ts_ms = bar.get("t")
            if ts_ms is None:
                continue
            ts_utc = datetime.fromtimestamp(float(ts_ms) / 1000.0, tz=ZoneInfo("UTC"))
            ts_et = ts_utc.astimezone(NY)
            local_t = ts_et.time().replace(tzinfo=None)

            if ts_et.date() == session_date and REGULAR_OPEN <= local_t < REGULAR_CLOSE:
                regular.append((ts_et, bar))
            elif ts_et.date() < session_date and REGULAR_OPEN <= local_t < REGULAR_CLOSE:
                prior_regular.append((ts_et, bar))

        if not regular:
            return None, "aucune bougie de session régulière aujourd'hui"
        if not prior_regular:
            return None, "clôture précédente indisponible"

        first_ts, first = regular[0]
        last_ts, last = regular[-1]
        open_price = float(first.get("o"))
        last_price = float(last.get("c"))

        previous_session_date = prior_regular[-1][0].date()
        previous_session = [
            (ts_et, bar) for ts_et, bar in prior_regular
            if ts_et.date() == previous_session_date
        ]
        previous_close = float(previous_session[-1][1].get("c"))

        if open_price <= 0:
            return None, "prix d'ouverture invalide"
        if previous_close <= 0:
            return None, "clôture précédente invalide"

        since_open_pct = (last_price / open_price - 1.0) * 100.0
        move_pct = (last_price / previous_close - 1.0) * 100.0

        hour_bars: List[Tuple[datetime, float, float]] = []
        volume_values: List[float] = []
        for ts_et, bar in regular:
            try:
                hour_bars.append((ts_et, float(bar.get("o")), float(bar.get("c"))))
                raw_v = bar.get("v")
                if raw_v is not None:
                    volume_values.append(float(raw_v))
            except (TypeError, ValueError):
                continue
        volume_ratio_5m, session_volume = calculate_volume_ratio_5m(volume_values)
        hour_start_price, hour_move_pct, hour_start_time = calculate_last_hour_move(hour_bars)
        move_5m_pct, ref_5m_time = calculate_trailing_move(hour_bars, 5)
        move_15m_pct, ref_15m_time = calculate_trailing_move(hour_bars, 15)

        regular_df = pd.DataFrame(
            [
                {
                    "Open": bar.get("o"),
                    "High": bar.get("h"),
                    "Low": bar.get("l"),
                    "Close": bar.get("c"),
                    "Volume": bar.get("v"),
                }
                for _ts, bar in regular
            ]
        )
        technicals = calculate_intraday_technicals(regular_df, last_price)

        return QuoteResult(
            ticker=ticker,
            open_price=open_price,
            last_price=last_price,
            move_pct=move_pct,
            last_time_et=last_ts,
            source="Polygon/Massive",
            previous_close=previous_close,
            since_open_pct=since_open_pct,
            hour_start_price=hour_start_price,
            hour_move_pct=hour_move_pct,
            hour_start_time_et=hour_start_time,
            move_5m_pct=move_5m_pct,
            move_15m_pct=move_15m_pct,
            ref_5m_time_et=ref_5m_time,
            ref_15m_time_et=ref_15m_time,
            volume_ratio_5m=volume_ratio_5m,
            session_volume=session_volume,
            vwap=technicals["vwap"],
            vwap_distance_pct=technicals["vwap_distance_pct"],
            atr_pct=technicals["atr_pct"],
            rsi_14=technicals["rsi_14"],
            macd_hist_pct=technicals["macd_hist_pct"],
            support_price=technicals["support_price"],
            resistance_price=technicals["resistance_price"],
            support_distance_pct=technicals["support_distance_pct"],
            resistance_distance_pct=technicals["resistance_distance_pct"],
        ), None
    except requests.RequestException as exc:
        return None, f"réseau: {exc.__class__.__name__}"
    except Exception as exc:
        return None, f"{exc.__class__.__name__}: {exc}"


def _extract_yf_frame(data: pd.DataFrame, ticker: str, total: int) -> Optional[pd.DataFrame]:
    if data is None or data.empty:
        return None
    if not isinstance(data.columns, pd.MultiIndex):
        return data.copy() if total == 1 else None

    level0 = [str(x) for x in data.columns.get_level_values(0).unique()]
    level1 = [str(x) for x in data.columns.get_level_values(1).unique()]
    try:
        if ticker in level0:
            return data[ticker].copy()
        if ticker in level1:
            return data.xs(ticker, axis=1, level=1).copy()
    except Exception:
        return None
    return None


def _index_to_new_york(index: pd.Index) -> pd.DatetimeIndex:
    idx = pd.DatetimeIndex(index)
    if idx.tz is None:
        # yfinance intraday is normally tz-aware. If not, assume New York rather than UTC.
        return idx.tz_localize(NY)
    return idx.tz_convert(NY)


def fetch_yfinance_all(tickers: List[str], session_date) -> Tuple[Dict[str, QuoteResult], Dict[str, str]]:
    results: Dict[str, QuoteResult] = {}
    errors: Dict[str, str] = {}
    if not tickers:
        return results, errors
    try:
        data = yf.download(
            tickers=" ".join(tickers),
            period="5d",
            interval="1m",
            group_by="ticker",
            auto_adjust=False,
            prepost=False,
            progress=False,
            threads=True,
            timeout=15,
        )
    except TypeError:
        # Older yfinance versions may not accept timeout.
        data = yf.download(
            tickers=" ".join(tickers),
            period="5d",
            interval="1m",
            group_by="ticker",
            auto_adjust=False,
            prepost=False,
            progress=False,
            threads=True,
        )
    except Exception as exc:
        for ticker in tickers:
            errors[ticker] = f"yfinance: {exc.__class__.__name__}"
        return results, errors

    for ticker in tickers:
        frame = _extract_yf_frame(data, ticker, len(tickers))
        if frame is None or frame.empty:
            errors[ticker] = "aucune donnée yfinance"
            continue
        try:
            frame = frame.copy()
            frame.index = _index_to_new_york(frame.index)
            mask = [
                ts.date() == session_date
                and REGULAR_OPEN <= ts.time().replace(tzinfo=None) < REGULAR_CLOSE
                for ts in frame.index
            ]
            session = frame.loc[mask]
            if session.empty:
                errors[ticker] = "aucune bougie de session régulière aujourd'hui"
                continue

            prior = frame[frame.index.date < session_date].copy()
            prior_mask = [
                REGULAR_OPEN <= ts.time().replace(tzinfo=None) < REGULAR_CLOSE
                for ts in prior.index
            ]
            prior_regular = prior.loc[prior_mask]
            prior_closes = pd.to_numeric(prior_regular.get("Close"), errors="coerce").dropna()
            if prior_closes.empty:
                errors[ticker] = "clôture précédente yfinance indisponible"
                continue

            previous_session_date = prior_regular.loc[prior_closes.index].index[-1].date()
            previous_session = prior_regular[prior_regular.index.date == previous_session_date]
            previous_closes = pd.to_numeric(previous_session.get("Close"), errors="coerce").dropna()
            if previous_closes.empty:
                errors[ticker] = "clôture précédente yfinance indisponible"
                continue
            previous_close = float(previous_closes.iloc[-1])
            opens = pd.to_numeric(session.get("Open"), errors="coerce").dropna()
            closes = pd.to_numeric(session.get("Close"), errors="coerce").dropna()
            if opens.empty or closes.empty:
                errors[ticker] = "prix yfinance incomplets"
                continue
            open_price = float(opens.iloc[0])
            last_price = float(closes.iloc[-1])
            last_valid_index = pd.to_numeric(session.get("Close"), errors="coerce").last_valid_index()
            last_ts = pd.Timestamp(last_valid_index).to_pydatetime()
            if last_ts.tzinfo is None:
                last_ts = last_ts.replace(tzinfo=NY)
            else:
                last_ts = last_ts.astimezone(NY)
            if open_price <= 0:
                errors[ticker] = "prix d'ouverture yfinance invalide"
                continue
            hour_bars: List[Tuple[datetime, float, float]] = []
            open_series = pd.to_numeric(session.get("Open"), errors="coerce")
            close_series = pd.to_numeric(session.get("Close"), errors="coerce")
            for ts, op, cl in zip(session.index, open_series, close_series):
                if pd.isna(op) or pd.isna(cl):
                    continue
                ts_dt = pd.Timestamp(ts).to_pydatetime()
                if ts_dt.tzinfo is None:
                    ts_dt = ts_dt.replace(tzinfo=NY)
                else:
                    ts_dt = ts_dt.astimezone(NY)
                hour_bars.append((ts_dt, float(op), float(cl)))
            hour_start_price, hour_move_pct, hour_start_time = calculate_last_hour_move(hour_bars)
            move_5m_pct, ref_5m_time = calculate_trailing_move(hour_bars, 5)
            move_15m_pct, ref_15m_time = calculate_trailing_move(hour_bars, 15)

            volume_series = pd.to_numeric(session.get("Volume"), errors="coerce").dropna()
            volume_ratio_5m, session_volume = calculate_volume_ratio_5m(
                [float(v) for v in volume_series.tolist()]
            )

            since_open_pct = (last_price / open_price - 1.0) * 100.0
            day_move_pct = (last_price / previous_close - 1.0) * 100.0
            technicals = calculate_intraday_technicals(session, last_price)

            results[ticker] = QuoteResult(
                ticker=ticker,
                open_price=open_price,
                last_price=last_price,
                move_pct=day_move_pct,
                last_time_et=last_ts,
                source="yfinance",
                previous_close=previous_close,
                since_open_pct=since_open_pct,
                hour_start_price=hour_start_price,
                hour_move_pct=hour_move_pct,
                hour_start_time_et=hour_start_time,
                move_5m_pct=move_5m_pct,
                move_15m_pct=move_15m_pct,
                ref_5m_time_et=ref_5m_time,
                ref_15m_time_et=ref_15m_time,
                volume_ratio_5m=volume_ratio_5m,
                session_volume=session_volume,
                vwap=technicals["vwap"],
                vwap_distance_pct=technicals["vwap_distance_pct"],
                atr_pct=technicals["atr_pct"],
                rsi_14=technicals["rsi_14"],
                macd_hist_pct=technicals["macd_hist_pct"],
                support_price=technicals["support_price"],
                resistance_price=technicals["resistance_price"],
                support_distance_pct=technicals["support_distance_pct"],
                resistance_distance_pct=technicals["resistance_distance_pct"],
            )
        except Exception as exc:
            errors[ticker] = f"yfinance: {exc.__class__.__name__}"
    return results, errors


def fetch_polygon_all(
    tickers: List[str], api_key: str, base_url: str, session_date
) -> Tuple[Dict[str, QuoteResult], Dict[str, str]]:
    results: Dict[str, QuoteResult] = {}
    errors: Dict[str, str] = {}
    if not api_key:
        return results, {ticker: "POLYGON_API_KEY absente" for ticker in tickers}

    workers = min(8, max(1, len(tickers)))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(fetch_polygon_one, ticker, api_key, base_url, session_date): ticker
            for ticker in tickers
        }
        for future in as_completed(futures):
            ticker = futures[future]
            try:
                quote, error = future.result()
                if quote is not None:
                    results[ticker] = quote
                elif error:
                    errors[ticker] = error
            except Exception as exc:
                errors[ticker] = f"{exc.__class__.__name__}: {exc}"
    return results, errors


@st.cache_data(ttl=45, show_spinner=False)
def collect_market_data(tickers_tuple: tuple, session_date_iso: str, api_key: str, base_url: str):
    tickers = list(tickers_tuple)
    session_date = datetime.fromisoformat(session_date_iso).date()

    # yfinance: one bulk request. Polygon: exact 1-minute bars per ticker, in parallel.
    yf_results, yf_errors = fetch_yfinance_all(tickers, session_date)
    polygon_results, polygon_errors = fetch_polygon_all(tickers, api_key, base_url, session_date)

    rows = []
    for ticker in tickers:
        poly = polygon_results.get(ticker)
        yahoo = yf_results.get(ticker)

        # Polygon is the preferred ranking source because that is the authenticated feed
        # already validated for the Trading Advisor. yfinance is the fallback.
        chosen = poly or yahoo
        if chosen is None:
            continue

        row = asdict(chosen)

        # Metric invariants:
        # - move_pct is ALWAYS current vs previous regular close.
        # - since_open_pct is ALWAYS current vs today's 09:30 regular open.
        if chosen.previous_close is not None and chosen.previous_close > 0:
            row["move_pct"] = (chosen.last_price / chosen.previous_close - 1.0) * 100.0
        if chosen.open_price is not None and chosen.open_price > 0:
            row["since_open_pct"] = (chosen.last_price / chosen.open_price - 1.0) * 100.0

        row["polygon_move_pct"] = poly.move_pct if poly else None
        row["yfinance_move_pct"] = yahoo.move_pct if yahoo else None
        row["source_gap_pct_points"] = (
            poly.move_pct - yahoo.move_pct if poly is not None and yahoo is not None else None
        )
        row["polygon_since_open_pct"] = poly.since_open_pct if poly else None
        row["yfinance_since_open_pct"] = yahoo.since_open_pct if yahoo else None
        row["polygon_hour_move_pct"] = poly.hour_move_pct if poly else None
        row["yfinance_hour_move_pct"] = yahoo.hour_move_pct if yahoo else None
        row["hour_source_gap_pct_points"] = (
            poly.hour_move_pct - yahoo.hour_move_pct
            if poly is not None and yahoo is not None
            and poly.hour_move_pct is not None and yahoo.hour_move_pct is not None
            else None
        )
        row["polygon_ok"] = poly is not None
        row["yfinance_ok"] = yahoo is not None
        rows.append(row)

    return rows, polygon_errors, yf_errors




@st.cache_data(ttl=45, show_spinner=False)
def fetch_market_context(session_date_iso: str, api_key: str, base_url: str) -> Dict[str, dict]:
    """
    Fetch the benchmark/sector ETFs through the same regular-session pipeline
    as the stocks. This keeps definitions consistent and isolated from rankings.
    """
    rows, _poly_errors, _yf_errors = collect_market_data(
        tuple(CONTEXT_SYMBOLS), session_date_iso, api_key, base_url
    )
    return {str(row["ticker"]): row for row in rows}


def attach_relative_strength(frame: pd.DataFrame, context: Dict[str, dict]) -> pd.DataFrame:
    """
    Add relative-strength fields without changing any existing raw metrics.
    """
    out = frame.copy()

    def sector_for(ticker: str) -> str:
        return SECTOR_ETF_BY_TICKER.get(str(ticker), "SPY")

    def ctx_value(symbol: str, key: str) -> Optional[float]:
        row = context.get(symbol) or {}
        value = row.get(key)
        if value is None or pd.isna(value):
            return None
        return float(value)

    out["sector_etf"] = out["ticker"].map(sector_for)

    def relative(row, horizon_key: str, benchmark: str) -> Optional[float]:
        stock_val = row.get(horizon_key)
        bench_val = ctx_value(benchmark, horizon_key)
        if stock_val is None or pd.isna(stock_val) or bench_val is None:
            return None
        return float(stock_val) - bench_val

    out["rel_sector_day"] = out.apply(
        lambda r: relative(r, "move_pct", r["sector_etf"]), axis=1
    )
    out["rel_qqq_day"] = out.apply(
        lambda r: relative(r, "move_pct", "QQQ"), axis=1
    )
    out["rel_spy_day"] = out.apply(
        lambda r: relative(r, "move_pct", "SPY"), axis=1
    )
    out["rel_sector_hour"] = out.apply(
        lambda r: relative(r, "hour_move_pct", r["sector_etf"]), axis=1
    )

    return out




def _signal_persistence_store_config() -> Optional[dict]:
    """
    Optional persistent store for signal history.

    Configure these Streamlit secrets:
      SUPABASE_URL
      SUPABASE_KEY
      SUPABASE_SIGNAL_TABLE  (optional; default: signal_persistence)
    """
    url = get_setting("SUPABASE_URL", "").rstrip("/")
    key = get_setting("SUPABASE_KEY", "")
    table = get_setting("SUPABASE_SIGNAL_TABLE", "signal_persistence")
    if not url or not key or not table:
        return None
    return {"url": url, "key": key, "table": table}


def _signal_persistence_headers(config: dict) -> dict:
    return {
        "apikey": config["key"],
        "Authorization": f"Bearer {config['key']}",
        "Content-Type": "application/json",
    }


def _load_persistent_signal_history(current_day: str) -> Optional[Dict[str, dict]]:
    """
    Return today's signal history from Supabase.
    Returns None when persistent storage is not configured or temporarily unavailable.
    """
    config = _signal_persistence_store_config()
    if config is None:
        return None

    try:
        url = f"{config['url']}/rest/v1/{config['table']}"
        response = requests.get(
            url,
            headers=_signal_persistence_headers(config),
            params={
                "select": (
                    "ticker,direction,score,count,day,last_bucket,"
                    "first_seen_at,last_seen_at,last_seen_state"
                ),
                "day": f"eq.{current_day}",
            },
            timeout=4,
        )
        response.raise_for_status()
        rows = response.json() or []
        history: Dict[str, dict] = {}
        for row in rows:
            ticker = str(row.get("ticker") or "")
            if ticker:
                history[ticker] = dict(row)
        return history
    except Exception:
        return None


def _upsert_persistent_signal_rows(rows: List[dict]) -> bool:
    """Best-effort Supabase upsert. Returns True only when the write succeeds."""
    if not rows:
        return True

    config = _signal_persistence_store_config()
    if config is None:
        return False

    try:
        url = f"{config['url']}/rest/v1/{config['table']}"
        response = requests.post(
            url,
            headers={
                **_signal_persistence_headers(config),
                "Prefer": "resolution=merge-duplicates,return=minimal",
            },
            params={"on_conflict": "day,ticker"},
            json=rows,
            timeout=5,
        )
        response.raise_for_status()
        return True
    except Exception:
        return False


def _five_minute_observation_bucket(now_et: datetime) -> str:
    """
    Stable observation key so page refreshes or multiple viewers do not
    artificially increase persistence within the same 5-minute market window.
    """
    bucket_minute = (now_et.minute // 5) * 5
    bucket = now_et.replace(
        minute=bucket_minute,
        second=0,
        microsecond=0,
    )
    return bucket.isoformat()


def annotate_signal_persistence(
    analysis: pd.DataFrame,
    now_et: Optional[datetime] = None,
) -> pd.DataFrame:
    """
    Track BUY/SELL persistence across distinct 5-minute observations.

    Primary storage:
    - Supabase when SUPABASE_URL + SUPABASE_KEY are configured.

    Fallback:
    - st.session_state when persistent storage is unavailable.

    Rules:
    - Same BUY/SELL in a NEW 5-minute bucket -> count +1.
    - Repeated reruns inside the SAME 5-minute bucket -> count unchanged.
    - Temporary WATCH/NONE does not erase the last directional history.
    - BUY <-> SELL resets to NEW x1.
    - New trading day starts fresh.
    - No raw market or directional scoring formula is changed.
    """
    if analysis.empty:
        return analysis

    now_et = now_et or datetime.now(NY)
    current_day = now_et.date().isoformat()
    observation_bucket = _five_minute_observation_bucket(now_et)
    now_iso = now_et.isoformat()

    # Persistent storage first; session state remains the safe fallback.
    persistent_history = _load_persistent_signal_history(current_day)
    using_persistent_store = persistent_history is not None

    state_key = "_advisor_signal_history_v3"
    if using_persistent_store:
        history: Dict[str, dict] = persistent_history or {}
    else:
        history = st.session_state.get(state_key, {})

    updated_history: Dict[str, dict] = dict(history)
    rows_to_persist: List[dict] = []
    result = analysis.copy()

    persistence_values = []
    counts = []
    adjusted_strengths = []

    for _, row in result.iterrows():
        ticker = str(row["ticker"])
        score = float(row.get("score", 0.0))
        strength = int(row.get("strength", 0))

        direction = "BUY" if score >= 28 else "SELL" if score <= -28 else "NONE"
        prev = dict(history.get(ticker, {}) or {})

        if str(prev.get("day") or "") != current_day:
            prev = {}

        prev_direction = str(prev.get("direction") or "NONE")
        prev_score = float(prev.get("score") or 0.0)
        prev_count = int(prev.get("count") or 0)
        prev_bucket = str(prev.get("last_bucket") or "")

        if direction == "NONE":
            # Preserve last BUY/SELL direction/count. A brief WATCH period
            # should not make the next same-direction appearance NEW again.
            status = ""
            count = 0

            if prev_direction in {"BUY", "SELL"} and prev_count > 0:
                record = {
                    **prev,
                    "ticker": ticker,
                    "day": current_day,
                    "last_seen_at": now_iso,
                    "last_seen_state": "NONE",
                }
            else:
                record = {
                    "ticker": ticker,
                    "direction": "NONE",
                    "score": score,
                    "count": 0,
                    "day": current_day,
                    "last_bucket": "",
                    "first_seen_at": None,
                    "last_seen_at": now_iso,
                    "last_seen_state": "NONE",
                }

        elif prev_direction not in {"BUY", "SELL"} or direction != prev_direction:
            # First directional observation today, or genuine reversal.
            status = "NEW"
            count = 1
            record = {
                "ticker": ticker,
                "direction": direction,
                "score": score,
                "count": count,
                "day": current_day,
                "last_bucket": observation_bucket,
                "first_seen_at": now_iso,
                "last_seen_at": now_iso,
                "last_seen_state": direction,
            }

        else:
            # Same direction as the last directional signal.
            is_new_observation = prev_bucket != observation_bucket

            if is_new_observation:
                count = prev_count + 1
                delta_abs = abs(score) - abs(prev_score)

                if delta_abs >= 5.0:
                    status = "STRENGTHENING"
                elif delta_abs <= -5.0:
                    status = "WEAKENING"
                else:
                    status = "CONFIRMED"
            else:
                # Same 5-minute market observation: do not inflate xN.
                count = max(1, prev_count)
                if count <= 1:
                    status = "NEW"
                else:
                    delta_abs = abs(score) - abs(prev_score)
                    if delta_abs >= 5.0:
                        status = "STRENGTHENING"
                    elif delta_abs <= -5.0:
                        status = "WEAKENING"
                    else:
                        status = "CONFIRMED"

            if count >= 2:
                strength += 4
            if count >= 3:
                strength += 3
            if status == "WEAKENING":
                strength -= 3

            record = {
                "ticker": ticker,
                "direction": direction,
                "score": score,
                "count": count,
                "day": current_day,
                "last_bucket": observation_bucket if is_new_observation else prev_bucket,
                "first_seen_at": prev.get("first_seen_at") or now_iso,
                "last_seen_at": now_iso,
                "last_seen_state": direction,
            }

        strength = max(0, min(100, strength))
        updated_history[ticker] = record
        rows_to_persist.append(record)

        persistence_values.append(status)
        counts.append(count)
        adjusted_strengths.append(strength)

    # Always maintain the session copy. It becomes an immediate fallback if
    # Supabase is briefly unavailable on a later rerun.
    st.session_state[state_key] = updated_history

    if using_persistent_store:
        _upsert_persistent_signal_rows(rows_to_persist)

    result["persistence"] = persistence_values
    result["persistence_count"] = counts
    result["strength"] = adjusted_strengths
    return result


def format_last_time(value) -> str:
    try:
        ts = pd.Timestamp(value)
        if ts.tzinfo is None:
            ts = ts.tz_localize(NY)
        else:
            ts = ts.tz_convert(NY)
        return ts.strftime("%H:%M ET")
    except Exception:
        return "—"


def _card_grid(cards: List[str]) -> None:
    st.markdown('<div class="cards-grid">' + "".join(cards) + '</div>', unsafe_allow_html=True)


def render_mover_cards(frame: pd.DataFrame) -> None:
    cards: List[str] = []
    for i, (_, row) in enumerate(frame.iterrows()):
        move = float(row["move_pct"])
        arrow = "▲" if move >= 0 else "▼"
        cards.append(
            f'''<div class="mover-card">
              <div class="rank">#{i + 1}</div>
              <div class="ticker">{row['ticker']}</div>
              <div class="move {'up' if move >= 0 else 'down'}">{arrow} {move:+.2f}%</div>
              <div class="price">${row['last_price']:.2f}</div>
              <div class="small">{tr("previous_close")} ${row['previous_close']:.2f} · {format_last_time(row['last_time_et'])}</div>
            </div>'''
        )
    _card_grid(cards)



def section_title(text: str) -> None:
    st.markdown(
        f'<div class="ta-section-title">{escape(text)}</div>',
        unsafe_allow_html=True,
    )


def render_hour_cards(frame: pd.DataFrame) -> None:
    cards: List[str] = []
    for i, (_, row) in enumerate(frame.iterrows()):
        move = float(row["hour_move_pct"])
        arrow = "▲" if move >= 0 else "▼"
        start_label = format_last_time(row.get("hour_start_time_et"))
        cards.append(
            f'''<div class="mover-card">
              <div class="rank">#{i + 1}</div>
              <div class="ticker">{row['ticker']}</div>
              <div class="move {'up' if move >= 0 else 'down'}">{arrow} {move:+.2f}%</div>
              <div class="price">${row['last_price']:.2f}</div>
              <div class="small">{tr("ref")} {start_label} · {row['source']}</div>
            </div>'''
        )
    _card_grid(cards)


def render_buy_cards(frame: pd.DataFrame) -> None:
    cards: List[str] = []
    for i, (_, row) in enumerate(frame.iterrows()):
        cards.append(
            f'''<div class="mover-card buy-card">
              <div class="rank">{tr("signal")} #{i + 1}</div>
              <div class="ticker">{row['ticker']}</div>
              <div class="buy-label">BUY NOW · momentum</div>
              <div class="mini-row"><b>5m</b> {row['move_5m_pct']:+.2f}% &nbsp; <b>15m</b> {row['move_15m_pct']:+.2f}%</div>
              <div class="mini-row"><b>1h</b> {row['hour_move_pct']:+.2f}% &nbsp; {tr("score")} {row['buy_score']:+.2f}</div>
              <div class="small">${row['last_price']:.2f} · {format_last_time(row['last_time_et'])}</div>
            </div>'''
        )
    _card_grid(cards)

def render_sell_cards(frame: pd.DataFrame) -> None:
    cards: List[str] = []
    for i, (_, row) in enumerate(frame.iterrows()):
        cards.append(
            f'''<div class="mover-card sell-card">
              <div class="rank">{tr("signal")} #{i + 1}</div>
              <div class="ticker">{row['ticker']}</div>
              <div class="sell-label">SELL NOW · momentum</div>
              <div class="mini-row"><b>5m</b> {row['move_5m_pct']:+.2f}% &nbsp; <b>15m</b> {row['move_15m_pct']:+.2f}%</div>
              <div class="mini-row"><b>1h</b> {row['hour_move_pct']:+.2f}% &nbsp; {tr("score")} {row['sell_score']:+.2f}</div>
              <div class="small">${row['last_price']:.2f} · {format_last_time(row['last_time_et'])}</div>
            </div>'''
        )
    _card_grid(cards)


load_env_file(ENV_PATH)

st.set_page_config(page_title="Trading Advisor", page_icon="📊", layout="wide")

# Automatically follow the language configured on the user's phone/browser.
# Streamlit st.context.locale reflects browser navigator.language (e.g. fr-CH, en-US).
try:
    device_locale = (st.context.locale or "en").strip()
except Exception:
    device_locale = "en"
device_lang = device_locale.replace("_", "-").split("-")[0].lower()
LANG = device_lang if device_lang in I18N else "en"


st.markdown(
    """
<style>
/* Stable app palette: dark workspace, readable native widgets */
.stApp {
    background: linear-gradient(135deg, #07111f 0%, #0c1d2e 58%, #10261f 100%);
    color: #f8fafc;
}

/* Hide Streamlit's own top toolbar/header; the Advisor does not need it. */
header[data-testid="stHeader"] {
    display: none !important;
}
[data-testid="stToolbar"] {
    display: none !important;
}

/* Clean public-facing Streamlit chrome without touching app controls. */
#MainMenu {
    visibility: hidden !important;
}
footer {
    visibility: hidden !important;
    height: 0 !important;
}
[data-testid="stDecoration"] {
    display: none !important;
}
[data-testid="stStatusWidget"] {
    display: none !important;
}
[data-testid="stAppDeployButton"] {
    display: none !important;
}
[data-testid="stHeaderActionElements"] {
    display: none !important;
}

/* Remove residual top chrome spacing after hiding the header. */
[data-testid="stAppViewContainer"] > .main {
    padding-top: 0 !important;
}
.block-container {
    padding-top: .75rem !important;
    padding-bottom: 1rem;
    max-width: 1500px;
}
[data-testid="stVerticalBlock"] { gap: .62rem; }

/* One compact title */
.hero {
    padding: 8px 12px;
    border: 1px solid rgba(148,163,184,.28);
    border-radius: 11px;
    background: rgba(15,23,42,.82);
    margin: 0 0 6px 0;
}
.hero h1 {
    margin: 0 !important;
    padding: 0 !important;
    font-size: 1.15rem !important;
    line-height: 1.15 !important;
    color: #f8fafc !important;
}

/* Source/status */
.source-time {
    padding: 5px 9px;
    margin: 0 0 5px;
    border-radius: 9px;
    background: rgba(15,23,42,.72);
    border: 1px solid rgba(96,165,250,.30);
    color: #dbeafe;
    font-size: .72rem;
    font-weight: 700;
    line-height: 1.2;
}
.source-time strong { color: #ffffff; }

/* Section labels */
.ta-section-title {
    font-size: .66rem !important;
    font-weight: 750 !important;
    line-height: 1.15 !important;
    margin: 12px 0 7px !important;
    color: #e2e8f0 !important;
    clear: both;
}

/* Cards */
.cards-grid {
    display: grid;
    grid-template-columns: repeat(5,minmax(0,1fr));
    gap: 8px;
    margin: 4px 0 12px;
}
.mover-card {
    min-height: 126px;
    padding: 9px 10px;
    border-radius: 12px;
    background: rgba(15,23,42,.94);
    border: 1px solid rgba(148,163,184,.34);
    box-shadow: 0 5px 14px rgba(0,0,0,.14);
}
.buy-card {
    border-color: rgba(74,222,128,.55);
    background: rgba(8,36,31,.95);
}
.sell-card {
    border-color: rgba(251,113,133,.58);
    background: rgba(48,16,27,.95);
}
.rank { font-size: .66rem; color: #cbd5e1; line-height: 1.1; }
.ticker { font-size: 1.08rem; font-weight: 800; margin-top: 2px; color: #ffffff; line-height: 1.1; }
.move { font-size: 1.14rem; font-weight: 800; margin: 4px 0 3px; line-height: 1.15; }
.move.up { color: #4ade80; }
.move.down { color: #fb7185; }
.price { color: #ffffff; font-size: .89rem; font-weight: 650; margin: 2px 0; }
.small { color: #cbd5e1; font-size: .66rem; line-height: 1.25; }
.buy-label { color: #86efac; font-size: .70rem; font-weight: 850; margin: 4px 0; }
.sell-label { color: #fda4af; font-size: .70rem; font-weight: 850; margin: 4px 0; }
.mini-row { color: #e2e8f0; font-size: .70rem; line-height: 1.35; }

/* Stats */
.stats-grid {
    display: grid;
    grid-template-columns: repeat(4,minmax(0,1fr));
    gap: 8px;
    margin: 2px 0 5px;
}
.stat {
    padding: 7px 9px;
    border-radius: 10px;
    background: rgba(15,23,42,.78);
    border: 1px solid rgba(148,163,184,.22);
}
.stat-label { color: #cbd5e1; font-size: .64rem; line-height: 1.1; }
.stat-value { color: #ffffff; font-size: .98rem; font-weight: 800; margin-top: 2px; line-height: 1.1; }

/* Sidebar: dark container + white readable labels; editor remains white/dark text */
section[data-testid="stSidebar"] {
    min-width: 215px !important;
    width: 215px !important;
    background: #0b1726 !important;
}
section[data-testid="stSidebar"] > div {
    padding-top: .65rem !important;
    padding-left: .55rem !important;
    padding-right: .55rem !important;
}
section[data-testid="stSidebar"] label,
section[data-testid="stSidebar"] p,
section[data-testid="stSidebar"] small,
section[data-testid="stSidebar"] [data-testid="stCaptionContainer"] {
    color: #e2e8f0 !important;
}
section[data-testid="stSidebar"] textarea {
    color: #111827 !important;
    background: #ffffff !important;
    caret-color: #111827 !important;
    font-size: .72rem !important;
    line-height: 1.25 !important;
}
section[data-testid="stSidebar"] textarea::placeholder { color: #64748b !important; }
section[data-testid="stSidebar"] .stButton > button {
    min-height: 2.25rem !important;
    padding: .30rem .35rem !important;
    font-size: .73rem !important;
    font-weight: 750 !important;
    border-radius: 8px !important;
    color: #111827 !important;
    background: #f8fafc !important;
    border-color: #cbd5e1 !important;
}

/* Let Streamlit control alert text colors. Do not globally force p/label/h colors. */
[data-testid="stDataFrame"] { font-size: .76rem; }
.stCaption, [data-testid="stCaptionContainer"] {
    font-size: .64rem !important;
    line-height: 1.25 !important;
    margin-top: 4px !important;
    margin-bottom: 8px !important;
    display: block !important;
    clear: both !important;
}
hr { margin: .3rem 0 !important; }

@media (max-width: 900px) {
    .block-container { padding-top: .65rem !important; }
    .cards-grid { grid-template-columns: repeat(2,minmax(0,1fr)); gap: 7px; }
    .stats-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }
    .mover-card { min-height: 118px; padding: 8px; }
    .hero h1 { font-size: 1.03rem !important; }
    .ta-section-title {
        font-size: .62rem !important;
        margin: 10px 0 6px !important;
    }
}
</style>
""",
    unsafe_allow_html=True,
)

if LANG == "ar":
    st.markdown(
        "<style>.stApp { direction: rtl; } [data-testid='stSidebar'] { direction: rtl; }</style>",
        unsafe_allow_html=True,
    )

now_et = datetime.now(NY)
now_ch = datetime.now(ZURICH)
status_text, is_open = market_status(now_et)

source_time_placeholder = st.empty()

st.markdown(
    f"""
<div class="hero">
  <h1>📊 Trading Advisor</h1>
</div>
""",
    unsafe_allow_html=True,
)

watchlist = load_watchlist()
with st.sidebar:
    editable = st.text_area(
        "Watchlist",
        value="\n".join(watchlist),
        height=300,
        help=tr("stock_help"),
        label_visibility="visible",
    )
    selected_tickers = normalize_tickers(editable)

    c1, c2 = st.columns(2, gap="small")
    with c1:
        if st.button("💾 Save", use_container_width=True, help=tr("save")):
            save_watchlist(selected_tickers)
            st.toast(tr("saved"))
    with c2:
        if st.button("🔄 Refresh", use_container_width=True, help=tr("refresh")):
            st.cache_data.clear()
            st.rerun()

    st.caption(f"{len(selected_tickers)} {tr('tickers')}")

api_key = get_setting("POLYGON_API_KEY", "")
base_url = get_setting("MASSIVE_BASE_URL", DEFAULT_BASE_URL) or DEFAULT_BASE_URL

if not selected_tickers:
    st.warning(tr("empty"))
    st.stop()

# -------------------------------------------------------------------
# Outside regular session: show market-hours message + recent news +
# a live extended-hours ranking. Do not show regular-session errors.
# -------------------------------------------------------------------
if not is_open:
    st.markdown(
        f"""
        <div style="
            padding:10px 13px;
            margin:5px 0 8px;
            border-radius:10px;
            border:1px solid rgba(148,163,184,.25);
            background:rgba(15,23,42,.68);
        ">
          <div style="font-size:1rem;font-weight:800;">
            🕒 {tr("closed_title")}
          </div>
          <div style="font-size:.76rem;color:#dbeafe;margin-top:3px;">
            {tr("closed_message")}
          </div>
        </div>
        """,
        unsafe_allow_html=True,
    )

    local_time = now_et.time().replace(tzinfo=None)
    premarket_df = pd.DataFrame()
    afterhours_df = pd.DataFrame()
    news_phase = "regular"
    news_current_frame = None

    if local_time < REGULAR_OPEN:
        premarket_df = fetch_premarket_ranking(tuple(selected_tickers), api_key, base_url)
        news_phase = "premarket"
        news_current_frame = premarket_df
    elif local_time >= REGULAR_CLOSE:
        afterhours_df = fetch_afterhours_ranking(tuple(selected_tickers), api_key, base_url)
        news_phase = "afterhours"
        news_current_frame = afterhours_df

    with st.spinner(tr("news_loading")):
        closed_news = fetch_watchlist_news(tuple(selected_tickers), max_age_hours=36)

    render_news_section(
        closed_news,
        now_et,
        current_frame=news_current_frame,
        phase=news_phase,
    )

    if local_time < REGULAR_OPEN:
        premarket_recs = build_premarket_recommendations(
            premarket_df,
            closed_news,
            now_et,
        )
        render_premarket_recommendation(premarket_recs)
        render_premarket_ranking(premarket_df)
    elif local_time >= REGULAR_CLOSE:
        render_afterhours_ranking(afterhours_df)

    st.stop()

with st.spinner(tr("loading")):
    rows, polygon_errors, yf_errors = collect_market_data(
        tuple(selected_tickers), now_et.date().isoformat(), api_key, base_url
    )

if not rows:
    source_time_placeholder.markdown(
        f'<div class="source-time">🕒 <strong>{tr("source_last")}:</strong> {tr("unavailable")}</div>',
        unsafe_allow_html=True,
    )
    st.error(tr("no_data"))
    m1, m2, m3 = st.columns(3)
    m1.metric("Polygon/Massive", tr("key_detected") if api_key else tr("key_missing"))
    m2.metric(tr("poly_data"), "0")
    m3.metric(tr("yf_data"), "0")

    with st.expander(tr("diagnostic"), expanded=True):
        st.write(tr("diag_text"))
        if polygon_errors:
            st.caption(tr("poly_no_data"))
            for ticker, err in list(polygon_errors.items())[:20]:
                st.write(f"{ticker}: {err}")
        if yf_errors:
            st.caption(tr("yf_no_data"))
            for ticker, err in list(yf_errors.items())[:20]:
                st.write(f"{ticker}: {err}")

    st.stop()

df = pd.DataFrame(rows)

# Advisor-only benchmark/sector context.
# This does not alter the raw regular-session stock calculations.
market_context = fetch_market_context(
    now_et.date().isoformat(), api_key, base_url
)
df = attach_relative_strength(df, market_context)

# Horodatage de la donnée source la plus récente réellement utilisée par l'application.
latest_source_idx = df["last_time_et"].map(pd.Timestamp).idxmax()
latest_source_row = df.loc[latest_source_idx]
latest_source_ts = pd.Timestamp(latest_source_row["last_time_et"]).to_pydatetime()
if latest_source_ts.tzinfo is None:
    latest_source_ts = latest_source_ts.replace(tzinfo=NY)
else:
    latest_source_ts = latest_source_ts.astimezone(NY)

latest_source_name = str(latest_source_row.get("source", "source"))
latest_source_age_min = max(
    0.0,
    (now_et - latest_source_ts).total_seconds() / 60.0,
)

source_time_placeholder.markdown(
    f'''<div class="source-time">
        🕒 <strong>{tr("source_last")}:</strong>
        {latest_source_ts:%d/%m/%Y %H:%M:%S} ET
        · {latest_source_name}
        · {tr("age")} {latest_source_age_min:.1f} {tr("min")}
    </div>''',
    unsafe_allow_html=True,
)

# Affiche une erreur de fraîcheur seulement pendant la séance régulière.
# Hors séance, une donnée ancienne est normale.
if is_open and latest_source_age_min > 5.0:
    st.error(tr("stale_error").format(age=latest_source_age_min))

# Classement journalier standard : prix actuel vs clôture régulière précédente.
best_ranked = df.sort_values(["move_pct", "ticker"], ascending=[False, True]).reset_index(drop=True)
worst_ranked = df.sort_values(["move_pct", "ticker"], ascending=[True, True]).reset_index(drop=True)
top5 = best_ranked.head(5)
worst5 = worst_ranked.head(5)

# Classement sur la dernière heure. Pendant la première heure de séance,
# la référence est le prix d'ouverture de 09:30 ET.
hour_df = df[df["hour_move_pct"].notna()].copy()
hour_ranked = hour_df.sort_values(["hour_move_pct", "ticker"], ascending=[False, True]).reset_index(drop=True)
hour_worst_ranked = hour_df.sort_values(["hour_move_pct", "ticker"], ascending=[True, True]).reset_index(drop=True)
top5_hour = hour_ranked.head(5)
worst5_hour = hour_worst_ranked.head(5)

# "Buy Now" = signal technique de momentum, pas un ordre d'achat.
# Le score privilégie les mouvements les plus récents: 5 min > 15 min > 60 min.
buy_df = df[
    df["move_5m_pct"].notna()
    & df["move_15m_pct"].notna()
    & df["hour_move_pct"].notna()
].copy()
if not buy_df.empty:
    buy_df["bar_age_min"] = buy_df["last_time_et"].map(
        lambda x: max(0.0, (now_et - pd.Timestamp(x).to_pydatetime().astimezone(NY)).total_seconds() / 60.0)
    )
    buy_df = buy_df[
        (buy_df["bar_age_min"] <= 5.0)
        & (buy_df["move_5m_pct"] > 0)
        & (buy_df["move_15m_pct"] > 0)
    ].copy()
    buy_df["buy_score"] = (
        0.55 * buy_df["move_5m_pct"]
        + 0.30 * buy_df["move_15m_pct"]
        + 0.15 * buy_df["hour_move_pct"]
    )
    buy_df = buy_df.sort_values(["buy_score", "move_5m_pct", "ticker"], ascending=[False, False, True])

top5_buy = buy_df.head(5) if not buy_df.empty else buy_df

# "Sell Now" = miroir baissier du signal Buy Now.
# Même pondération, mais seulement si le momentum 5 min ET 15 min est négatif.
sell_df = df[
    df["move_5m_pct"].notna()
    & df["move_15m_pct"].notna()
    & df["hour_move_pct"].notna()
].copy()
if not sell_df.empty:
    sell_df["bar_age_min"] = sell_df["last_time_et"].map(
        lambda x: max(0.0, (now_et - pd.Timestamp(x).to_pydatetime().astimezone(NY)).total_seconds() / 60.0)
    )
    sell_df = sell_df[
        (sell_df["bar_age_min"] <= 5.0)
        & (sell_df["move_5m_pct"] < 0)
        & (sell_df["move_15m_pct"] < 0)
    ].copy()
    sell_df["sell_score"] = (
        0.55 * sell_df["move_5m_pct"]
        + 0.30 * sell_df["move_15m_pct"]
        + 0.15 * sell_df["hour_move_pct"]
    )
    sell_df = sell_df.sort_values(
        ["sell_score", "move_5m_pct", "ticker"],
        ascending=[True, True, True],
    )

top5_sell = sell_df.head(5) if not sell_df.empty else sell_df

# Full Ranking: self-relative momentum improvement.
# The goal is to find stocks whose recent momentum is improving versus
# their own longer-horizon momentum:
#     5m % > 15m % > 1h %
#
# Example:
# QCOM: +0.54% > +0.31% > -1.57%  -> improving strongly
# RIVN: +1.45% < +1.99% < +3.05% -> still strong, but slowing
df = df.copy()

df["_self_momentum_improving"] = (
    df["move_5m_pct"].notna()
    & df["move_15m_pct"].notna()
    & df["hour_move_pct"].notna()
    & (df["move_5m_pct"] > df["move_15m_pct"])
    & (df["move_15m_pct"] > df["hour_move_pct"])
)

# Measure how much the stock has improved versus itself.
df["_improve_15_vs_1h"] = df["move_15m_pct"] - df["hour_move_pct"]
df["_improve_5_vs_15"] = df["move_5m_pct"] - df["move_15m_pct"]

# Total turnaround from the 1h state to the current 5m state.
df["_self_improvement_score"] = (
    df["_improve_15_vs_1h"] + df["_improve_5_vs_15"]
)

df = df.sort_values(
    [
        "_self_momentum_improving",
        "_self_improvement_score",
        "_improve_5_vs_15",
        "move_5m_pct",
        "ticker",
    ],
    ascending=[False, False, False, False, True],
    na_position="last",
).reset_index(drop=True)

poly_ok_count = int(df["polygon_ok"].sum())
yf_ok_count = int(df["yfinance_ok"].sum())

st.markdown(
    f"""<div class="stats-grid">
      <div class="stat"><div class="stat-label">{tr("ranked")}</div><div class="stat-value">{len(df)}</div></div>
      <div class="stat"><div class="stat-label">Polygon/Massive OK</div><div class="stat-value">{poly_ok_count}/{len(selected_tickers)}</div></div>
      <div class="stat"><div class="stat-label">yfinance OK</div><div class="stat-value">{yf_ok_count}/{len(selected_tickers)}</div></div>
      <div class="stat"><div class="stat-label">{tr("latest_data")}</div><div class="stat-value">{latest_source_ts:%d/%m/%Y %H:%M:%S} ET</div></div>
    </div>""",
    unsafe_allow_html=True,
)

with st.spinner(tr("news_loading")):
    impactful_news = fetch_watchlist_news(tuple(selected_tickers), max_age_hours=36)

ai_analysis = build_ai_analysis(
    df, impactful_news, now_et, is_open, context=market_context
)
ai_analysis = annotate_signal_persistence(ai_analysis, now_et=now_et)

conviction_ranking = build_conviction_ranking(ai_analysis)
conviction_ranking = annotate_conviction_dynamics(conviction_ranking)
render_top_conviction(conviction_ranking)

render_ai_analysis(ai_analysis)

section_title(tr("buy_title"))
if top5_buy.empty:
    st.info(tr("buy_none"))
else:
    render_buy_cards(top5_buy)
st.caption(tr("buy_caption"))

section_title(tr("sell_title"))
if top5_sell.empty:
    st.info(tr("sell_none"))
else:
    render_sell_cards(top5_sell)
st.caption(tr("sell_caption"))

is_first_hour = now_et.time().replace(tzinfo=None) < dt_time(10, 30)

section_title(tr("hour_top_first") if is_first_hour else tr("hour_top"))
if top5_hour.empty:
    st.info(tr("hour_none"))
else:
    render_hour_cards(top5_hour)

section_title(tr("hour_bottom_first") if is_first_hour else tr("hour_bottom"))
if worst5_hour.empty:
    st.info(tr("hour_none"))
else:
    render_hour_cards(worst5_hour)

section_title(tr("day_top"))
render_mover_cards(top5)

section_title(tr("day_bottom"))
render_mover_cards(worst5)

render_news_section(impactful_news, now_et, current_frame=df, phase="regular")

st.subheader(tr("full_rank"))
display = df.drop(
    columns=[
        "_self_momentum_improving",
        "_improve_15_vs_1h",
        "_improve_5_vs_15",
        "_self_improvement_score",
    ],
    errors="ignore",
).copy()
display.insert(0, tr("rank"), range(1, len(display) + 1))
display[tr("last_data")] = display["last_time_et"].map(format_last_time)
display[tr("day_change")] = display["move_pct"].map(lambda x: f"{x:+.2f}%")
display["Day $"] = (display["last_price"] - display["previous_close"]).map(
    lambda x: "—" if pd.isna(x) else f"${x:+,.2f}"
)
display[tr("since_open")] = display["since_open_pct"].map(
    lambda x: "—" if pd.isna(x) else f"{x:+.2f}%"
)
display[tr("last_hour")] = display["hour_move_pct"].map(lambda x: "—" if pd.isna(x) else f"{x:+.2f}%")
display["Sector ETF"] = display["sector_etf"]
display["Rel. sector"] = display["rel_sector_day"].map(
    lambda x: "—" if pd.isna(x) else f"{x:+.2f} pt"
)
display["VWAP Δ"] = display["vwap_distance_pct"].map(
    lambda x: "—" if pd.isna(x) else f"{x:+.2f}%"
)
display["RSI 14"] = display["rsi_14"].map(
    lambda x: "—" if pd.isna(x) else f"{x:.0f}"
)
display["ATR %"] = display["atr_pct"].map(
    lambda x: "—" if pd.isna(x) else f"{x:.2f}%"
)
display["5 min"] = display["move_5m_pct"].map(lambda x: "—" if pd.isna(x) else f"{x:+.2f}%")
display["15 min"] = display["move_15m_pct"].map(lambda x: "—" if pd.isna(x) else f"{x:+.2f}%")
display["Vol 5m"] = display["volume_ratio_5m"].map(
    lambda x: "—" if pd.isna(x) else f"{x:.2f}×"
)
display["Polygon %"] = display["polygon_move_pct"].map(lambda x: "—" if pd.isna(x) else f"{x:+.2f}%")
display["yfinance %"] = display["yfinance_move_pct"].map(lambda x: "—" if pd.isna(x) else f"{x:+.2f}%")
display[tr("gap")] = display["source_gap_pct_points"].map(
    lambda x: "—" if pd.isna(x) else f"{x:+.3f} pt"
)
display[tr("previous_close")] = display["previous_close"].map(lambda x: f"${x:,.2f}")
display[tr("open")] = display["open_price"].map(lambda x: f"${x:,.2f}")
display[tr("current")] = display["last_price"].map(lambda x: f"${x:,.2f}")

st.dataframe(
    display[
        [
            tr("rank"), "ticker", tr("current"), tr("day_change"), "Day $", tr("since_open"),
            "5 min", "15 min", tr("last_hour"), "Vol 5m",
            "Sector ETF", "Rel. sector", "VWAP Δ", "RSI 14", "ATR %",
            tr("previous_close"), tr("open"), "source",
            "Polygon %", "yfinance %", tr("gap"), tr("last_data"),
        ]
    ].rename(columns={"ticker": "Ticker", "source": "Source"}),
    hide_index=True,
    use_container_width=True,
    height=min(760, 70 + 35 * len(display)),
)

with st.expander(tr("diagnostic")):
    st.write(tr("diag_text"))
    st.write(f"Base Polygon/Massive: `{base_url}`")
    st.write(f'POLYGON_API_KEY: `{tr("key_yes") if api_key else tr("key_no")}`')
    if polygon_errors:
        bad_poly = pd.DataFrame(
            [{"Ticker": t, "Erreur Polygon": e} for t, e in polygon_errors.items()]
        )
        st.caption(tr("poly_no_data"))
        st.dataframe(bad_poly, hide_index=True, use_container_width=True)
    if yf_errors:
        bad_yf = pd.DataFrame(
            [{"Ticker": t, "Erreur yfinance": e} for t, e in yf_errors.items()]
        )
        st.caption(tr("yf_no_data"))
        st.dataframe(bad_yf, hide_index=True, use_container_width=True)

st.caption(tr("definitions"))
