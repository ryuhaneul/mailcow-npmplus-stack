import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { WM_C as C } from '../../web/src/theme/contrast.js';
import { parseMailColor, effectiveMailBackground, brightenMailText, adjustMailContrast, restoreMailColors, DARK_SURFACE_THRESHOLD } from '../../web/src/theme/mail-contrast.js';
import { messageDocument } from '../../web/src/reader.js';

const dark=[24,26,30];
test('computed mail colors and WCAG contrast use the existing contrast functions',()=>{
  assert.deepEqual(parseMailColor('rgb(32, 33, 36)'),[32,33,36,1]);
  assert.deepEqual(parseMailColor('rgba(32, 33, 36, 0)'),[32,33,36,0]);
  assert.deepEqual(parseMailColor('#fff'),[255,255,255,1]);
  assert.equal(C.ratio([0,0,0],[255,255,255]),21);
});
test('background lookup finds the nearest opaque ancestor or the supplied surface',()=>{
  const dom=new JSDOM('<div style="background:#fff"><p><span style="background:transparent">text</span></p></div>');
  const span=dom.window.document.querySelector('span');
  assert.deepEqual(effectiveMailBackground(span,dark),[255,255,255]);
  span.parentElement.style.backgroundColor='#123456';
  assert.deepEqual(effectiveMailBackground(span,dark),[18,52,86]);
  span.parentElement.removeAttribute('style');span.closest('div').removeAttribute('style');
  assert.deepEqual(effectiveMailBackground(span,dark),dark);dom.window.close();
});
test('dark sender text is brightened to at least 7 while preserving hue and saturation',()=>{
  const before=[30,60,90],after=brightenMailText(before,dark);
  assert.ok(C.ratio(after,dark)>=7);assert.ok(C.lum(after)>C.lum(before));
  // Hue 210 degrees, HSL saturation 50%, within RGB rounding tolerance.
  const [r,g,b]=after.map(value=>value/255),max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
  assert.ok(Math.abs((r-g)/delta+4-3.5)<0.02);
  assert.ok(Math.abs(delta/(1-Math.abs(max+min-1))-.5)<.02);
});
test('translucent text retains opacity while its painted contrast is raised',()=>{
  const next=brightenMailText([32,33,36],dark,.8);
  assert.ok(C.ratio(next.map((value,index)=>value*.8+dark[index]*.2),dark)>=7);
});
test('already readable text, black text on white and light text on white stay unchanged',()=>{
  assert.ok(C.ratio([140,140,140],dark)>=4.5&&C.ratio([140,140,140],dark)<7);
  for(const [color,bg] of [[[245,245,245],dark],[[140,140,140],dark],[[32,33,36],[255,255,255]],[[230,230,230],[255,255,255]]])assert.equal(brightenMailText(color,bg),color);
});
test('just below the dark threshold reaches maximum brightness and just above stays unchanged',()=>{
  const below=[115,115,115],above=[121,121,121],color=[32,33,36];
  assert.ok(C.lum(below)<DARK_SURFACE_THRESHOLD);assert.ok(C.lum(above)>DARK_SURFACE_THRESHOLD);
  assert.deepEqual(brightenMailText(color,below),[255,255,255]);
  assert.equal(brightenMailText(color,above),color);
});
test('DOM adjustment handles links, preserves light descendants and leaves images and backgrounds intact',()=>{
  const dom=new JSDOM('<body style="background:#181a1e"><div style="color:#202124">dark text<table bgcolor="#fff" style="background:#fff"><tr><td>black on white</td></tr></table><a style="color:#202124!important" href="#">link</a><img src="example.png"></div></body>');
  const doc=dom.window.document,view=dom.window,table=doc.querySelector('table'),image=doc.querySelector('img');
  const tableBefore=table.outerHTML,imageBefore=image.outerHTML;
  assert.equal(adjustMailContrast(doc,dark),2);
  for(const selector of ['div','a'])assert.ok(C.ratio(parseMailColor(view.getComputedStyle(doc.querySelector(selector)).color).slice(0,3),dark)>=7);
  assert.deepEqual(parseMailColor(view.getComputedStyle(doc.querySelector('td')).color).slice(0,3),[32,33,36]);
  assert.equal(image.outerHTML,imageBefore);assert.equal(table.getAttribute('style'),'background:#fff');
  assert.equal(adjustMailContrast(doc,dark),2);
  assert.ok(tableBefore.includes('black on white'));dom.window.close();
});
test('unmodified mail returns zero adjustments and preserves inline styles',()=>{
  const dom=new JSDOM('<body style="background:#181a1e"><p style="color:#fff">readable</p></body>');
  const before=dom.window.document.body.innerHTML;
  assert.equal(adjustMailContrast(dom.window.document,dark),0);assert.equal(dom.window.document.body.innerHTML,before);dom.window.close();
});
test('original view uses a white light document without modifying message HTML or input style',()=>{
  const message={html:'<p style="color:#202124">original</p>'},style={mode:'dark',surface:'#111',ink:'#eee',original:true};
  const html=messageDocument(message,style);
  assert.ok(html.includes('color-scheme:light'));assert.ok(html.includes('background:#ffffff'));assert.ok(html.includes(message.html));assert.equal(style.mode,'dark');
});

test('unparsed Color 4 foregrounds do not throw or change source styles',()=>{
  for(const color of ['lab(40% 10 10)','oklch(40% .1 30)','color(srgb .2 .3 .4)']){
    assert.equal(parseMailColor(color),null);
    const dom=new JSDOM(`<body style="background:#181a1e"><p style="color:${color}">unchanged color</p></body>`);
    const doc=dom.window.document,before=doc.body.innerHTML;
    assert.equal(adjustMailContrast(doc,dark),0);assert.equal(doc.body.innerHTML,before);dom.window.close();
  }
});

test('unknown or non-solid backgrounds stop lookup and preserve text including descendants',()=>{
  for(const background of ['background:color(srgb 1 1 1)','background-image:linear-gradient(white,white)','background:rgba(255,255,255,.5)']){
    const dom=new JSDOM(`<body style="background:#181a1e"><div style="${background};color:#202124">direct<p>descendant</p></div></body>`);
    const doc=dom.window.document,before=doc.body.innerHTML;
    assert.equal(effectiveMailBackground(doc.querySelector('p'),dark),null);
    assert.equal(adjustMailContrast(doc,dark),0);assert.equal(doc.body.innerHTML,before);dom.window.close();
  }
});
test('restoring and recalculating preserve original inline color values and priorities',()=>{
  const dom=new JSDOM('<body style="background:#181a1e;color:#202124"><div>inherited<p style="color:#202124!important">important</p></div></body>');
  const doc=dom.window.document,div=doc.querySelector('div'),p=doc.querySelector('p');
  assert.equal(adjustMailContrast(doc,dark),2);
  restoreMailColors(doc);
  assert.equal(div.hasAttribute('style'),false);assert.equal(p.style.color,'rgb(32, 33, 36)');assert.equal(p.style.getPropertyPriority('color'),'important');
  assert.equal(adjustMailContrast(doc,dark),2);
  div.style.backgroundColor='#fff';
  assert.equal(adjustMailContrast(doc,dark),0);assert.equal(div.style.color,'');assert.equal(p.style.color,'rgb(32, 33, 36)');assert.equal(p.style.getPropertyPriority('color'),'important');
  dom.window.close();
});
