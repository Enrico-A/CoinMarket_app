const { chromium } = require("playwright");

const YAHOO_FINANCE_URL = "https://finance.yahoo.com/";
const COINMARKETCAP_URL = "https://coinmarketcap.com/";

/**
 * Stampa un messaggio uniforme di errore e termina il processo con codice 1.
 * @param {string} message
 */
function exitWithError(message) {
  console.error(`Errore: ${message}`);
  process.exit(1);
}

/**
 * Restituisce il testo dell'asset cercato dalla riga di comando.
 * Supporta query composte da piu' parole, ad esempio "Ethereum" o "Tesla Inc".
 * @returns {string}
 */
function getCliQuery() {
  return process.argv.slice(2).join(" ").trim();
}

/**
 * Converte una stringa numerica con simboli e separatori in un numero JavaScript.
 * Esempi supportati:
 * - "$2,319.35" -> 2319.35
 * - "+2.68%" -> 2.68
 * - "-1,24%" -> -1.24
 * @param {string} raw
 * @returns {number}
 */
function parseNumber(raw) {
  const normalized = raw
    .replace(/\u2212/g, "-")
    .replace(/[^\d,.\-+]/g, "")
    .trim();

  if (!normalized) {
    throw new Error(`Valore numerico non valido: "${raw}"`);
  }

  const hasComma = normalized.includes(",");
  const hasDot = normalized.includes(".");
  let numeric = normalized;

  if (hasComma && hasDot) {
    numeric = normalized.replace(/,/g, "");
  } else if (hasComma && !hasDot) {
    numeric = normalized.replace(",", ".");
  }

  return Number(numeric);
}

/**
 * Normalizza un testo per confronti morbidi tra query, simboli e nomi asset.
 * @param {string} value
 * @returns {string}
 */
function normalizeText(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Riconosce un ticker "compatto", ad esempio AAPL, TSLA o BRK-B.
 * @param {string} value
 * @returns {boolean}
 */
function isTickerLike(value) {
  return /^[A-Za-z0-9.\-]{1,12}$/.test(value.trim());
}

/**
 * Tenta di chiudere banner cookie o consenso senza interrompere il flusso.
 * Le interfacce dei siti cambiano spesso, quindi usiamo una lista di testi comuni.
 * @param {import("playwright").Page} page
 */
async function dismissConsentBanners(page) {
  const buttonTexts = [
    "Accept all",
    "Accept",
    "I agree",
    "Agree",
    "Consenti",
    "Accetta",
    "Accetta tutto",
    "Reject all",
    "Rifiuta",
    "No thanks",
    "Close",
    "Chiudi",
  ];

  for (const text of buttonTexts) {
    const locator = page.getByRole("button", { name: new RegExp(`^${escapeRegex(text)}$`, "i") }).first();

    try {
      if (await locator.isVisible({ timeout: 1200 })) {
        await locator.click({ timeout: 2000 });
        await page.waitForTimeout(400);
      }
    } catch {
      // Ignoriamo errori di visibilita' o timeout: il banner potrebbe non esserci.
    }
  }
}

/**
 * Esegue l'escape di una stringa per usarla in una RegExp.
 * @param {string} value
 * @returns {string}
 */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Estrae prezzo e variazione da Yahoo Finance.
 * Questo provider e' il preferito per ticker azionari e funziona bene anche
 * per diversi asset digitali.
 * @param {import("playwright").Browser} browser
 * @param {string} query
 * @returns {Promise<{ source: string, price: number, changePercent24h: number }>}
 */
async function fetchFromYahooFinance(browser, query) {
  const page = await browser.newPage();

  try {
    await page.goto(YAHOO_FINANCE_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await dismissConsentBanners(page);

    const searchInput = page.locator('input[name="p"]').first();
    await searchInput.waitFor({ state: "visible", timeout: 15000 });
    await searchInput.fill(query);

    await Promise.all([
      page.waitForLoadState("domcontentloaded"),
      searchInput.press("Enter"),
    ]);

    await dismissConsentBanners(page);
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    const priceSelector = 'fin-streamer[data-field="regularMarketPrice"]';
    const changeSelector = 'fin-streamer[data-field="regularMarketChangePercent"]';

    // Se non siamo gia' su una pagina quotazione coerente, scegliamo il miglior risultato.
    const quoteLooksValid = await yahooQuoteMatchesQuery(page, query);

    if (!quoteLooksValid) {
      if (isTickerLike(query)) {
        await page.goto(`https://finance.yahoo.com/quote/${encodeURIComponent(query)}`, {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });

        if (await yahooQuoteMatchesQuery(page, query)) {
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        } else {
          await page.goto(YAHOO_FINANCE_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
          await dismissConsentBanners(page);
        }
      }

      if (await yahooQuoteMatchesQuery(page, query)) {
        const priceText = await page.locator(priceSelector).first().textContent({ timeout: 15000 });
        const changeText = await page.locator(changeSelector).first().textContent({ timeout: 15000 });

        if (!priceText || !changeText) {
          throw new Error("Yahoo Finance non ha restituito prezzo o variazione leggibili.");
        }

        return {
          source: "Yahoo Finance",
          price: parseNumber(priceText),
          changePercent24h: parseNumber(changeText),
        };
      }

      const lookupRowsVisible = await page.locator("table tbody tr").first().isVisible({ timeout: 4000 }).catch(() => false);

      if (!lookupRowsVisible) {
        await page.goto(`https://finance.yahoo.com/lookup?s=${encodeURIComponent(query)}`, {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });
      }

      const bestResult = await selectBestYahooLookupResult(page, query);
      if (!bestResult) {
        throw new Error("Yahoo Finance non ha trovato un risultato coerente con la query.");
      }

      await page.goto(`https://finance.yahoo.com${bestResult.href}`, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
    }

    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    const priceText = await page.locator(priceSelector).first().textContent({ timeout: 15000 });
    const changeText = await page.locator(changeSelector).first().textContent({ timeout: 15000 });

    if (!priceText || !changeText) {
      throw new Error("Yahoo Finance non ha restituito prezzo o variazione leggibili.");
    }

    return {
      source: "Yahoo Finance",
      price: parseNumber(priceText),
      changePercent24h: parseNumber(changeText),
    };
  } finally {
    await page.close();
  }
}

/**
 * Verifica se la pagina quotazione di Yahoo corrisponde davvero alla query utente.
 * @param {import("playwright").Page} page
 * @param {string} query
 * @returns {Promise<boolean>}
 */
async function yahooQuoteMatchesQuery(page, query) {
  const normalizedQuery = normalizeText(query);

  try {
    const priceVisible = await page
      .locator('fin-streamer[data-field="regularMarketPrice"]')
      .first()
      .isVisible({ timeout: 5000 });

    if (!priceVisible) {
      return false;
    }

    const headerText = await page.locator("h1").first().textContent();
    const normalizedHeader = normalizeText(headerText || "");

    return normalizedHeader.includes(normalizedQuery) || normalizedQuery.includes(normalizedHeader);
  } catch {
    return false;
  }
}

/**
 * Sceglie il risultato Yahoo Finance piu' aderente alla query.
 * @param {import("playwright").Page} page
 * @param {string} query
 * @returns {Promise<{ href: string, score: number } | null>}
 */
async function selectBestYahooLookupResult(page, query) {
  const rows = await page.locator("table tbody tr").evaluateAll((elements) =>
    elements.map((row) => {
      const anchor = row.querySelector('a[href^="/quote/"]');
      const cells = Array.from(row.querySelectorAll("td")).map((cell) => (cell.textContent || "").trim());

      return {
        href: anchor?.getAttribute("href") || "",
        cells,
      };
    })
  );

  const normalizedQuery = normalizeText(query);
  let bestMatch = null;

  for (const row of rows) {
    if (!row.href) {
      continue;
    }

    const symbol = normalizeText(row.cells[0] || "");
    const name = normalizeText(row.cells[1] || "");
    const combined = `${symbol} ${name}`.trim();
    let score = 0;

    if (symbol === normalizedQuery) score += 100;
    if (name === normalizedQuery) score += 95;
    if (name.startsWith(normalizedQuery)) score += 80;
    if (symbol.startsWith(normalizedQuery)) score += 70;
    if (name.includes(normalizedQuery)) score += 50;
    if (symbol.includes(normalizedQuery)) score += 40;
    if (combined.includes(normalizedQuery) && /\busd\b/.test(combined)) score += 15;

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { href: row.href, score };
    }
  }

  if (!bestMatch || bestMatch.score <= 0) {
    return null;
  }

  return bestMatch;
}

/**
 * Estrae prezzo e variazione da CoinMarketCap.
 * Questo fallback e' utile soprattutto per criptovalute quando Yahoo Finance
 * non restituisce una quotazione affidabile.
 * @param {import("playwright").Browser} browser
 * @param {string} query
 * @returns {Promise<{ source: string, price: number, changePercent24h: number }>}
 */
async function fetchFromCoinMarketCap(browser, query) {
  const page = await browser.newPage();

  try {
    await page.goto(COINMARKETCAP_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await dismissConsentBanners(page);

    const searchTrigger = page.locator('[data-test="global-header__search-trigger"]').first();
    await searchTrigger.waitFor({ state: "visible", timeout: 15000 });
    await searchTrigger.click();

    const searchInput = page.locator('[data-test="global-header__search-input"]').first();
    await searchInput.waitFor({ state: "visible", timeout: 10000 });
    await searchInput.fill(query);
    await page.waitForTimeout(1200);

    const bestResultHref = await selectBestCoinMarketCapResult(page, query);
    if (!bestResultHref) {
      throw new Error("CoinMarketCap non ha trovato un asset coerente con la query.");
    }

    await page.goto(`https://coinmarketcap.com${bestResultHref}`, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    const bodyText = await page.locator("body").innerText();
    const metrics = extractCoinMarketCapMetrics(bodyText, query);

    if (!metrics) {
      throw new Error("CoinMarketCap non ha restituito prezzo o variazione nel formato atteso.");
    }

    return {
      source: "CoinMarketCap",
      price: metrics.price,
      changePercent24h: metrics.changePercent24h,
    };
  } finally {
    await page.close();
  }
}

/**
 * Estrae i dati dal testo della pagina CoinMarketCap.
 * Prova prima il blocco "Price Live Data", poi un fallback sul riquadro hero.
 * @param {string} bodyText
 * @param {string} query
 * @returns {{ price: number, changePercent24h: number } | null}
 */
function extractCoinMarketCapMetrics(bodyText, query) {
  const liveDataRegex = /price today\s+is\s+\$([\d,]+(?:\.\d+)?)\s+USD[\s\S]*?\bis\s+(up|down)\s+([\d.]+)%\s+in the last 24 hours/i;
  const liveDataMatch = bodyText.match(liveDataRegex);

  if (liveDataMatch) {
    const direction = liveDataMatch[2].toLowerCase() === "down" ? -1 : 1;
    return {
      price: parseNumber(liveDataMatch[1]),
      changePercent24h: direction * parseNumber(liveDataMatch[3]),
    };
  }

  const assetName = escapeRegex(query);
  const heroRegex = new RegExp(`${assetName}[\\s\\S]*?\\$([\\d,]+(?:\\.\\d+)?)\\s*[\\s\\S]*?(\\d+(?:\\.\\d+)?)%\\s*\\(24h\\)`, "i");
  const heroMatch = bodyText.match(heroRegex);

  if (heroMatch) {
    return {
      price: parseNumber(heroMatch[1]),
      changePercent24h: parseNumber(heroMatch[2]),
    };
  }

  return null;
}

/**
 * Sceglie il miglior risultato nella ricerca di CoinMarketCap.
 * @param {import("playwright").Page} page
 * @param {string} query
 * @returns {Promise<string | null>}
 */
async function selectBestCoinMarketCapResult(page, query) {
  const anchors = await page.locator('a[href^="/currencies/"]').evaluateAll((elements) =>
    elements.map((anchor) => ({
      href: anchor.getAttribute("href") || "",
      text: (anchor.textContent || "").trim(),
    }))
  );

  const normalizedQuery = normalizeText(query);
  let bestMatch = null;

  for (const anchor of anchors) {
    if (!anchor.href) {
      continue;
    }

    const text = normalizeText(anchor.text);
    let score = 0;

    if (text === normalizedQuery) score += 100;
    if (text.startsWith(normalizedQuery)) score += 80;
    if (text.includes(normalizedQuery)) score += 50;
    if (anchor.href.includes(normalizedQuery.replace(/\s+/g, "-"))) score += 40;

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { href: anchor.href, score };
    }
  }

  if (!bestMatch || bestMatch.score <= 0) {
    return null;
  }

  return bestMatch.href;
}

/**
 * Stampa il risultato finale in console in modo leggibile.
 * @param {{ query: string, source: string, price: number, changePercent24h: number }} result
 */
function printResult(result) {
  console.log(`Asset cercato: ${result.query}`);
  console.log(`Fonte: ${result.source}`);
  console.log(`Prezzo attuale (USD): ${result.price}`);
  console.log(`Variazione ultime 24h (%): ${result.changePercent24h}`);
}

async function main() {
  const query = getCliQuery();

  if (!query) {
    exitWithError('devi specificare un asset o ticker. Esempio: `node index.js ETH`');
  }

  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== "false",
  });

  try {
    let result;
    let yahooError;

    try {
      result = await fetchFromYahooFinance(browser, query);
    } catch (error) {
      yahooError = error;
    }

    if (!result) {
      try {
        result = await fetchFromCoinMarketCap(browser, query);
      } catch (cmcError) {
        const reasons = [yahooError?.message, cmcError?.message].filter(Boolean).join(" | ");
        throw new Error(`asset non trovato o non leggibile. Dettagli: ${reasons}`);
      }
    }

    printResult({
      query,
      ...result,
    });
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  exitWithError(error.message);
});
