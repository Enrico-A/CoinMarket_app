# CoinMarket Asset Reader

Script Node.js basato su Playwright per cercare dinamicamente un asset finanziario o crypto e leggerne:

- il prezzo attuale in USD
- la variazione percentuale nelle ultime 24 ore

Lo script usa:

- `Yahoo Finance` come sorgente primaria
- `CoinMarketCap` come fallback, soprattutto utile per criptovalute

## Requisiti

- Node.js 18 o superiore
- dipendenze installate con `npm install`

## Installazione

Nel progetto e' gia' presente Playwright come dipendenza di sviluppo. Se serve reinstallare:

```bash
npm install
```

Se il browser di Playwright non fosse ancora presente:

```bash
npx playwright install
```

## Utilizzo

Eseguire lo script passando il nome dell'asset oppure il ticker via riga di comando:

```bash
node index.js Ethereum
node index.js BTC
node index.js AAPL
node index.js "Tesla Inc"
```

## Output atteso

Lo script stampa a console:

- asset cercato
- fonte usata
- prezzo attuale in USD
- variazione percentuale delle ultime 24 ore

Esempio:

```text
Asset cercato: Ethereum
Fonte: CoinMarketCap
Prezzo attuale (USD): 2319.35
Variazione ultime 24h (%): 2.68
```

## Modalita' grafica o headless

Per default Playwright avvia il browser in modalita' headless.

Se vuoi vedere il browser mentre lavora:

```bash
HEADLESS=false node index.js Ethereum
```

Su PowerShell:

```powershell
$env:HEADLESS="false"
node index.js Ethereum
```

## Logica del software

1. Legge la query da `process.argv`
2. Apre Chromium con Playwright
3. Prova a cercare l'asset su Yahoo Finance
4. Se Yahoo Finance non restituisce dati leggibili, prova su CoinMarketCap
5. Estrae:
   - prezzo attuale
   - variazione percentuale 24h
6. Stampa i risultati a console
7. Se l'asset non viene trovato, stampa un errore chiaro e termina con codice `1`

## Gestione errori

Lo script gestisce questi casi:

- nessun argomento passato da riga di comando
- banner di consenso o cookie che bloccano l'interfaccia
- pagina risultati senza quotazione immediata
- asset non trovato
- struttura HTML diversa dal previsto

Se entrambi i provider falliscono, viene mostrato un messaggio con il motivo del fallimento.

## File principali

- [index.js](C:/Users/earfi/Desktop/Codex_project/CoinMarket_app/index.js)
- [README.md](C:/Users/earfi/Desktop/Codex_project/CoinMarket_app/README.md)

## Note tecniche

- Yahoo Finance e CoinMarketCap possono cambiare markup nel tempo; in quel caso i selettori o i parser testuali potrebbero richiedere un aggiornamento.
- Per CoinMarketCap il parser usa prima il blocco testuale "Price Live Data", poi un fallback sul riquadro hero della pagina.
- Il valore percentuale estratto rappresenta la variazione mostrata dal provider nel momento della richiesta.
