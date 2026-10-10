// Netlify Function: keeps the Financial Modeling Prep key on the server.
const API='https://financialmodelingprep.com/stable';
const validDate=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v.slice(0,10))?v.slice(0,10):null;
const num=v=>v!==null&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
const first=a=>Array.isArray(a)?a[0]||null:(a&&typeof a==='object'?a:null);
const safeError=e=>e?.message||'Provider unavailable';
exports.handler=async event=>{
  if(event.httpMethod!=='GET')return {statusCode:405,body:JSON.stringify({error:'GET required'})};
  const symbol=(event.queryStringParameters?.symbol||'').trim().toUpperCase();
  if(!/^[A-Z0-9][A-Z0-9.\-^]{0,19}$/.test(symbol))return {statusCode:400,body:JSON.stringify({error:'Invalid ticker symbol'})};
  // Prefer the published yfinance cache. Do not fetch private repository data.
  try {
    const host=process.env.URL || process.env.DEPLOY_URL;
    if(host){
      const cacheResponse=await fetch(new URL('/data/market-data.json',host),{headers:{Accept:'application/json'},signal:AbortSignal.timeout(4500)});
      if(cacheResponse.ok){
        const cache=await cacheResponse.json();
        const stock=cache?.stocks?.[symbol];
        if(stock && (Number(stock.price)>0 || Number(stock.last_dividend?.amount)>0)){
          const history=(stock.dividend_history||[]).map(x=>x.date).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x)).sort();
          const gaps=history.slice(1).map((d,i)=>(Date.parse(d)-Date.parse(history[i]))/86400000).filter(n=>n>10&&n<400).sort((a,b)=>a-b);
          const median=gaps.length?gaps[Math.floor(gaps.length/2)]:null;
          const frequency=median===null?null:median<46?12:median<135?4:median<245?2:1;
          const currency=String(stock.currency||'').toUpperCase();
          const rate=Number(cache?.usd_cad?.rate);
          return {statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({
            symbol,fetchedAt:cache.updated_at||stock.retrieved_at||new Date().toISOString(),source:'Yahoo Finance via yfinance (daily cache)',
            quote:{price:Number(stock.price)||null,currency,name:stock.name||null},
            dividend:stock.last_dividend?{amount:Number(stock.last_dividend.amount)||null,exDate:validDate(stock.last_dividend.date),paymentDate:null,frequency}:null,
            fx:currency==='CAD'?{cadPerUnit:1}:currency==='USD'&&rate>0?{cadPerUnit:rate}:null,
            warnings:['Cached market data; prices may be delayed. Future payment dates are not provided.']
          })};
        }
      }
    }
  }catch(e){/* Fall through to existing FMP lookup if cache is unavailable. */}
  const key=process.env.FMP_API_KEY;
  if(!key)return {statusCode:503,body:JSON.stringify({error:'FMP_API_KEY is not configured in Netlify environment variables'})};
  async function get(endpoint,params={}){
    const url=new URL(`${API}/${endpoint}`);
    for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));
    url.searchParams.set('apikey',key);
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8500);
    try{const r=await fetch(url,{signal:controller.signal,headers:{Accept:'application/json'}});if(!r.ok)throw new Error(`Provider HTTP ${r.status}`);const json=await r.json();if(!Array.isArray(json)&&(!json||typeof json!=='object'||json['Error Message']||json.error))throw new Error('Provider rejected the request');return json;}
    finally{clearTimeout(timeout);}
  }
  const warnings=[];
  const [q,d]=await Promise.allSettled([get('quote',{symbol}),get('dividends',{symbol})]);
  if(q.status==='rejected')warnings.push(`Quote: ${safeError(q.reason)}.`);
  if(d.status==='rejected')warnings.push(`Dividends: ${safeError(d.reason)}.`);
  const quote= q.status==='fulfilled'?first(q.value):null;
  const rawDiv=d.status==='fulfilled'?d.value:[];
  const divRows=(Array.isArray(rawDiv)?rawDiv:(rawDiv?.historical||rawDiv?.data||[])).filter(x=>x&&typeof x==='object');
  divRows.sort((a,b)=>String(b.date||b.paymentDate||b.payment_date||'').localeCompare(String(a.date||a.paymentDate||a.payment_date||'')));
  const today=new Date().toISOString().slice(0,10);
  const future=divRows.filter(x=>{const p=validDate(x.paymentDate||x.payment_date||x.date);return p&&p>=today;});
  const chosen=future.length?future[future.length-1]:divRows[0];
  const past=divRows.filter(x=>validDate(x.paymentDate||x.payment_date||x.date)&&validDate(x.paymentDate||x.payment_date||x.date)<today);
  let frequency=null;
  if(past.length>=3){const dates=past.slice(0,8).map(x=>new Date(`${validDate(x.paymentDate||x.payment_date||x.date)}T12:00:00Z`).getTime()).filter(Number.isFinite);const gaps=dates.slice(1).map((t,i)=>(t-dates[i+1])/86400000).filter(x=>x>10&&x<400).sort((a,b)=>a-b);const median=gaps[Math.floor(gaps.length/2)];if(median)frequency=median<46?12:median<135?4:median<245?2:1;}
  let fx=null;
  const currency=String(quote?.currency||'').toUpperCase();
  if(currency==='CAD')fx={cadPerUnit:1};
  if(currency==='USD'){
    try{const fxData=first(await get('quote',{symbol:'USDCAD'}));const rate=num(fxData?.price);if(rate>0)fx={cadPerUnit:rate};else warnings.push('CAD conversion unavailable; enter rate manually.');}
    catch{warnings.push('CAD conversion unavailable; enter rate manually.');}
  }
  if(!quote&&!chosen)return {statusCode:502,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({error:'No quote or dividend data returned for this ticker',warnings})};
  return {statusCode:200,headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=300'},body:JSON.stringify({symbol,fetchedAt:new Date().toISOString(),source:'Financial Modeling Prep',quote:quote?{price:num(quote.price),currency:currency||null,name:quote.name||null}:null,dividend:chosen?{amount:num(chosen.dividend??chosen.adjDividend??chosen.amount),exDate:validDate(chosen.date||chosen.exDividendDate||chosen.exDate),paymentDate:validDate(chosen.paymentDate||chosen.payment_date),frequency}:null,fx,warnings})};
};
