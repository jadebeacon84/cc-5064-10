import { chromium } from 'playwright';
const url='http://127.0.0.1:8123/';
let browser;
try {
  browser = await chromium.launch({ args:['--no-sandbox'] });
} catch(e){ console.log('LAUNCH_FAIL:', e.message.split('\n').slice(0,6).join(' | ')); process.exit(2); }
const page = await browser.newPage({ viewport:{width:1600,height:1050} });
const errs=[];
page.on('pageerror', e=>errs.push('pageerror: '+e.message));
page.on('console', m=>{ if(m.type()==='error') errs.push('console: '+m.text()); });
await page.goto(url,{waitUntil:'networkidle'});
await page.waitForTimeout(2500);
await page.screenshot({ path:'/tmp/ui-wall.png', fullPage:false });
// hole scene
await page.getByText('小孔窥视').click();
await page.waitForTimeout(1200);
await page.screenshot({ path:'/tmp/ui-hole.png' });
// complex
await page.getByText('复杂包围形状').click();
await page.waitForTimeout(1200);
await page.screenshot({ path:'/tmp/ui-complex.png' });
console.log('errors:', errs.length? errs.join('\n'):'none');
await browser.close();
