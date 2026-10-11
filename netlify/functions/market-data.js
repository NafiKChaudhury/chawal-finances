// Netlify Function: on-demand Yahoo Finance lookup with cache and FMP fallbacks.
const YAHOO_CHART='https://query1.finance.yahoo.com/v8/finance/chart';
const FMP_API='https://financialmodelingprep.com/stable';
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value.slice(0,10))?value.slice(0,10):null;
const number=value=>value!==null&&value!==''&&Number.isFinite(Number(value))?Number(value):null;
const first=value=>Array.isArray(value)?value[0]||null:(value&&typeof value==='object'?value:null);
const safeError=error=>error?.message||'Provider unavailable';

async function fetchJson(url,timeoutMs=9000){
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetch(url,{signal:controller.signal,headers:{Accept:'application/json','User-Agent':'Mozilla/5.0 Chawal-Finances/1.0'}});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    return await response.json();
  }finally{
    clearTimeout(timeout);
  }
}

function dateFromEpoch(value){
  const epoch=Number(value);
  return Number.isFinite(epoch)?new Date(epoch*1000).toISOString().slice(0,10):null;
}

function dividendCadence(rows){
  const dates=rows.map(row=>Date.parse(`${row.date}T12:00:00Z`)).filter(Number.isFinite).sort((a,b)=>a-b);
  const gaps=dates.slice(1).map((time,index)=>(time-dates[index])/86400000).filter(days=>days>3&&days<500).sort((a,b)=>a-b);
  const median=gaps.length?gaps[Math.floor(gaps.length/2)]:null;
  const frequency=median===null?null:median<=10?52:median<=20?26:median<=45?12:median<=75?6:median<=135?4:median<=245?2:1;
  return {dates,gaps,median,frequency};
}

function estimatedNextDate(rows,cadence){
  if(!rows.length||!cadence.frequency)return null;
  const last=rows[rows.length-1].date;
  const fallbackDays=Math.max(1,Math.round(365/cadence.frequency));
  const interval=Math.max(1,Math.round(cadence.median||fallbackDays));
  const next=new Date(`${last}T12:00:00Z`);
  const today=new Date();today.setUTCHours(0,0,0,0);
  do{next.setUTCDate(next.getUTCDate()+interval);}while(next<today);
  return next.toISOString().slice(0,10);
}

async function yahooChart(symbol,range='5y'){
  const url=new URL(`${YAHOO_CHART}/${encodeURIComponent(symbol)}`);
  url.searchParams.set('range',range);
  url.searchParams.set('interval','1d');
  url.searchParams.set('events','div');
  url.searchParams.set('includeAdjustedClose','true');
  const payload=await fetchJson(url);
  if(payload?.chart?.error)throw new Error(payload.chart.error.description||'Yahoo Finance rejected the ticker');
  const result=payload?.chart?.result?.[0];
  if(!result)throw new Error('No Yahoo Finance data returned for this ticker');
  return result;
}

function lastClose(result){
  const closes=result?.indicators?.quote?.[0]?.close||[];
  for(let index=closes.length-1;index>=0;index--){
    const value=number(closes[index]);
    if(value!==null&&value>0)return value;
  }
  return null;
}

async function yahooLookup(symbol){
  const result=await yahooChart(symbol);
  const meta=result.meta||{};
  const currency=String(meta.currency||'').toUpperCase();
  if(!['CAD','USD'].includes(currency))throw new Error(`Only CAD and USD securities are supported; Yahoo returned ${currency||'an unknown currency'}`);
  const price=number(meta.regularMarketPrice)||lastClose(result);
  if(!(price>0))throw new Error('Yahoo Finance did not return a current price');

  const dividends=Object.values(result.events?.dividends||{}).map(event=>({date:dateFromEpoch(event.date),amount:number(event.amount)})).filter(event=>event.date&&event.amount!==null&&event.amount>=0).sort((a,b)=>a.date.localeCompare(b.date));
  const cadence=dividendCadence(dividends.slice(-16));
  const latest=dividends[dividends.length-1]||null;
  const nextDate=estimatedNextDate(dividends,cadence);
  let fx={cadPerUnit:1};
  if(currency==='USD'){
    const fxResult=await yahooChart('CAD=X','5d');
    const rate=number(fxResult.meta?.regularMarketPrice)||lastClose(fxResult);
    fx=rate>0?{cadPerUnit:rate}:null;
  }

  const warnings=['Yahoo Finance prices may be delayed.'];
  if(nextDate)warnings.push('The next payment date is estimated from historical dividend timing; review it before saving.');
  else warnings.push('No dividend schedule was returned; enter a payment date manually if this security pays dividends.');
  if(currency==='USD'&&!fx)warnings.push('CAD conversion was unavailable; enter the rate manually.');

  return {
    symbol,
    fetchedAt:new Date().toISOString(),
    source:'Yahoo Finance on demand',
    quote:{price,currency,name:meta.longName||meta.shortName||symbol,exchange:meta.fullExchangeName||meta.exchangeName||null},
    dividend:latest?{amount:latest.amount,exDate:latest.date,paymentDate:nextDate,frequency:cadence.frequency,paymentDateEstimated:Boolean(nextDate)}:null,
    fx,
    warnings
  };
}

async function cachedLookup(symbol,event){
  const host=process.env.URL||process.env.DEPLOY_URL||event.headers?.origin;
  if(!host)return null;
  const response=await fetch(new URL('/data/market-data.json',host),{headers:{Accept:'application/json'},signal:AbortSignal.timeout(4500)});
  if(!response.ok)return null;
  const cache=await response.json();
  const stock=cache?.stocks?.[symbol];
  if(!stock||(!(Number(stock.price)>0)&&!(Number(stock.last_dividend?.amount)>0)))return null;
  const history=(stock.dividend_history||[]).map(row=>({date:validDate(row.date),amount:number(row.amount)})).filter(row=>row.date&&row.amount!==null).sort((a,b)=>a.date.localeCompare(b.date));
  const cadence=dividendCadence(history);
  const currency=String(stock.currency||'').toUpperCase();
  const rate=number(cache?.usd_cad?.rate);
  return {
    symbol,
    fetchedAt:cache.updated_at||stock.retrieved_at||new Date().toISOString(),
    source:'Yahoo Finance daily cache',
    quote:{price:number(stock.price),currency,name:stock.name||symbol},
    dividend:stock.last_dividend?{amount:number(stock.last_dividend.amount),exDate:validDate(stock.last_dividend.date),paymentDate:estimatedNextDate(history,cadence),frequency:cadence.frequency,paymentDateEstimated:true}:null,
    fx:currency==='CAD'?{cadPerUnit:1}:currency==='USD'&&rate>0?{cadPerUnit:rate}:null,
    warnings:['Live Yahoo lookup was unavailable, so cached market data was used. Review values before saving.']
  };
}

async function fmpLookup(symbol){
  const key=process.env.FMP_API_KEY;
  if(!key)return null;
  async function get(endpoint,params={}){
    const url=new URL(`${FMP_API}/${endpoint}`);
    for(const [name,value]of Object.entries(params))url.searchParams.set(name,String(value));
    url.searchParams.set('apikey',key);
    const json=await fetchJson(url);
    if(!Array.isArray(json)&&(!json||typeof json!=='object'||json['Error Message']||json.error))throw new Error('FMP rejected the request');
    return json;
  }
  const [quoteResult,dividendResult]=await Promise.allSettled([get('quote',{symbol}),get('dividends',{symbol})]);
  const quote=quoteResult.status==='fulfilled'?first(quoteResult.value):null;
  const raw=dividendResult.status==='fulfilled'?dividendResult.value:[];
  const rows=(Array.isArray(raw)?raw:(raw?.historical||raw?.data||[])).filter(row=>row&&typeof row==='object').map(row=>({date:validDate(row.paymentDate||row.payment_date||row.date),amount:number(row.dividend??row.adjDividend??row.amount)})).filter(row=>row.date&&row.amount!==null).sort((a,b)=>a.date.localeCompare(b.date));
  if(!quote&&!rows.length)return null;
  const currency=String(quote?.currency||'').toUpperCase();
  if(currency&&!['CAD','USD'].includes(currency))return null;
  const cadence=dividendCadence(rows.slice(-16)),latest=rows[rows.length-1]||null;
  let fx=currency==='CAD'?{cadPerUnit:1}:null;
  if(currency==='USD'){
    try{const rate=number(first(await get('quote',{symbol:'USDCAD'}))?.price);if(rate>0)fx={cadPerUnit:rate};}catch{/* The UI will request a manual rate. */}
  }
  return {symbol,fetchedAt:new Date().toISOString(),source:'Financial Modeling Prep fallback',quote:quote?{price:number(quote.price),currency,name:quote.name||symbol}:null,dividend:latest?{amount:latest.amount,exDate:latest.date,paymentDate:estimatedNextDate(rows,cadence),frequency:cadence.frequency,paymentDateEstimated:true}:null,fx,warnings:['Yahoo Finance was unavailable, so fallback market data was used. Review values before saving.']};
}

exports.handler=async event=>{
  if(event.httpMethod!=='GET')return {statusCode:405,headers:{'Content-Type':'application/json'},body:JSON.stringify({error:'GET required'})};
  const symbol=(event.queryStringParameters?.symbol||'').trim().toUpperCase();
  if(!/^[A-Z0-9][A-Z0-9.\-^]{0,19}$/.test(symbol))return {statusCode:400,headers:{'Content-Type':'application/json'},body:JSON.stringify({error:'Invalid ticker symbol'})};

  const errors=[];
  try{
    const payload=await yahooLookup(symbol);
    return {statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=300, s-maxage=300'},body:JSON.stringify(payload)};
  }catch(error){errors.push(`Yahoo Finance: ${safeError(error)}`);}
  try{
    const payload=await cachedLookup(symbol,event);
    if(payload)return {statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(payload)};
  }catch(error){errors.push(`Daily cache: ${safeError(error)}`);}
  try{
    const payload=await fmpLookup(symbol);
    if(payload)return {statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=300'},body:JSON.stringify(payload)};
  }catch(error){errors.push(`Fallback: ${safeError(error)}`);}
  return {statusCode:502,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({error:'No CAD or USD quote data returned for this Yahoo Finance ticker',details:errors})};
};
