// Testes estatísticos. Sem dependências: tudo implementado e coberto por test.mjs.

const erf = x => {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429*t - 1.453152027)*t + 1.421413741)*t - 0.284496736)*t + 0.254829592)*t*Math.exp(-x*x);
  return s * y;
};
export const normCdf = z => 0.5 * (1 + erf(z / Math.SQRT2));
export const pTwoSided = z => Math.max(1e-12, 2 * (1 - normCdf(Math.abs(z))));

function gammaln(x){
  const c=[76.18009172947146,-86.50532032941677,24.01409824083091,-1.231739572450155,
           0.1208650973866179e-2,-0.5395239384953e-5];
  let y=x, tmp=x+5.5; tmp-=(x+0.5)*Math.log(tmp);
  let ser=1.000000000190015;
  for(let j=0;j<6;j++) ser+=c[j]/++y;
  return -tmp+Math.log(2.5066282746310005*ser/x);
}
function gammaQ(a,x){
  if(x<0||a<=0) return 1;
  if(x < a+1){
    let ap=a, sum=1/a, del=sum;
    for(let n=0;n<300;n++){ ap++; del*=x/ap; sum+=del; if(Math.abs(del)<Math.abs(sum)*1e-12) break; }
    return 1 - sum*Math.exp(-x+a*Math.log(x)-gammaln(a));
  }
  let b=x+1-a, c=1e300, d=1/b, h=d;
  for(let i=1;i<300;i++){
    const an=-i*(i-a); b+=2; d=an*d+b; if(Math.abs(d)<1e-300) d=1e-300;
    c=b+an/c; if(Math.abs(c)<1e-300) c=1e-300;
    d=1/d; const del=d*c; h*=del;
    if(Math.abs(del-1)<1e-12) break;
  }
  return h*Math.exp(-x+a*Math.log(x)-gammaln(a));
}
export const chi2P = (chi2, df) => df<=0 ? 1 : gammaQ(df/2, chi2/2);

/** Intervalo de Wilson. É ele que decide se um sinal tem valor ou é sorte. */
export function wilson(k, n, z = 1.959964){
  if(!n) return [0,0];
  const p=k/n, d=1+z*z/n;
  const c=(p+z*z/(2*n))/d;
  const h=z/d*Math.sqrt(p*(1-p)/n + z*z/(4*n*n));
  return [Math.max(0,c-h), Math.min(1,c+h)];
}

export function runsTest(seq){
  const n=seq.length; if(n<20) return null;
  const n1=seq.filter(s=>s===seq[0]).length, n2=n-n1;
  if(n1<2||n2<2) return null;
  let R=1; for(let i=1;i<n;i++) if(seq[i]!==seq[i-1]) R++;
  const mu=2*n1*n2/n+1;
  const varR=2*n1*n2*(2*n1*n2-n)/(n*n*(n-1));
  if(varR<=0) return null;
  const z=(R-mu)/Math.sqrt(varR);
  return {R, mu, z, p:pTwoSided(z)};
}

export function entropy(counts){
  const tot=counts.reduce((a,b)=>a+b,0); if(!tot) return 0;
  const h = -counts.reduce((a,c)=> c>0 ? a+(c/tot)*Math.log2(c/tot) : a, 0);
  return h || 0;                       // evita -0 numa distribuição degenerada
}

/** χ² de independência na matriz de transição de 1ª ordem. */
export function markovTest(seq, alphabet=["M","E","V"]){
  const T={}; for(const a of alphabet){ T[a]={}; for(const b of alphabet) T[a][b]=0; }
  for(let i=1;i<seq.length;i++) if(T[seq[i-1]]) T[seq[i-1]][seq[i]]++;
  const rowSum={}, colSum={}; let grand=0;
  for(const a of alphabet){ rowSum[a]=alphabet.reduce((s,b)=>s+T[a][b],0); grand+=rowSum[a]; }
  for(const b of alphabet) colSum[b]=alphabet.reduce((s,a)=>s+T[a][b],0);
  if(grand<30) return {T, chi2:0, p:null, grand};
  let chi2=0;
  for(const a of alphabet) for(const b of alphabet){
    const E=rowSum[a]*colSum[b]/grand;
    if(E>0) chi2 += (T[a][b]-E)**2/E;
  }
  return {T, chi2, p:chi2P(chi2,(alphabet.length-1)**2), grand};
}

export function streaks(seq){
  const out=[]; let cur=null;
  for(const s of seq){ if(cur&&cur.s===s) cur.n++; else { if(cur) out.push(cur); cur={s,n:1}; } }
  if(cur) out.push(cur);
  return out;
}
